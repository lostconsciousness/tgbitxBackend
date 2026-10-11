import { NestFactory } from '@nestjs/core';
import {
  Chain,
  CustodyAccountRole,
  CustodyAccountStatus,
  LedgerAccountType,
  OrderStatus,
  PositionStatus,
  Prisma,
  ProviderOrderStatus,
  WithdrawalStatus,
} from '@prisma/client';
import { Address, getAddress, parseUnits } from 'viem';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { calculateAccountBalance } from '../src/modules/ledger/ledger.validator';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';
import { RPC_PROVIDER } from '../src/modules/rpc/rpc.module';
import { RpcProvider } from '../src/modules/rpc/rpc-provider.interface';

const CHAIN_ID = 42161;
const NETWORK_KEY = 'arbitrum';
const SOURCE_ROLES = [
  CustodyAccountRole.DEPOSIT_TREASURY,
  CustodyAccountRole.WITHDRAWAL_HOT,
] as const;
const PER_SOURCE_RESERVE = new Prisma.Decimal('40');
const GLOBAL_SURPLUS_RESERVE = new Prisma.Decimal('100');
const ACTIVE_WITHDRAWALS: WithdrawalStatus[] = [
  WithdrawalStatus.REQUESTED,
  WithdrawalStatus.RISK_CHECK,
  WithdrawalStatus.PENDING_APPROVAL,
  WithdrawalStatus.APPROVED,
  WithdrawalStatus.BROADCASTING,
  WithdrawalStatus.BROADCASTED,
];

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix}<value>`);
  return value;
}

function requestedMode(): 'dry-run' | 'apply' {
  const dryRun = process.argv.includes('--dry-run');
  const apply = process.argv.includes('--apply');
  if (dryRun === apply) throw new Error('Specify exactly one of --dry-run or --apply');
  return apply ? 'apply' : 'dry-run';
}

async function main() {
  const mode = requestedMode();
  const recipient = getAddress(argument('recipient'));
  const amount = new Prisma.Decimal(argument('amount'));
  const operationId = argument('operation-id');
  if (!amount.isInteger() || amount.lessThan(170) || amount.greaterThan(200)) {
    throw new Error('Amount must be an integer between 170 and 200 USDC');
  }
  if (!/^[a-z0-9-]{8,80}$/i.test(operationId)) {
    throw new Error('Operation id must contain only letters, numbers and hyphens');
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const custody = app.get(PrivyCustodyService);
    const rpc = app.get<RpcProvider>(RPC_PROVIDER);
    const [usdc, sources, openPositions, openOrders, providerOrders, activeWithdrawals] =
      await Promise.all([
        prisma.asset.findUniqueOrThrow({
          where: { symbol: 'USDC' },
          include: {
            tokenContracts: {
              where: { network: { chainKey: NETWORK_KEY }, address: { not: null } },
              include: { network: true },
            },
          },
        }),
        prisma.custodyAccount.findMany({
          where: {
            network: Chain.ARBITRUM,
            role: { in: [...SOURCE_ROLES] },
            status: CustodyAccountStatus.ACTIVE,
          },
          orderBy: { role: 'asc' },
        }),
        prisma.position.count({ where: { status: PositionStatus.OPEN } }),
        prisma.order.count({
          where: {
            status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED, OrderStatus.PROVIDER_PENDING] },
          },
        }),
        prisma.providerOrder.count({
          where: {
            status: {
              in: [
                ProviderOrderStatus.PENDING,
                ProviderOrderStatus.OPEN,
                ProviderOrderStatus.PARTIALLY_FILLED,
                ProviderOrderStatus.RECONCILIATION_REQUIRED,
              ],
            },
          },
        }),
        prisma.withdrawal.count({
          where: {
            status: { in: ACTIVE_WITHDRAWALS },
            tokenContract: { network: { mainnet: true } },
          },
        }),
      ]);
    if (openPositions || openOrders || providerOrders || activeWithdrawals) {
      throw new Error(
        `Refusing surplus withdrawal with active state: positions=${openPositions}, orders=${openOrders}, providerOrders=${providerOrders}, withdrawals=${activeWithdrawals}`,
      );
    }
    if (sources.length !== SOURCE_ROLES.length || sources.some((source) => !source.providerWalletRef)) {
      throw new Error('Both active Arbitrum custody sources with Privy wallet references are required');
    }
    const contract = usdc.tokenContracts[0];
    if (!contract?.address || contract.decimals !== 6) {
      throw new Error('Verified Arbitrum USDC contract with 6 decimals is required');
    }

    const sourceStates = await Promise.all(sources.map(async (source) => ({
      source,
      usdc: new Prisma.Decimal((await rpc.getBalance(
        source.address,
        contract.address!,
        NETWORK_KEY,
        contract.decimals,
      )).value),
      nativeWei: BigInt((await rpc.getBalance(source.address, undefined, NETWORK_KEY)).value),
    })));
    const perSource = amount.dividedBy(sourceStates.length);
    if (!perSource.isInteger()) throw new Error('Amount must split evenly across custody sources');
    for (const state of sourceStates) {
      if (state.usdc.minus(perSource).lessThan(PER_SOURCE_RESERVE)) {
        throw new Error(`${state.source.role} would fall below ${PER_SOURCE_RESERVE.toString()} USDC`);
      }
      if (state.nativeWei < 50_000_000_000_000n) {
        throw new Error(`${state.source.role} has less than 0.00005 ETH for Arbitrum gas`);
      }
    }

    const liabilityAccounts = await prisma.ledgerAccount.findMany({
      where: {
        assetId: usdc.id,
        type: {
          in: [
            LedgerAccountType.USER_SPOT,
            LedgerAccountType.USER_PERP_MARGIN,
            LedgerAccountType.PENDING_WITHDRAWAL,
          ],
        },
      },
      include: {
        entries: {
          where: { transaction: { status: 'POSTED' } },
          select: { assetId: true, direction: true, amount: true },
        },
      },
    });
    const liabilities = liabilityAccounts.reduce(
      (total, account) => total.plus(calculateAccountBalance(account.entries)),
      new Prisma.Decimal(0),
    );

    const contracts = await prisma.tokenContract.findMany({
      where: {
        assetId: usdc.id,
        address: { not: null },
        network: { mainnet: true, legacyChain: { not: null } },
      },
      include: { network: true },
    });
    let physicalCustodyUsdc = new Prisma.Decimal(0);
    for (const token of contracts) {
      const accounts = await prisma.custodyAccount.findMany({
        where: {
          network: token.network.legacyChain!,
          status: CustodyAccountStatus.ACTIVE,
        },
      });
      for (const account of accounts) {
        const balance = await rpc.getBalance(
          account.address,
          token.address!,
          token.network.chainKey,
          token.decimals,
        );
        physicalCustodyUsdc = physicalCustodyUsdc.plus(balance.value);
      }
    }
    const surplusAfter = physicalCustodyUsdc.minus(liabilities).minus(amount);
    if (surplusAfter.lessThan(GLOBAL_SURPLUS_RESERVE)) {
      throw new Error(
        `Global USDC surplus after withdrawal would be ${surplusAfter.toString()}, below ${GLOBAL_SURPLUS_RESERVE.toString()}`,
      );
    }
    const recipientBefore = new Prisma.Decimal((await rpc.getBalance(
      recipient,
      contract.address,
      NETWORK_KEY,
      contract.decimals,
    )).value);
    const report = {
      mode,
      operationId,
      network: NETWORK_KEY,
      recipient,
      amount: amount.toString(),
      split: sourceStates.map((state) => ({
        role: state.source.role,
        address: state.source.address,
        amount: perSource.toString(),
        usdcBefore: state.usdc.toString(),
        usdcAfter: state.usdc.minus(perSource).toString(),
        nativeWei: state.nativeWei.toString(),
      })),
      liabilities: liabilities.toString(),
      physicalCustodyUsdc: physicalCustodyUsdc.toString(),
      surplusAfter: surplusAfter.toString(),
      recipientBefore: recipientBefore.toString(),
    };
    console.log(JSON.stringify(report, null, 2));
    if (mode === 'dry-run') return;

    custody.assertSafeAuthorizationConfiguration(CHAIN_ID);
    const transfers = [];
    for (const state of sourceStates) {
      const entityId = `${operationId}:${state.source.role}`;
      const existing = await prisma.auditLog.findFirst({
        where: { action: 'PLATFORM_SURPLUS_WITHDRAWAL_BROADCAST', entityId },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        transfers.push({ role: state.source.role, skippedAsRecorded: true, auditLogId: existing.id });
        continue;
      }
      const referenceId = `platform-surplus:${operationId}:${state.source.role.toLowerCase()}`;
      const sent = await custody.sendErc20FromWallet({
        walletId: state.source.providerWalletRef!,
        tokenAddress: contract.address as Address,
        recipient,
        rawAmount: parseUnits(perSource.toFixed(0), contract.decimals),
        referenceId,
        chainId: CHAIN_ID,
      });
      const audit = await prisma.auditLog.create({
        data: {
          action: 'PLATFORM_SURPLUS_WITHDRAWAL_BROADCAST',
          entityType: 'CustodyAccount',
          entityId,
          reason: 'Owner-requested audited withdrawal of custody surplus',
          metadata: {
            operationId,
            network: NETWORK_KEY,
            role: state.source.role,
            source: state.source.address,
            recipient,
            asset: 'USDC',
            amount: perSource.toString(),
            txHash: sent.txHash,
            providerRequestId: sent.providerRequestId ?? null,
            liabilities: liabilities.toString(),
            physicalCustodyUsdcBefore: physicalCustodyUsdc.toString(),
            projectedSurplusAfter: surplusAfter.toString(),
          },
        },
      });
      transfers.push({ role: state.source.role, txHash: sent.txHash, auditLogId: audit.id });
    }
    console.log(JSON.stringify({ applied: true, transfers }, null, 2));
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Platform surplus withdrawal failed');
  process.exitCode = 1;
});
