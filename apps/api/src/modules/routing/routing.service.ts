import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionRoute, OrderSide, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OperationalSettingsService } from '../settings/operational-settings.service';
import { OrderBookSnapshot } from '../market-data/types/orderbook.types';

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
    side: OrderSide;
    book: OrderBookSnapshot;
    notional24h: Prisma.Decimal;
    referenceMark: Prisma.Decimal;
  }, client: PrismaService | Prisma.TransactionClient = this.prisma): Promise<ExecutionRoute> {
    if (
      !this.config.get<boolean>('BBOOK_ENABLED', false) ||
      (await this.settings.getBoolean('bbook:paused', 'BBOOK_PAUSED', false))
    ) {
      return ExecutionRoute.A_BOOK_HYPERLIQUID;
    }
    const risk = await client.riskConfig.findUnique({
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
    const minimumCapital = new Prisma.Decimal(
      this.config.get<string>('BBOOK_MIN_PLATFORM_CAPITAL_USDC', '500'),
    );
    const minimumInsurance = new Prisma.Decimal(
      this.config.get<string>('BBOOK_MIN_INSURANCE_CAPITAL_USDC', '100'),
    );
    if (capital.lessThan(minimumCapital) || insurance.lessThan(minimumInsurance)) {
      return ExecutionRoute.A_BOOK_HYPERLIQUID;
    }
    if (!this.isMarketEligible(input)) {
      return ExecutionRoute.A_BOOK_HYPERLIQUID;
    }
    const orderCap = Prisma.Decimal.min(
      risk.maxBbookOrderNotional,
      capital.mul(this.config.get<string>('BBOOK_MAX_ORDER_CAPITAL_PCT', '0.025')),
    );
    const marketCap = Prisma.Decimal.min(
      risk.maxMarketExposure,
      capital.mul(this.config.get<string>('BBOOK_MAX_MARKET_EXPOSURE_PCT', '0.10')),
    );
    const totalCap = Prisma.Decimal.min(
      risk.maxTotalExposure,
      capital.mul(this.config.get<string>('BBOOK_MAX_TOTAL_EXPOSURE_PCT', '0.25')),
    );
    const lossCap = Prisma.Decimal.min(
      risk.maxPlatformUnrealizedLoss,
      capital.mul(this.config.get<string>('BBOOK_MAX_UNREALIZED_LOSS_PCT', '0.10')),
    );
    if (input.notional.greaterThan(orderCap)) {
      return ExecutionRoute.A_BOOK_HYPERLIQUID;
    }

    const [marketExposure, allExposures] = await Promise.all([
      client.bBookExposure.findUnique({ where: { marketId: input.marketId } }),
      client.bBookExposure.findMany({ select: { netNotional: true } }),
    ]);
    const currentMarket = new Prisma.Decimal(marketExposure?.netNotional ?? 0);
    const signedDelta = input.side === OrderSide.BUY ? input.notional : input.notional.negated();
    const projectedMarket = currentMarket.plus(signedDelta).abs();
    const projectedTotal = allExposures
      .reduce(
        (total, exposure) =>
          total.plus(new Prisma.Decimal(exposure.netNotional).abs()),
        new Prisma.Decimal(0),
      )
      .minus(currentMarket.abs())
      .plus(projectedMarket);
    if (
      projectedMarket.greaterThan(marketCap) ||
      projectedTotal.greaterThan(totalCap) ||
      new Prisma.Decimal(marketExposure?.unrealizedPlatformPnl ?? 0)
        .negated()
        .greaterThan(lossCap)
    ) {
      return ExecutionRoute.A_BOOK_HYPERLIQUID;
    }
    return ExecutionRoute.B_BOOK_INTERNAL;
  }

  private isMarketEligible(input: {
    notional: Prisma.Decimal;
    platformMarkAgeMs: number;
    book: OrderBookSnapshot;
    notional24h: Prisma.Decimal;
    referenceMark: Prisma.Decimal;
  }): boolean {
    const bid = input.book.bids[0];
    const ask = input.book.asks[0];
    if (!bid || !ask || input.book.provider !== 'HYPERLIQUID') return false;
    const bidPrice = new Prisma.Decimal(bid.price);
    const askPrice = new Prisma.Decimal(ask.price);
    const mid = bidPrice.plus(askPrice).div(2);
    const spreadBps = askPrice.minus(bidPrice).div(mid).mul(10_000);
    if (spreadBps.greaterThan(this.config.get<number>('BBOOK_MAX_SPREAD_BPS', 50))) return false;
    if (input.notional24h.lessThan(this.config.get<string>('BBOOK_MIN_NOTIONAL_24H_USDC', '1000000'))) return false;
    if (!input.referenceMark.isZero()) {
      const deviationBps = mid.minus(input.referenceMark).abs().div(input.referenceMark).mul(10_000);
      if (deviationBps.greaterThan(this.config.get<number>('BBOOK_MAX_MARK_DEVIATION_BPS', 100))) return false;
    }
    const depthMultiplier = new Prisma.Decimal(this.config.get<string>('BBOOK_MIN_DEPTH_MULTIPLIER', '5'));
    const maxDistance = new Prisma.Decimal(this.config.get<number>('BBOOK_DEPTH_BPS', 30)).div(10_000);
    const bidDepth = input.book.bids.reduce((sum, level) => {
      const price = new Prisma.Decimal(level.price);
      return price.greaterThanOrEqualTo(bidPrice.mul(new Prisma.Decimal(1).minus(maxDistance)))
        ? sum.plus(price.mul(level.size)) : sum;
    }, new Prisma.Decimal(0));
    const askDepth = input.book.asks.reduce((sum, level) => {
      const price = new Prisma.Decimal(level.price);
      return price.lessThanOrEqualTo(askPrice.mul(new Prisma.Decimal(1).plus(maxDistance)))
        ? sum.plus(price.mul(level.size)) : sum;
    }, new Prisma.Decimal(0));
    const requiredDepth = input.notional.mul(depthMultiplier);
    return bidDepth.greaterThanOrEqualTo(requiredDepth) && askDepth.greaterThanOrEqualTo(requiredDepth);
  }
}
