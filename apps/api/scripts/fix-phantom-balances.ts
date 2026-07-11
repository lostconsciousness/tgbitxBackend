import { NestFactory } from '@nestjs/core';
import {
  DepositStatus,
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';

const DUPLICATE_USDT_DEPOSIT_ID = 'cmqvlxxpw000214bviy7swvlo';
const USDC_MAINNET_PHANTOM_AMOUNT = '4';
const USER_EMAIL = 'trader@example.com';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);
    const ledger = app.get(LedgerService);

    const user = await prisma.user.findFirst({ where: { email: USER_EMAIL } });
    if (!user) {
      throw new Error(`User ${USER_EMAIL} not found`);
    }

    const usdt = await prisma.asset.findUniqueOrThrow({ where: { symbol: 'USDT' } });
    const usdc = await prisma.asset.findUniqueOrThrow({ where: { symbol: 'USDC' } });

    const duplicateDeposit = await prisma.deposit.findUnique({
      where: { id: DUPLICATE_USDT_DEPOSIT_ID },
      include: { tokenContract: { include: { network: true } } },
    });
    if (!duplicateDeposit) {
      throw new Error(`Duplicate USDT deposit ${DUPLICATE_USDT_DEPOSIT_ID} not found`);
    }
    if (duplicateDeposit.userId !== user.id) {
      throw new Error('Duplicate USDT deposit belongs to another user');
    }
    if (duplicateDeposit.status !== DepositStatus.CREDITED) {
      throw new Error(
        `Duplicate USDT deposit status is ${duplicateDeposit.status}, expected CREDITED`,
      );
    }
    if (duplicateDeposit.logIndex !== 9_999_999) {
      throw new Error('Refusing to reverse deposit that is not a balance-reconcile entry');
    }

    const usdtBefore = await ledger.getUserMainnetSpotBalance({
      userId: user.id,
      assetId: usdt.id,
    });
    const usdcBefore = await ledger.getUserMainnetSpotBalance({
      userId: user.id,
      assetId: usdc.id,
    });

    console.log('Before:', {
      usdtMainnet: usdtBefore.toString(),
      usdcMainnet: usdcBefore.toString(),
      duplicateDeposit: {
        id: duplicateDeposit.id,
        amount: duplicateDeposit.amount.toString(),
        txHash: duplicateDeposit.txHash,
        logIndex: duplicateDeposit.logIndex,
      },
    });

    if (dryRun) {
      console.log('Dry run — no changes applied.');
      return;
    }

    await prisma.$transaction(async (tx) => {
      await ledger.postTransaction(
        {
          type: LedgerTransactionType.ADMIN_ADJUSTMENT,
          idempotencyKey: `admin-fix:duplicate-arb-usdt:${duplicateDeposit.id}`,
          referenceType: 'Deposit',
          referenceId: duplicateDeposit.id,
          description: 'Reverse duplicate Arbitrum USDT balance-reconcile credit',
          metadata: {
            reason: 'DUPLICATE_BALANCE_RECONCILE',
            depositId: duplicateDeposit.id,
            txHash: duplicateDeposit.txHash,
          },
          entries: [
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: user.id,
              assetId: usdt.id,
              direction: LedgerEntryDirection.DEBIT,
              amount: duplicateDeposit.amount,
            },
            {
              accountType: LedgerAccountType.PLATFORM_RISK,
              assetId: usdt.id,
              direction: LedgerEntryDirection.CREDIT,
              amount: duplicateDeposit.amount,
            },
          ],
        },
        tx,
      );

      await tx.deposit.update({
        where: { id: duplicateDeposit.id },
        data: { status: DepositStatus.DUPLICATE },
      });

      await ledger.postTransaction(
        {
          type: LedgerTransactionType.ADMIN_ADJUSTMENT,
          idempotencyKey: `admin-fix:testnet-usdc-mainnet-phantom:${user.id}`,
          referenceType: 'User',
          referenceId: user.id,
          description: 'Remove testnet USDC balance shown in mainnet overview',
          metadata: {
            reason: 'TESTNET_USDC_MAINNET_PHANTOM',
            userEmail: USER_EMAIL,
          },
          entries: [
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: user.id,
              assetId: usdc.id,
              direction: LedgerEntryDirection.DEBIT,
              amount: USDC_MAINNET_PHANTOM_AMOUNT,
            },
            {
              accountType: LedgerAccountType.PLATFORM_RISK,
              assetId: usdc.id,
              direction: LedgerEntryDirection.CREDIT,
              amount: USDC_MAINNET_PHANTOM_AMOUNT,
            },
          ],
        },
        tx,
      );
    });

    const usdtAfter = await ledger.getUserMainnetSpotBalance({
      userId: user.id,
      assetId: usdt.id,
    });
    const usdcAfter = await ledger.getUserMainnetSpotBalance({
      userId: user.id,
      assetId: usdc.id,
    });

    console.log('After:', {
      usdtMainnet: usdtAfter.toString(),
      usdcMainnet: usdcAfter.toString(),
    });
    console.log('Done.');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
