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
import { HyperliquidExecutionService } from '../src/modules/hyperliquid/hyperliquid-execution.service';

const MAX_CREATED_AT = new Date(Date.now() - 24 * 60 * 60 * 1_000);
const ALLOWED_FAILURES = [
  /order is not visible by cloid/i,
  /reduce-only size exceeds open position/i,
];

function requestedMode(): 'dry-run' | 'apply' {
  const dryRun = process.argv.includes('--dry-run');
  const apply = process.argv.includes('--apply');
  if (dryRun === apply) throw new Error('Specify exactly one of --dry-run or --apply');
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
    const hyperliquid = app.get(HyperliquidExecutionService);
    const providerState = await hyperliquid.getAccountState() as {
      assetPositions: Array<{ position: { coin: string; szi: string } }>;
    };
    const providerPositions = providerState.assetPositions.filter(
      ({ position }) => !new Prisma.Decimal(position.szi).isZero(),
    );
    if (providerPositions.length > 0) {
      throw new Error(`Refusing recovery while provider has ${providerPositions.length} open position(s)`);
    }

    const candidates = await prisma.providerOrder.findMany({
      where: {
        status: ProviderOrderStatus.RECONCILIATION_REQUIRED,
        createdAt: { lt: MAX_CREATED_AT },
      },
      include: {
        fills: true,
        order: {
          include: {
            user: { select: { email: true } },
            market: { select: { symbol: true, quoteAssetId: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    for (const candidate of candidates) {
      if (candidate.fills.length > 0 || !new Prisma.Decimal(candidate.order.filledSize).isZero()) {
        throw new Error(`Refusing recovery: provider order ${candidate.id} has fills`);
      }
      if (!ALLOWED_FAILURES.some((pattern) => pattern.test(candidate.failureReason ?? ''))) {
        throw new Error(`Refusing recovery: unexpected failure reason on provider order ${candidate.id}`);
      }
      const openPosition = await prisma.position.count({
        where: {
          userId: candidate.order.userId,
          marketId: candidate.order.marketId,
          status: PositionStatus.OPEN,
        },
      });
      if (openPosition > 0) {
        throw new Error(`Refusing recovery: order ${candidate.orderId} has an open internal position`);
      }
    }

    console.log(JSON.stringify({
      mode,
      providerPositions: providerPositions.length,
      candidates: candidates.map((candidate) => ({
        orderId: candidate.orderId,
        user: candidate.order.user.email,
        market: candidate.order.market.symbol,
        createdAt: candidate.createdAt,
        orderStatus: candidate.order.status,
        providerStatus: candidate.status,
        filledSize: candidate.order.filledSize.toString(),
        marginToRelease: candidate.order.marginReserved.toString(),
        failureReason: candidate.failureReason,
      })),
    }, null, 2));
    if (mode === 'dry-run') return;

    for (const candidate of candidates) {
      await prisma.$transaction(async (tx) => {
        const current = await tx.providerOrder.findUniqueOrThrow({
          where: { id: candidate.id },
          include: { fills: true, order: true },
        });
        if (
          current.status !== ProviderOrderStatus.RECONCILIATION_REQUIRED ||
          current.fills.length > 0 ||
          !new Prisma.Decimal(current.order.filledSize).isZero()
        ) {
          throw new Error(`Provider order ${candidate.id} changed during recovery`);
        }
        if (new Prisma.Decimal(current.order.marginReserved).greaterThan(0)) {
          await ledger.postTransaction({
            type: LedgerTransactionType.MARGIN_RELEASE,
            idempotencyKey: `provider-order-release:${current.orderId}`,
            referenceType: 'Order',
            referenceId: current.orderId,
            description: 'Release verified unfilled stale provider order margin',
            metadata: { reason: 'STALE_NO_FILL_NO_POSITION_PROVIDER_ORDER' },
            entries: [
              {
                accountType: LedgerAccountType.USER_PERP_MARGIN,
                userId: current.order.userId,
                assetId: candidate.order.market.quoteAssetId,
                direction: LedgerEntryDirection.DEBIT,
                amount: current.order.marginReserved,
              },
              {
                accountType: LedgerAccountType.USER_SPOT,
                userId: current.order.userId,
                assetId: candidate.order.market.quoteAssetId,
                direction: LedgerEntryDirection.CREDIT,
                amount: current.order.marginReserved,
              },
            ],
          }, tx);
        }
        const reason = 'Cancelled by audited stale provider-order recovery (no fill, no position)';
        await tx.providerOrder.update({
          where: { id: current.id },
          data: {
            status: ProviderOrderStatus.CANCELLED,
            nextSyncAt: null,
            reconciliationRequiredAt: null,
            lastSyncedAt: new Date(),
            failureReason: reason,
          },
        });
        await tx.order.update({
          where: { id: current.orderId },
          data: { status: OrderStatus.CANCELLED, rejectionReason: reason },
        });
        await tx.auditLog.create({
          data: {
            action: 'STALE_PROVIDER_ORDER_RECOVERED',
            entityType: 'Order',
            entityId: current.orderId,
            reason,
            metadata: {
              providerOrderId: current.id,
              marginReleased: current.order.marginReserved.toString(),
              originalFailureReason: candidate.failureReason,
            },
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }
    console.log(JSON.stringify({ applied: true, recoveredOrders: candidates.length }, null, 2));
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Stale provider-order recovery failed');
  process.exitCode = 1;
});
