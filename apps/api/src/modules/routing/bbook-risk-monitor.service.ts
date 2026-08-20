import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PositionSide, PositionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OperationalSettingsService } from '../settings/operational-settings.service';

@Injectable()
export class BbookRiskMonitorService {
  private readonly logger = new Logger(BbookRiskMonitorService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: OperationalSettingsService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async monitor(): Promise<void> {
    if (this.running || !this.config.get<boolean>('BBOOK_ENABLED', false)) return;
    this.running = true;
    try {
      const positions = await this.prisma.position.findMany({
        where: { route: 'B_BOOK_INTERNAL', status: PositionStatus.OPEN },
      });
      const markets = new Map<string, {
        long: Prisma.Decimal;
        short: Prisma.Decimal;
        platformPnl: Prisma.Decimal;
      }>();
      for (const position of positions) {
        const state = markets.get(position.marketId) ?? {
          long: new Prisma.Decimal(0),
          short: new Prisma.Decimal(0),
          platformPnl: new Prisma.Decimal(0),
        };
        const notional = new Prisma.Decimal(position.size).mul(position.markPrice);
        if (position.side === PositionSide.LONG) state.long = state.long.plus(notional);
        else state.short = state.short.plus(notional);
        state.platformPnl = state.platformPnl.minus(position.unrealizedPnl);
        markets.set(position.marketId, state);
      }
      await this.prisma.$transaction(
        [...markets.entries()].map(([marketId, state]) =>
          this.prisma.bBookExposure.upsert({
            where: { marketId },
            create: {
              marketId,
              longNotional: state.long,
              shortNotional: state.short,
              netNotional: state.long.minus(state.short),
              unrealizedPlatformPnl: state.platformPnl,
            },
            update: {
              longNotional: state.long,
              shortNotional: state.short,
              netNotional: state.long.minus(state.short),
              unrealizedPlatformPnl: state.platformPnl,
            },
          }),
        ),
      );
      const totalPlatformPnl = [...markets.values()].reduce(
        (sum, state) => sum.plus(state.platformPnl),
        new Prisma.Decimal(0),
      );
      const capital = new Prisma.Decimal(this.config.get<string>('PLATFORM_CAPITAL_USDC', '0'));
      const insurance = new Prisma.Decimal(this.config.get<string>('INSURANCE_CAPITAL_USDC', '0'));
      const minimumInsurance = new Prisma.Decimal(this.config.get<string>('BBOOK_MIN_INSURANCE_CAPITAL_USDC', '100'));
      const drawdownLimit = capital.mul(this.config.get<string>('BBOOK_AUTO_PAUSE_DRAWDOWN_PCT', '0.15'));
      if (
        capital.lessThan(this.config.get<string>('BBOOK_MIN_PLATFORM_CAPITAL_USDC', '500')) ||
        insurance.lessThan(minimumInsurance) ||
        totalPlatformPnl.negated().greaterThanOrEqualTo(drawdownLimit)
      ) {
        const alreadyPaused = await this.settings.getBoolean(
          'bbook:paused',
          'BBOOK_PAUSED',
          false,
        );
        if (!alreadyPaused) {
          await this.settings.setBoolean('bbook:paused', true);
          this.logger.warn('B-book automatically paused by capital/insurance/drawdown gate');
        }
      }
    } finally {
      this.running = false;
    }
  }
}
