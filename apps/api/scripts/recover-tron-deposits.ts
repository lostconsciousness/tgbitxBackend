import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import {
  Chain,
  DepositChannel,
  DepositStatus,
  DepositSweepStatus,
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
  Prisma,
  TokenStandard,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { DepositsService } from '../src/modules/deposits/deposits.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';

const RECOVERY = {
  email: 'a1009ae@icloud.com',
  txHash: '0cf37b32e349bc82abe7a28bb377337a305be0eef3dbc67c5109d486c65923c9',
  blockNumber: 84_550_318,
  usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  rawAmount: '100000000',
  amount: '100',
  expectedInternalTrx: new Prisma.Decimal('35.999999'),
  expectedDuplicateTrx: new Prisma.Decimal('0.000002'),
  expectedExternalTrx: new Prisma.Decimal('0.000006'),
} as const;

type TronTransfer = {
  transaction_id?: string;
  block_timestamp?: number;
  block_number?: number;
  from?: string;
  to?: string;
  value?: string;
  token_info?: { address?: string; decimals?: number; symbol?: string };
};

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const deposits = app.get(DepositsService);
    const ledger = app.get(LedgerService);
    const custody = app.get(PrivyCustodyService);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: RECOVERY.email } });
    const address = await prisma.userDepositAddress.findUniqueOrThrow({
      where: { userId_network: { userId: user.id, network: Chain.TRON } },
    });
    const usdt = await prisma.tokenContract.findFirstOrThrow({
      where: {
        standard: TokenStandard.TRC20,
        address: RECOVERY.usdtContract,
        network: { legacyChain: Chain.TRON, mainnet: true },
        asset: { symbol: 'USDT' },
      },
      include: { asset: true, network: true },
    });
    const trx = await prisma.tokenContract.findFirstOrThrow({
      where: {
        standard: TokenStandard.NATIVE,
        network: { legacyChain: Chain.TRON, mainnet: true },
        asset: { symbol: 'TRX' },
      },
      include: { asset: true },
    });

    const transfer = await verifyTransfer(address.address);
    const confirmations = Math.max(
      usdt.network.confirmations,
      (await currentTronBlock()) - RECOVERY.blockNumber + 1,
    );
    const existingUsdt = await prisma.deposit.findFirst({
      where: { network: Chain.TRON, txHash: RECOVERY.txHash },
    });

    const treasuryWalletId = process.env.PRIVY_TRON_WALLET_ID;
    if (!treasuryWalletId) throw new Error('PRIVY_TRON_WALLET_ID is required');
    const treasuryAddress = await custody.getWalletAddress(treasuryWalletId);
    const trxDeposits = await prisma.deposit.findMany({
      where: {
        network: Chain.TRON,
        depositAddressId: address.id,
        tokenContractId: trx.id,
      },
      orderBy: [{ txHash: 'asc' }, { createdAt: 'asc' }],
    });
    const internal = trxDeposits.filter(
      (deposit) => deposit.fromAddress?.toLowerCase() === treasuryAddress.toLowerCase(),
    );
    const duplicates = duplicateNativeDeposits(trxDeposits);
    const internalIds = new Set(internal.map((deposit) => deposit.id));
    const duplicateOnly = duplicates.filter((deposit) => !internalIds.has(deposit.id));
    const internalTotal = sum(internal.map((deposit) => deposit.amount));
    const duplicateTotal = sum(duplicateOnly.map((deposit) => deposit.amount));
    const retainedExternal = sum(
      trxDeposits
        .filter((deposit) => !internalIds.has(deposit.id) && !duplicates.some((row) => row.id === deposit.id))
        .map((deposit) => deposit.amount),
    );
    assertAmount('internal TRX', internalTotal, RECOVERY.expectedInternalTrx);
    assertAmount('duplicate TRX', duplicateTotal, RECOVERY.expectedDuplicateTrx);
    assertAmount('retained external TRX', retainedExternal, RECOVERY.expectedExternalTrx);

    const blockedSweeps = await prisma.depositSweep.findMany({
      where: {
        depositAddressId: address.id,
        assetId: trx.assetId,
        status: DepositSweepStatus.BLOCKED,
      },
      select: { id: true, amount: true },
    });

    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      userId: user.id,
      depositAddress: address.address,
      verifiedTransfer: {
        txHash: transfer.transaction_id,
        blockNumber: RECOVERY.blockNumber,
        amount: RECOVERY.amount,
        asset: 'USDT',
      },
      usdtDepositExists: Boolean(existingUsdt),
      trxCorrections: {
        internal: internalTotal.toString(),
        duplicate: duplicateTotal.toString(),
        retainedExternal: retainedExternal.toString(),
      },
      blockedSweepIds: blockedSweeps.map((sweep) => sweep.id),
    }, null, 2));
    if (!apply) return;

    await reclassifyDeposits({
      prisma,
      ledger,
      deposits: internal,
      targetStatus: DepositStatus.UNMATCHED,
      reason: 'INTERNAL_TRON_SWEEP_GAS_FUNDING',
    });
    await reclassifyDeposits({
      prisma,
      ledger,
      deposits: duplicateOnly,
      targetStatus: DepositStatus.DUPLICATE,
      reason: 'DUPLICATE_TRON_NATIVE_LOG_INDEX',
    });
    if (blockedSweeps.length > 0) {
      await prisma.depositSweep.updateMany({
        where: { id: { in: blockedSweeps.map((sweep) => sweep.id) } },
        data: {
          status: DepositSweepStatus.FAILED,
          failureReason: 'Closed by audited Tron recovery: internal gas and duplicate ledger entries reversed',
        },
      });
    }

    const credited = await deposits.recordDetectedDeposit({
      depositAddressId: address.id,
      userId: user.id,
      channel: DepositChannel.PERSONAL_ADDRESS,
      network: Chain.TRON,
      tokenContractId: usdt.id,
      assetId: usdt.assetId,
      fromAddress: transfer.from,
      toAddress: address.address,
      txHash: RECOVERY.txHash,
      logIndex: 0,
      blockNumber: RECOVERY.blockNumber,
      amount: RECOVERY.amount,
      rawAmount: RECOVERY.rawAmount,
      confirmations,
    });
    const balance = await ledger.getUserMainnetSpotBalance({ userId: user.id, assetId: usdt.assetId });
    console.log(JSON.stringify({
      applied: true,
      depositId: credited.id,
      depositStatus: credited.status,
      userUsdtBalance: balance.toString(),
      sweepWillBeCreatedByWorker: credited.status === DepositStatus.CREDITED,
    }, null, 2));
  } finally {
    await app.close();
  }
}

function duplicateNativeDeposits<T extends { id: string; txHash: string; logIndex: number | null }>(rows: T[]): T[] {
  const byHash = new Map<string, T[]>();
  for (const row of rows) byHash.set(row.txHash, [...(byHash.get(row.txHash) ?? []), row]);
  return [...byHash.values()].flatMap((group) => {
    if (group.length < 2) return [];
    const canonical = group.find((row) => row.logIndex === null) ?? group[0];
    return group.filter((row) => row.id !== canonical?.id);
  });
}

async function reclassifyDeposits(input: {
  prisma: PrismaService;
  ledger: LedgerService;
  deposits: Array<{
    id: string;
    userId: string | null;
    assetId: string;
    amount: Prisma.Decimal;
    txHash: string;
    status: DepositStatus;
    creditedLedgerTransactionId: string | null;
  }>;
  targetStatus: DepositStatus;
  reason: string;
}): Promise<void> {
  for (const candidate of input.deposits) {
    await input.prisma.$transaction(async (tx) => {
      const current = await tx.deposit.findUniqueOrThrow({ where: { id: candidate.id } });
      if (!current.userId || current.status === input.targetStatus) return;
      if (current.status === DepositStatus.CREDITED) {
        if (!current.creditedLedgerTransactionId) {
          throw new Error(`Credited deposit ${current.id} has no ledger transaction`);
        }
        await input.ledger.postTransaction({
          type: LedgerTransactionType.ADMIN_ADJUSTMENT,
          idempotencyKey: `tron-recovery:${input.reason}:${current.id}`,
          referenceType: 'Deposit',
          referenceId: current.id,
          description: `Reverse ${input.reason}`,
          metadata: { reason: input.reason, txHash: current.txHash },
          entries: [
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: current.userId,
              assetId: current.assetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: current.amount,
            },
            {
              accountType: LedgerAccountType.PENDING_DEPOSIT,
              assetId: current.assetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: current.amount,
            },
          ],
        }, tx);
      }
      await tx.deposit.update({
        where: { id: current.id },
        data: {
          userId: null,
          channel: DepositChannel.UNMATCHED,
          status: input.targetStatus,
          creditedAt: null,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

async function verifyTransfer(address: string): Promise<TronTransfer> {
  const base = (process.env.TRON_GRID_FALLBACK_URL || 'https://api.trongrid.io').replace(/\/$/, '');
  const apiKey = process.env.TRON_PRO_API_KEY;
  if (
    process.env.NODE_ENV === 'production' &&
    !apiKey &&
    !process.argv.includes('--allow-public-verification')
  ) {
    throw new Error(
      'TRON_PRO_API_KEY is required in production (or explicitly use --allow-public-verification for this read-only manifest check)',
    );
  }
  const url = new URL(`${base}/v1/accounts/${address}/transactions/trc20`);
  url.searchParams.set('only_confirmed', 'true');
  url.searchParams.set('only_to', 'true');
  url.searchParams.set('limit', '200');
  url.searchParams.set('contract_address', RECOVERY.usdtContract);
  const response = await fetch(url, { headers: apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {} });
  if (!response.ok) throw new Error(`TronGrid history failed: ${response.status}`);
  const payload = await response.json() as { data?: TronTransfer[] };
  const transfer = payload.data?.find((row) => row.transaction_id === RECOVERY.txHash);
  if (!transfer) throw new Error('Expected confirmed USDT transaction was not found');
  if (
    transfer.to !== address ||
    transfer.value !== RECOVERY.rawAmount ||
    transfer.token_info?.address !== RECOVERY.usdtContract
  ) {
    throw new Error('Tron recovery transaction does not match the immutable recovery manifest');
  }
  const receipt = await tronPost<{ blockNumber?: number; receipt?: { result?: string } }>(
    '/wallet/gettransactioninfobyid',
    { value: RECOVERY.txHash },
    apiKey,
    base,
  );
  if (receipt.blockNumber !== RECOVERY.blockNumber || receipt.receipt?.result !== 'SUCCESS') {
    throw new Error('Tron transaction block or receipt does not match the recovery manifest');
  }
  return transfer;
}

async function currentTronBlock(): Promise<number> {
  const base = (process.env.TRON_GRID_FALLBACK_URL || 'https://api.trongrid.io').replace(/\/$/, '');
  const block = await tronPost<{ block_header?: { raw_data?: { number?: number } } }>(
    '/wallet/getnowblock',
    {},
    process.env.TRON_PRO_API_KEY,
    base,
  );
  return block.block_header?.raw_data?.number ?? RECOVERY.blockNumber;
}

async function tronPost<T>(path: string, body: unknown, apiKey: string | undefined, base: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`TronGrid ${path} failed: ${response.status}`);
  return response.json() as Promise<T>;
}

function sum(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((total, value) => total.plus(value), new Prisma.Decimal(0));
}

function assertAmount(label: string, actual: Prisma.Decimal, expected: Prisma.Decimal): void {
  if (!actual.equals(expected)) {
    throw new Error(`${label} preflight mismatch: expected ${expected.toString()}, got ${actual.toString()}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
