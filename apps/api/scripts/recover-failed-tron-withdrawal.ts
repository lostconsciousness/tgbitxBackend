import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  Chain,
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionStatus,
  LedgerTransactionType,
  WithdrawalStatus,
} from '@prisma/client';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { LedgerModule } from '../src/modules/ledger/ledger.module';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';
import { TreasuryModule } from '../src/modules/treasury/treasury.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['apps/api/.env', '.env', '../../.env'],
      isGlobal: true,
    }),
    DatabaseModule,
    LedgerModule,
    TreasuryModule,
  ],
})
class RecoverFailedTronWithdrawalModule {}

const apply = process.argv.includes('--apply');
const withdrawalId = requiredArgument('--withdrawal-id');

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    RecoverFailedTronWithdrawalModule,
    { logger: ['error', 'warn'] },
  );
  try {
    const config = app.get(ConfigService);
    const prisma = app.get(PrismaService);
    const ledger = app.get(LedgerService);
    const custody = app.get(PrivyCustodyService);
    const withdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { asset: true, tokenContract: { include: { network: true } } },
    });
    if (!withdrawal || withdrawal.network !== Chain.TRON || !withdrawal.txHash) {
      throw new Error('A broadcasted Tron withdrawal with a transaction hash is required');
    }
    const recoverableStatuses: WithdrawalStatus[] = [
      WithdrawalStatus.CONFIRMED,
      WithdrawalStatus.BROADCASTED,
    ];
    if (!recoverableStatuses.includes(withdrawal.status)) {
      throw new Error(`Withdrawal status ${withdrawal.status} is not recoverable`);
    }

    const host = config.getOrThrow<string>('TRON_RPC_PRIMARY_URL').replace(/\/$/, '');
    const apiKey = config.get<string>('TRON_PRO_API_KEY', '').trim();
    const headers: Record<string, string> = {};
    if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;
    const [transaction, info, events, configuredAddress] = await Promise.all([
      tronPost<Record<string, any>>(host, '/wallet/gettransactionbyid', { value: withdrawal.txHash }, headers),
      tronPost<Record<string, any>>(host, '/wallet/gettransactioninfobyid', { value: withdrawal.txHash }, headers),
      fetch(`${host}/v1/transactions/${withdrawal.txHash}/events?only_confirmed=true`, { headers })
        .then(async (response) => {
          if (!response.ok) throw new Error(`TronGrid events request failed: ${response.status}`);
          return response.json() as Promise<{ data?: Array<Record<string, unknown>> }>;
        }),
      custody.getWalletAddress(config.getOrThrow<string>('PRIVY_TRON_WALLET_ID')),
    ]);
    const result = String(
      info.receipt?.result ?? info.result ?? transaction.ret?.[0]?.contractRet ?? '',
    ).trim().toUpperCase();
    if (!info.blockNumber || !result || result === 'SUCCESS') {
      throw new Error(`Refusing recovery: on-chain result is ${result || 'not confirmed'}`);
    }
    if ((events.data ?? []).some((event) => String(event.event_name) === 'Transfer')) {
      throw new Error('Refusing recovery: the failed transaction contains a Transfer event');
    }

    const settlementTransactions = await prisma.ledgerTransaction.findMany({
      where: {
        referenceType: 'Withdrawal',
        referenceId: withdrawal.id,
        idempotencyKey: { startsWith: `withdrawal-settle:${withdrawal.id}` },
      },
      select: { id: true, idempotencyKey: true, status: true },
    });
    const release = await prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `withdrawal-release:${withdrawal.id}` },
      select: { id: true, status: true },
    });
    const custodyAccount = await prisma.custodyAccount.findFirst({
      where: { role: 'WITHDRAWAL_HOT', network: Chain.TRON },
    });
    const report = {
      apply,
      withdrawalId: withdrawal.id,
      emailUserId: withdrawal.userId,
      asset: withdrawal.asset.symbol,
      amount: withdrawal.amount.toString(),
      feeAmount: withdrawal.feeAmount.toString(),
      txHash: withdrawal.txHash,
      onChainResult: result,
      transferEvents: (events.data ?? []).length,
      settlementTransactions,
      release,
      custodyAddressMatchesConfig:
        custodyAccount?.address.trim() === configuredAddress.trim(),
    };
    if (!apply) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.ledgerTransaction.updateMany({
        where: {
          id: { in: settlementTransactions.map((item) => item.id) },
          status: LedgerTransactionStatus.POSTED,
        },
        data: { status: LedgerTransactionStatus.VOIDED },
      });
      await ledger.postTransaction({
        type: LedgerTransactionType.WITHDRAWAL_RELEASE,
        idempotencyKey: `withdrawal-release:${withdrawal.id}`,
        referenceType: 'Withdrawal',
        referenceId: withdrawal.id,
        description: `Release failed ${withdrawal.asset.symbol} Tron withdrawal`,
        entries: [
          {
            accountType: LedgerAccountType.PENDING_WITHDRAWAL,
            assetId: withdrawal.assetId,
            direction: LedgerEntryDirection.DEBIT,
            amount: withdrawal.amount,
          },
          {
            accountType: LedgerAccountType.USER_SPOT,
            userId: withdrawal.userId,
            assetId: withdrawal.assetId,
            direction: LedgerEntryDirection.CREDIT,
            amount: withdrawal.amount.plus(withdrawal.feeAmount),
          },
          ...(withdrawal.feeAmount.greaterThan(0) ? [{
            accountType: LedgerAccountType.GAS_FEES,
            assetId: withdrawal.assetId,
            direction: LedgerEntryDirection.DEBIT,
            amount: withdrawal.feeAmount,
          }] : []),
        ],
      }, tx);
      await tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: WithdrawalStatus.FAILED,
          confirmedAt: null,
          lastBroadcastError: `Corrected confirmed Tron failure: ${result}`,
        },
      });
      if (custodyAccount && custodyAccount.address.trim() !== configuredAddress.trim()) {
        await tx.custodyAccount.update({
          where: { id: custodyAccount.id },
          data: {
            address: configuredAddress.trim(),
            providerWalletRef: config.getOrThrow<string>('PRIVY_TRON_WALLET_ID'),
          },
        });
      }
      await tx.auditLog.create({
        data: {
          action: 'TRON_WITHDRAWAL_FAILED_RECOVERED',
          entityType: 'Withdrawal',
          entityId: withdrawal.id,
          reason: result,
          metadata: {
            txHash: withdrawal.txHash,
            settlementTransactionsVoided: settlementTransactions.map((item) => item.idempotencyKey),
            userRefund: withdrawal.amount.plus(withdrawal.feeAmount).toString(),
          },
        },
      });
    });
    process.stdout.write(`${JSON.stringify({ ...report, recovered: true }, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

async function tronPost<T>(
  host: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${host}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`TRON API request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

function requiredArgument(name: string): string {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  const index = process.argv.indexOf(name);
  const value = inline?.slice(name.length + 1) ?? (index >= 0 ? process.argv[index + 1] : undefined);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
