import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  LedgerAccountType,
  PositionSide,
  PositionStatus,
  Prisma,
  ReconciliationStatus,
  ReconciliationType,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { assertBalancedLedgerEntries } from '../ledger/ledger.validator';
import { TreasuryService } from '../treasury/treasury.service';
import { HyperliquidExecutionService } from '../hyperliquid/hyperliquid-execution.service';
import { calculateAccountBalance } from '../ledger/ledger.validator';
import { OperationalSettingsService } from '../settings/operational-settings.service';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly treasury: TreasuryService,
    private readonly hyperliquid: HyperliquidExecutionService,
    private readonly settings: OperationalSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledLedgerBalanceCheck(): Promise<void> {
    try {
      await this.runLedgerBalanceCheck();
    } catch (error) {
      this.logger.error('Scheduled ledger reconciliation failed', error);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduledProviderPositionsCheck(): Promise<void> {
    try {
      await this.runProviderPositionsCheck();
    } catch (error) {
      this.logger.error('Scheduled provider position reconciliation failed', error);
    }
  }

  async runLedgerBalanceCheck() {
    const run = await this.prisma.reconciliationRun.create({
      data: {
        type: ReconciliationType.LEDGER_BALANCE,
        status: ReconciliationStatus.RUNNING,
      },
    });

    try {
      const transactions = await this.prisma.ledgerTransaction.findMany({
        where: { status: 'POSTED' },
        include: { entries: true },
        orderBy: { createdAt: 'asc' },
      });

      const failedTransactionIds: string[] = [];
      for (const transaction of transactions) {
        try {
          assertBalancedLedgerEntries(transaction.entries);
        } catch (_error) {
          failedTransactionIds.push(transaction.id);
        }
      }

      const status =
        failedTransactionIds.length === 0 ? ReconciliationStatus.PASSED : ReconciliationStatus.FAILED;

      return this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: {
          status,
          completedAt: new Date(),
          details: {
            checkedTransactions: transactions.length,
            failedTransactionIds,
          },
        },
      });
    } catch (error) {
      return this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: ReconciliationStatus.FAILED,
          completedAt: new Date(),
          details: {
            error: error instanceof Error ? error.message : 'Unknown reconciliation error',
          },
        },
      });
    }
  }

  async runTreasuryBalanceCheck() {
    return this.runCheck(ReconciliationType.TREASURY_BALANCE, async () => {
      const [snapshots, personalBalances] = await Promise.all([
        this.treasury.captureBalances(),
        this.treasury.capturePersonalDepositBalances(),
      ]);
      const latestByAccountAsset = new Map<string, Prisma.Decimal>();
      for (const snapshot of snapshots) {
        latestByAccountAsset.set(
          `${snapshot.custodyAccountId}:${snapshot.assetId}`,
          snapshot.balance,
        );
      }
      const physicalByAsset = new Map<string, Prisma.Decimal>();
      for (const [key, balance] of latestByAccountAsset) {
        const assetId = key.split(':')[1]!;
        physicalByAsset.set(
          assetId,
          new Prisma.Decimal(physicalByAsset.get(assetId) ?? 0).plus(balance),
        );
      }
      for (const balance of personalBalances) {
        physicalByAsset.set(
          balance.assetId,
          new Prisma.Decimal(physicalByAsset.get(balance.assetId) ?? 0).plus(
            balance.balance,
          ),
        );
      }
      const liabilityAccounts = await this.prisma.ledgerAccount.findMany({
        where: {
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
          },
        },
      });
      const liabilitiesByAsset = new Map<string, Prisma.Decimal>();
      for (const account of liabilityAccounts) {
        const balance = calculateAccountBalance(account.entries);
        liabilitiesByAsset.set(
          account.assetId,
          new Prisma.Decimal(liabilitiesByAsset.get(account.assetId) ?? 0).plus(
            balance,
          ),
        );
      }
      const deficits = [...liabilitiesByAsset.entries()]
        .map(([assetId, liabilities]) => {
          const physical = new Prisma.Decimal(physicalByAsset.get(assetId) ?? 0);
          return {
            assetId,
            physical: physical.toString(),
            liabilities: liabilities.toString(),
            deficit: Prisma.Decimal.max(0, liabilities.minus(physical)).toString(),
          };
        })
        .filter((item) => new Prisma.Decimal(item.deficit).greaterThan(0));
      return {
        passed: deficits.length === 0,
        details: {
          snapshots: snapshots.length,
          personalDepositBalances: personalBalances.length,
          deficits,
        },
      };
    });
  }

  async runProviderBalanceCheck() {
    return this.runCheck(ReconciliationType.PROVIDER_BALANCE, async () => {
      if (!this.hyperliquid.isExecutionEnabled()) {
        return {
          passed: true,
          details: { enabled: false, state: 'DISABLED' },
        };
      }
      const state = await this.hyperliquid.getAccountState();
      return {
        passed: true,
        details: {
          enabled: true,
          state: JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue,
        },
      };
    });
  }

  async runProviderOrdersCheck() {
    return this.runCheck(ReconciliationType.PROVIDER_ORDERS, async () => {
      const internalOrders = await this.prisma.providerOrder.findMany({
        where: { provider: 'HYPERLIQUID' },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      if (!this.hyperliquid.isExecutionEnabled()) {
        return {
          passed: internalOrders.length === 0,
          details: {
            enabled: false,
            internalProviderOrders: internalOrders.length,
            mismatches:
              internalOrders.length === 0
                ? []
                : [{ reason: 'Hyperliquid disabled while provider orders exist' }],
          },
        };
      }
      const providerOpenOrders = await this.hyperliquid.getOpenOrders();
      return {
        passed: true,
        details: {
          enabled: true,
          internalProviderOrders: internalOrders.length,
          providerOpenOrders: JSON.parse(JSON.stringify(providerOpenOrders)) as Prisma.InputJsonValue,
        },
      };
    });
  }

  async runProviderPositionsCheck() {
    return this.runCheck(ReconciliationType.PROVIDER_POSITIONS, async () => {
      const internalPositions = await this.prisma.position.findMany({
        where: { status: PositionStatus.OPEN, route: 'A_BOOK_HYPERLIQUID' },
        include: { market: true },
        orderBy: { openedAt: 'desc' },
        take: 500,
      });
      if (!this.hyperliquid.isExecutionEnabled()) {
        return {
          passed: internalPositions.length === 0,
          details: {
            enabled: false,
            internalAbookPositions: internalPositions.length,
            mismatches:
              internalPositions.length === 0
                ? []
                : [{ reason: 'Hyperliquid disabled while A-book positions exist' }],
          },
        };
      }
      const providerState = await this.hyperliquid.getAccountState();
      const internalBySymbol = new Map<string, Prisma.Decimal>();
      const precisionBySymbol = new Map<string, number>();
      for (const position of internalPositions) {
        const symbol = position.market.providerSymbol;
        if (!symbol) continue;
        const signedSize = position.side === PositionSide.LONG
          ? new Prisma.Decimal(position.size)
          : new Prisma.Decimal(position.size).negated();
        internalBySymbol.set(
          symbol,
          new Prisma.Decimal(internalBySymbol.get(symbol) ?? 0).plus(signedSize),
        );
        precisionBySymbol.set(symbol, position.market.sizePrecision);
      }
      const providerBySymbol = new Map<string, Prisma.Decimal>();
      const state = providerState as {
        assetPositions?: Array<{ position?: { coin?: string; szi?: string } }>;
      };
      for (const asset of state.assetPositions ?? []) {
        const symbol = asset.position?.coin;
        const size = asset.position?.szi;
        if (symbol && size !== undefined) {
          providerBySymbol.set(symbol, new Prisma.Decimal(size));
        }
      }
      const symbols = new Set([...internalBySymbol.keys(), ...providerBySymbol.keys()]);
      const mismatches = [...symbols].flatMap((symbol) => {
        const internalSize = new Prisma.Decimal(internalBySymbol.get(symbol) ?? 0);
        const providerSize = new Prisma.Decimal(providerBySymbol.get(symbol) ?? 0);
        const tolerance = new Prisma.Decimal(10).pow(
          -(precisionBySymbol.get(symbol) ?? 8),
        );
        return internalSize.minus(providerSize).abs().greaterThan(tolerance)
          ? [{ symbol, internalSize: internalSize.toString(), providerSize: providerSize.toString() }]
          : [];
      });
      return {
        passed: mismatches.length === 0,
        details: {
          enabled: true,
          checkedSymbols: symbols.size,
          mismatches,
        },
      };
    });
  }

  async runBbookExposureCheck() {
    return this.runCheck(ReconciliationType.BBOOK_EXPOSURE, async () => {
      const [positions, stored] = await Promise.all([
        this.prisma.position.findMany({
          where: { status: PositionStatus.OPEN, route: 'B_BOOK_INTERNAL' },
        }),
        this.prisma.bBookExposure.findMany(),
      ]);
      const calculated = new Map<
        string,
        { long: Prisma.Decimal; short: Prisma.Decimal }
      >();
      for (const position of positions) {
        const exposure = calculated.get(position.marketId) ?? {
          long: new Prisma.Decimal(0),
          short: new Prisma.Decimal(0),
        };
        const notional = new Prisma.Decimal(position.size).mul(position.markPrice);
        if (position.side === PositionSide.LONG) {
          exposure.long = exposure.long.plus(notional);
        } else {
          exposure.short = exposure.short.plus(notional);
        }
        calculated.set(position.marketId, exposure);
      }
      const mismatches = stored.flatMap((exposure) => {
        const expected = calculated.get(exposure.marketId) ?? {
          long: new Prisma.Decimal(0),
          short: new Prisma.Decimal(0),
        };
        return new Prisma.Decimal(exposure.longNotional).equals(expected.long) &&
          new Prisma.Decimal(exposure.shortNotional).equals(expected.short)
          ? []
          : [
              {
                marketId: exposure.marketId,
                storedLong: exposure.longNotional.toString(),
                calculatedLong: expected.long.toString(),
                storedShort: exposure.shortNotional.toString(),
                calculatedShort: expected.short.toString(),
              },
            ];
      });
      return {
        passed: mismatches.length === 0,
        details: { checkedMarkets: stored.length, mismatches },
      };
    });
  }

  listRuns(take = 50) {
    return this.prisma.reconciliationRun.findMany({
      take: Math.min(take, 100),
      orderBy: { startedAt: 'desc' },
    });
  }

  private async runCheck(
    type: ReconciliationType,
    check: () => Promise<{
      passed: boolean;
      details: Prisma.InputJsonObject;
    }>,
  ) {
    const run = await this.prisma.reconciliationRun.create({
      data: { type, status: ReconciliationStatus.RUNNING },
    });
    try {
      const result = await check();
      return this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: result.passed
            ? ReconciliationStatus.PASSED
            : ReconciliationStatus.FAILED,
          completedAt: new Date(),
          details: result.details,
        },
      });
    } catch (error) {
      return this.prisma.reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: ReconciliationStatus.FAILED,
          completedAt: new Date(),
          details: {
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        },
      });
    }
  }
}
