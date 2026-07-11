import { NestFactory } from '@nestjs/core';
import {
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
  WithdrawalStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { WithdrawalsService } from '../src/modules/withdrawals/withdrawals.service';

async function main() {
  const withdrawalId = process.argv[2] ?? 'cmqwpisnh0038ytrdr2u247uq';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const prisma = app.get(PrismaService);
    const ledger = app.get(LedgerService);
    const withdrawals = app.get(WithdrawalsService);

    const withdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { asset: true },
    });
    if (!withdrawal) {
      throw new Error(`Withdrawal ${withdrawalId} not found`);
    }
    if (withdrawal.status !== WithdrawalStatus.FAILED) {
      throw new Error(`Withdrawal status is ${withdrawal.status}, expected FAILED`);
    }

    console.log('Retrying withdrawal', {
      id: withdrawal.id,
      amount: withdrawal.amount.toString(),
      fee: withdrawal.feeAmount.toString(),
      to: withdrawal.toAddress,
      network: withdrawal.network,
    });

    await prisma.$transaction(async (tx) => {
      await ledger.postTransaction(
        {
          type: LedgerTransactionType.WITHDRAWAL_RESERVE,
          idempotencyKey: `withdrawal-retry-reserve:${withdrawal.id}`,
          referenceType: 'Withdrawal',
          referenceId: withdrawal.id,
          description: `Retry reserve ${withdrawal.asset.symbol} withdrawal`,
          entries: [
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: withdrawal.userId,
              assetId: withdrawal.assetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: withdrawal.amount.plus(withdrawal.feeAmount),
            },
            {
              accountType: LedgerAccountType.PENDING_WITHDRAWAL,
              assetId: withdrawal.assetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: withdrawal.amount,
            },
            ...(withdrawal.feeAmount.greaterThan(0)
              ? [
                  {
                    accountType: LedgerAccountType.GAS_FEES,
                    assetId: withdrawal.assetId,
                    direction: LedgerEntryDirection.CREDIT,
                    amount: withdrawal.feeAmount,
                  },
                ]
              : []),
          ],
        },
        tx,
      );
      await tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: WithdrawalStatus.APPROVED,
          lastBroadcastError: null,
          txHash: null,
          providerRequestId: null,
          broadcastedAt: null,
          confirmedAt: null,
          approvedAt: new Date(),
        },
      });
    });

    await withdrawals.processApprovedWithdrawals();

    const finalState = await prisma.withdrawal.findUnique({
      where: { id: withdrawal.id },
      select: {
        status: true,
        txHash: true,
        lastBroadcastError: true,
        broadcastAttempts: true,
      },
    });
    console.log('Final state:', finalState);
    if (finalState?.status !== WithdrawalStatus.BROADCASTED && finalState?.status !== WithdrawalStatus.CONFIRMED) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
