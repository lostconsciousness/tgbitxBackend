import { NestFactory } from '@nestjs/core';
import {
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
  OrderStatus,
  PositionStatus,
  Prisma,
  ProviderOrderStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { calculateAccountBalance } from '../src/modules/ledger/ledger.validator';

const RECOVERY_VERSION = 'v1';
const ACTIONABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.OPEN,
  OrderStatus.PARTIALLY_FILLED,
  OrderStatus.PROVIDER_PENDING,
];
const ACTIONABLE_PROVIDER_STATUSES: ProviderOrderStatus[] = [
  ProviderOrderStatus.PENDING,
  ProviderOrderStatus.OPEN,
  ProviderOrderStatus.PARTIALLY_FILLED,
  ProviderOrderStatus.RECONCILIATION_REQUIRED,
];

function requestedMode(): 'dry-run' | 'apply' {
  const dryRun = process.argv.includes('--dry-run');
  const apply = process.argv.includes('--apply');
  if (dryRun === apply) {
    throw new Error('Specify exactly one of --dry-run or --apply');
  }
  return apply ? 'apply' : 'dry-run';
}

async function main() {
  const mode = requestedMode();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const ledger = app.get(LedgerService);
    const accounts = await prisma.ledgerAccount.findMany({
      where: {
        type: LedgerAccountType.USER_PERP_MARGIN,
        userId: { not: null },
      },
      include: {
        user: { select: { email: true } },
        asset: { select: { symbol: true } },
        entries: {
          where: { transaction: { status: 'POSTED' } },
          select: { assetId: true, direction: true, amount: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const candidates = accounts
      .map((account) => ({
        account,
        balance: calculateAccountBalance(account.entries),
      }))
      .filter(({ balance }) => !balance.isZero());

    if (candidates.length === 0) {
      console.log(JSON.stringify({ mode, candidates: [], message: 'No stale margin balances' }, null, 2));
      return;
    }

    const userIds = [...new Set(candidates.map(({ account }) => account.userId!))];
    const [openPositions, openOrders, providerOrders] = await Promise.all([
      prisma.position.count({
        where: { userId: { in: userIds }, status: PositionStatus.OPEN },
      }),
      prisma.order.count({
        where: { userId: { in: userIds }, status: { in: ACTIONABLE_ORDER_STATUSES } },
      }),
      prisma.providerOrder.count({
        where: {
          status: { in: ACTIONABLE_PROVIDER_STATUSES },
          order: { userId: { in: userIds } },
        },
      }),
    ]);
    if (openPositions || openOrders || providerOrders) {
      throw new Error(
        `Refusing recovery with active trading state: positions=${openPositions}, orders=${openOrders}, providerOrders=${providerOrders}`,
      );
    }

    const preview = [];
    for (const { account, balance } of candidates) {
      const amount = balance.abs();
      const spotBalance = await ledger.getUserSpotBalance({
        userId: account.userId!,
        assetId: account.assetId,
      });
      if (balance.isNegative() && spotBalance.lessThan(amount)) {
        throw new Error(
          `Refusing recovery for ${account.user?.email ?? account.userId}: spot balance is below ${amount.toString()} ${account.asset.symbol}`,
        );
      }
      preview.push({
        accountId: account.id,
        user: account.user?.email ?? account.userId,
        asset: account.asset.symbol,
        marginBefore: balance.toString(),
        spotBefore: spotBalance.toString(),
        spotDelta: balance.toString(),
        marginAfter: '0',
      });
    }

    console.log(JSON.stringify({ mode, candidates: preview }, null, 2));
    if (mode === 'dry-run') return;

    for (const { account, balance } of candidates) {
      await prisma.$transaction(async (tx) => {
        const currentEntries = await tx.ledgerEntry.findMany({
          where: { accountId: account.id, transaction: { status: 'POSTED' } },
          select: { assetId: true, direction: true, amount: true },
        });
        const current = calculateAccountBalance(currentEntries);
        if (!current.equals(balance)) {
          throw new Error(`Margin balance changed during recovery for account ${account.id}`);
        }

        const amount = current.abs();
        await ledger.postTransaction({
          type: LedgerTransactionType.ADMIN_ADJUSTMENT,
          idempotencyKey: `reconcile-stale-perp-margin:${RECOVERY_VERSION}:${account.id}`,
          referenceType: 'LedgerAccount',
          referenceId: account.id,
          description: 'Reconcile stale perp margin after provider partial-fill release bug',
          metadata: {
            recoveryVersion: RECOVERY_VERSION,
            reason: 'STALE_PROVIDER_ORDER_MARGIN_RELEASE',
            marginBalanceBefore: current.toString(),
          },
          entries: current.isPositive()
            ? [
                {
                  accountType: LedgerAccountType.USER_PERP_MARGIN,
                  userId: account.userId!,
                  assetId: account.assetId,
                  direction: LedgerEntryDirection.DEBIT,
                  amount,
                },
                {
                  accountType: LedgerAccountType.USER_SPOT,
                  userId: account.userId!,
                  assetId: account.assetId,
                  direction: LedgerEntryDirection.CREDIT,
                  amount,
                },
              ]
            : [
                {
                  accountType: LedgerAccountType.USER_SPOT,
                  userId: account.userId!,
                  assetId: account.assetId,
                  direction: LedgerEntryDirection.DEBIT,
                  amount,
                },
                {
                  accountType: LedgerAccountType.USER_PERP_MARGIN,
                  userId: account.userId!,
                  assetId: account.assetId,
                  direction: LedgerEntryDirection.CREDIT,
                  amount,
                },
              ],
        }, tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }

    const remaining = await prisma.ledgerAccount.findMany({
      where: { id: { in: candidates.map(({ account }) => account.id) } },
      include: {
        entries: {
          where: { transaction: { status: 'POSTED' } },
          select: { assetId: true, direction: true, amount: true },
        },
      },
    });
    const nonZero = remaining.filter(
      (account) => !calculateAccountBalance(account.entries).isZero(),
    );
    if (nonZero.length > 0) {
      throw new Error(`Recovery verification failed for ${nonZero.length} margin account(s)`);
    }
    console.log(JSON.stringify({ applied: true, reconciledAccounts: candidates.length }, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Stale margin recovery failed');
  process.exitCode = 1;
});
