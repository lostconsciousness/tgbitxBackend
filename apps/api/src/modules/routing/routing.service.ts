import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionRoute, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OperationalSettingsService } from '../settings/operational-settings.service';

@Injectable()
export class RoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: OperationalSettingsService,
  ) {}

  async decide(input: {
    marketId: string;
    notional: Prisma.Decimal;
    platformMarkAgeMs: number;
  }): Promise<ExecutionRoute> {
    if (
      !this.config.get<boolean>('BBOOK_ENABLED', false) ||
      (await this.settings.getBoolean('bbook:paused', 'BBOOK_PAUSED', false))
    ) {
      return ExecutionRoute.A_BOOK_HYPERLIQUID;
    }
    const risk = await this.prisma.riskConfig.findUnique({
      where: { marketId: input.marketId },
    });
    if (!risk?.bbookEnabled || input.platformMarkAgeMs > risk.maxMarkAgeMs) {
      return ExecutionRoute.A_BOOK_HYPERLIQUID;
    }
    const capital = new Prisma.Decimal(
      this.config.get<string>('PLATFORM_CAPITAL_USDC', '0'),
    );
    const insurance = new Prisma.Decimal(
      this.config.get<string>('INSURANCE_CAPITAL_USDC', '0'),
    );
    if (capital.lessThanOrEqualTo(0) || insurance.lessThanOrEqualTo(0)) {
      return ExecutionRoute.A_BOOK_HYPERLIQUID;
    }
    if (input.notional.greaterThan(risk.maxBbookOrderNotional)) {
      return ExecutionRoute.A_BOOK_HYPERLIQUID;
    }

    const [marketExposure, allExposures] = await Promise.all([
      this.prisma.bBookExposure.findUnique({ where: { marketId: input.marketId } }),
      this.prisma.bBookExposure.findMany({ select: { netNotional: true } }),
    ]);
    const projectedMarket = new Prisma.Decimal(
      marketExposure?.netNotional.abs() ?? 0,
    ).plus(input.notional);
    const projectedTotal = allExposures
      .reduce(
        (total, exposure) =>
          total.plus(new Prisma.Decimal(exposure.netNotional).abs()),
        new Prisma.Decimal(0),
      )
      .plus(input.notional);
    if (
      projectedMarket.greaterThan(risk.maxMarketExposure) ||
      projectedTotal.greaterThan(risk.maxTotalExposure) ||
      new Prisma.Decimal(marketExposure?.unrealizedPlatformPnl ?? 0)
        .negated()
        .greaterThan(risk.maxPlatformUnrealizedLoss)
    ) {
      return ExecutionRoute.A_BOOK_HYPERLIQUID;
    }
    return ExecutionRoute.B_BOOK_INTERNAL;
  }
}
