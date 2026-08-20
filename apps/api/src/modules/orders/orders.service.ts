import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ExecutionRoute,
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
  MarketStatus,
  MarketType,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSide,
  PositionStatus,
  Prisma,
  ProviderOrderStatus,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { HyperliquidExecutionService } from '../hyperliquid/hyperliquid-execution.service';
import { LedgerPostingEntry, LedgerService } from '../ledger/ledger.service';
import { MarketDataService } from '../market-data/market-data.service';
import { MarketsService } from '../markets/markets.service';
import { RoutingService } from '../routing/routing.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OperationalSettingsService } from '../settings/operational-settings.service';
import { UserUpdatesService } from '../user-updates/user-updates.service';

export function calculateMaxAffordablePerpSize(input: {
  availableBalance: Prisma.Decimal;
  marginPrice: Prisma.Decimal;
  feePrice: Prisma.Decimal;
  leverage: number;
  takerFeeBps: number;
  sizePrecision: number;
  maxNotional: Prisma.Decimal;
}): Prisma.Decimal {
  if (
    input.availableBalance.lessThanOrEqualTo(0) ||
    input.marginPrice.lessThanOrEqualTo(0) ||
    input.feePrice.lessThanOrEqualTo(0) ||
    input.leverage <= 0
  ) {
    return new Prisma.Decimal(0);
  }
  const costPerUnit = input.marginPrice.div(input.leverage).plus(
    input.feePrice.mul(input.takerFeeBps).div(10_000),
  );
  const affordableSize = input.availableBalance.div(costPerUnit);
  const cappedSize = input.maxNotional.greaterThan(0)
    ? Prisma.Decimal.min(affordableSize, input.maxNotional.div(input.marginPrice))
    : affordableSize;
  return cappedSize.toDecimalPlaces(input.sizePrecision, Prisma.Decimal.ROUND_FLOOR);
}

export function isFeeOnlyBalanceShortfall(input: {
  availableBalance: Prisma.Decimal;
  margin: Prisma.Decimal;
  fee: Prisma.Decimal;
}): boolean {
  return input.margin.lessThanOrEqualTo(input.availableBalance) &&
    input.margin.plus(input.fee).greaterThan(input.availableBalance);
}

@Injectable()
export class OrdersService {
  private providerExecutionQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly markets: MarketsService,
    private readonly marketData: MarketDataService,
    private readonly routing: RoutingService,
    private readonly ledger: LedgerService,
    private readonly hyperliquid: HyperliquidExecutionService,
    private readonly settings: OperationalSettingsService,
    @Optional() private readonly userUpdates?: UserUpdatesService,
  ) {}

  listUserOrders(userId: string) {
    return this.prisma.order.findMany({
      where: { userId },
      include: { market: true, providerOrder: true, trades: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listUserOpenOrders(userId: string) {
    const orders = await this.prisma.order.findMany({
      where: {
        userId,
        status: {
          in: [
            OrderStatus.ROUTED,
            OrderStatus.OPEN,
            OrderStatus.PARTIALLY_FILLED,
            OrderStatus.PROVIDER_PENDING,
          ],
        },
      },
      select: {
        id: true,
        clientOrderId: true,
        side: true,
        type: true,
        status: true,
        route: true,
        size: true,
        filledSize: true,
        price: true,
        averageFillPrice: true,
        triggerPrice: true,
        leverage: true,
        reduceOnly: true,
        createdAt: true,
        updatedAt: true,
        market: { select: { id: true, symbol: true, type: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return orders.map((order) => ({
      ...order,
      size: order.size.toString(),
      filledSize: order.filledSize.toString(),
      price: order.price?.toString() ?? null,
      averageFillPrice: order.averageFillPrice?.toString() ?? null,
      triggerPrice: order.triggerPrice?.toString() ?? null,
    }));
  }

  async getExecutionReadiness() {
    const [tradingPaused, aBookReconciliationPaused, bbookPaused, exposures] = await Promise.all([
      this.settings.getBoolean('trading:paused', 'TRADING_PAUSED', false),
      this.settings.getBoolean('abook:reconciliation-paused', 'ABOOK_RECONCILIATION_PAUSED', false),
      this.settings.getBoolean('bbook:paused', 'BBOOK_PAUSED', false),
      this.prisma.bBookExposure.findMany({
        select: { netNotional: true, unrealizedPlatformPnl: true },
      }),
    ]);
    const providerReadiness = await this.hyperliquid.getReadiness();
    const aBookReasons = [...providerReadiness.reasons];
    if (aBookReconciliationPaused) {
      aBookReasons.push('PROVIDER_POSITION_MISMATCH');
    }
    if (providerReadiness.ready) {
      const marketDataChecks = await Promise.allSettled(
        ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'].map((symbol) =>
          this.marketData.getOrderBook(symbol),
        ),
      );
      if (marketDataChecks.some((result) =>
        result.status === 'rejected' || result.value.provider !== 'HYPERLIQUID'
      )) {
        aBookReasons.push('MARKET_DATA_UNAVAILABLE');
      }
    }
    const aBookReady = providerReadiness.ready && aBookReasons.length === 0;
    const platformCapital = new Prisma.Decimal(
      this.config.get<string>('PLATFORM_CAPITAL_USDC', '0'),
    );
    const insuranceCapital = new Prisma.Decimal(
      this.config.get<string>('INSURANCE_CAPITAL_USDC', '0'),
    );
    const minimumCapital = new Prisma.Decimal(
      this.config.get<string>('BBOOK_MIN_PLATFORM_CAPITAL_USDC', '500'),
    );
    const minimumInsurance = new Prisma.Decimal(
      this.config.get<string>('BBOOK_MIN_INSURANCE_CAPITAL_USDC', '100'),
    );
    const bBookReady = Boolean(
      this.config.get<boolean>('BBOOK_ENABLED', false) &&
      !bbookPaused &&
      platformCapital.greaterThanOrEqualTo(minimumCapital) &&
      insuranceCapital.greaterThanOrEqualTo(minimumInsurance)
    );
    const bBookReasons: string[] = [];
    if (!this.config.get<boolean>('BBOOK_ENABLED', false)) bBookReasons.push('BBOOK_DISABLED');
    if (bbookPaused) bBookReasons.push('BBOOK_PAUSED');
    if (platformCapital.lessThan(minimumCapital)) bBookReasons.push('PLATFORM_CAPITAL_INSUFFICIENT');
    if (insuranceCapital.lessThan(minimumInsurance)) bBookReasons.push('INSURANCE_CAPITAL_INSUFFICIENT');
    const totalNetExposure = exposures.reduce(
      (sum, exposure) => sum.plus(new Prisma.Decimal(exposure.netNotional).abs()),
      new Prisma.Decimal(0),
    );
    const unrealizedPlatformPnl = exposures.reduce(
      (sum, exposure) => sum.plus(exposure.unrealizedPlatformPnl),
      new Prisma.Decimal(0),
    );
    return {
      ready: !tradingPaused && (aBookReady || bBookReady),
      tradingPaused,
      spot: { ready: !tradingPaused },
      perp: {
        ready: !tradingPaused && (aBookReady || bBookReady),
        aBook: {
          ready: aBookReady,
          provider: 'HYPERLIQUID',
          reasons: aBookReasons,
          accountValue: providerReadiness.accountValue ?? null,
          withdrawable: providerReadiness.withdrawable ?? null,
          agentRegistered: providerReadiness.agentRegistered,
        },
        bBook: {
          ready: bBookReady,
          funded: platformCapital.greaterThanOrEqualTo(minimumCapital) &&
            insuranceCapital.greaterThanOrEqualTo(minimumInsurance),
          enabled: this.config.get<boolean>('BBOOK_ENABLED', false),
          paused: bbookPaused,
          capitalConfigured: platformCapital.greaterThan(0),
          insuranceConfigured: insuranceCapital.greaterThan(0),
          capital: platformCapital.toString(),
          insurance: insuranceCapital.toString(),
          minimumCapital: minimumCapital.toString(),
          minimumInsurance: minimumInsurance.toString(),
          availableRiskCapital: Prisma.Decimal.max(0, platformCapital.plus(unrealizedPlatformPnl)).toString(),
          totalNetExposure: totalNetExposure.toString(),
          unrealizedPlatformPnl: unrealizedPlatformPnl.toString(),
          reasons: bBookReasons,
        },
      },
    };
  }

  async createOrder(
    userId: string,
    dto: CreateOrderDto,
    settlement?: {
      liquidationEventId: string;
      liquidationFee: Prisma.Decimal;
      liquidationPlatformFee: Prisma.Decimal;
      liquidationInsuranceFee: Prisma.Decimal;
    },
  ) {
    if (await this.settings.getBoolean('trading:paused', 'TRADING_PAUSED', false)) {
      throw new ServiceUnavailableException('Trading is paused');
    }
    await this.assertUniqueClientOrderId(userId, dto.clientOrderId);
    const market = await this.markets.getBySymbol(dto.symbol);
    let size = new Prisma.Decimal(dto.size);
    if (!dto.useAvailableBalance && size.lessThan(market.minOrderSize)) {
      throw new BadRequestException('Order size is below market minimum');
    }
    if (
      dto.type === OrderType.LIMIT &&
      (!dto.price || new Prisma.Decimal(dto.price).lessThanOrEqualTo(0))
    ) {
      throw new BadRequestException('Limit price is required');
    }
    if (market.status !== MarketStatus.ACTIVE) {
      throw new BadRequestException('Market is not active');
    }
    if (market.type === MarketType.SPOT) {
      if (dto.useAvailableBalance) {
        throw new BadRequestException('Server-side MAX sizing is only available for PERP orders');
      }
      const spotOrder = await this.createSpotOrder(userId, dto, market, size);
      this.publishTradingUpdate(userId);
      return spotOrder;
    }
    if (market.type !== MarketType.PERP || market.status !== MarketStatus.ACTIVE) {
      throw new BadRequestException('Perpetual market is not active');
    }
    if (
      dto.useAvailableBalance &&
      (dto.reduceOnly || dto.type === OrderType.STOP_LOSS || dto.type === OrderType.TAKE_PROFIT)
    ) {
      throw new BadRequestException('Server-side MAX sizing is only available for opening PERP orders');
    }
    if (
      (dto.type === OrderType.STOP_LOSS || dto.type === OrderType.TAKE_PROFIT) &&
      !dto.triggerPrice
    ) {
      throw new BadRequestException('Trigger price is required');
    }

    const book = await this.marketData.getOrderBook(market.symbol);
    const bestBid = book.bids[0];
    const bestAsk = book.asks[0];
    if (!bestBid || !bestAsk) {
      throw new ServiceUnavailableException('Mark price is unavailable');
    }
    const mark = new Prisma.Decimal(bestBid.price).plus(bestAsk.price).div(2);
    const markAgeMs = Math.max(0, Date.now() - book.time);
    const risk = await this.getRiskConfig(market.id, market.symbol);
    if (markAgeMs > risk.maxMarkAgeMs) {
      throw new ServiceUnavailableException('Mark price is stale');
    }
    const leverage = dto.leverage ?? 1;
    const pilotMaxLeverage = this.config.get<number>('PERP_MAX_LEVERAGE', 10);
    const maxLeverage = Math.min(risk.maxLeverage, pilotMaxLeverage);
    if (leverage > maxLeverage) {
      throw new BadRequestException(`Maximum leverage is ${maxLeverage}x`);
    }

    const existingPosition = dto.reduceOnly
      ? await this.prisma.position.findFirst({
          where: { userId, marketId: market.id, status: PositionStatus.OPEN },
        })
      : null;
    if (dto.reduceOnly && dto.type === OrderType.MARKET && existingPosition) {
      const activeClose = await this.prisma.order.findFirst({
        where: {
          userId,
          marketId: market.id,
          reduceOnly: true,
          type: OrderType.MARKET,
          status: {
            in: [
              OrderStatus.ROUTED,
              OrderStatus.OPEN,
              OrderStatus.PARTIALLY_FILLED,
              OrderStatus.PROVIDER_PENDING,
            ],
          },
        },
        include: { market: true, providerOrder: true, trades: true },
        orderBy: { createdAt: 'desc' },
      });
      if (activeClose) {
        return activeClose;
      }
    }
    if (dto.type === OrderType.STOP_LOSS || dto.type === OrderType.TAKE_PROFIT) {
      return this.createPerpTriggerOrder(userId, dto, market, size, existingPosition, mark);
    }
    if (dto.reduceOnly && !existingPosition) {
      throw new BadRequestException('Reduce-only order requires an open position');
    }
    const minNotional = new Prisma.Decimal(
      this.config.get<string>('PERP_MIN_ORDER_NOTIONAL_USDC', '0'),
    );
    const maxNotional = new Prisma.Decimal(
      this.config.get<string>('PERP_MAX_ORDER_NOTIONAL_USDC', '100'),
    );
    const routingNotional = size.mul(mark);
    if (
      !dto.useAvailableBalance &&
      !dto.reduceOnly &&
      minNotional.greaterThan(0) &&
      routingNotional.lessThan(minNotional)
    ) {
      throw new BadRequestException({
        code: 'PERP_NOTIONAL_TOO_LOW',
        message: `Minimum perpetual order notional is ${minNotional.toString()} USDC`,
      });
    }
    if (!dto.useAvailableBalance && !dto.reduceOnly && routingNotional.greaterThan(maxNotional)) {
      throw new BadRequestException({
        code: 'PERP_NOTIONAL_TOO_HIGH',
        message: `Maximum perpetual order notional is ${maxNotional.toString()} USDC`,
      });
    }
    const ticker = await this.marketData.getTicker(market.symbol);
    let route =
      existingPosition?.route ??
      (await this.routing.decide({
        marketId: market.id,
        notional: routingNotional,
        platformMarkAgeMs: markAgeMs,
        side: dto.side,
        book,
        notional24h: new Prisma.Decimal(ticker.notional24h),
        referenceMark: new Prisma.Decimal(ticker.markPrice ?? mark),
      }));
    if (route === ExecutionRoute.A_BOOK_HYPERLIQUID) {
      const [readiness, reconciliationPaused] = await Promise.all([
        this.hyperliquid.getReadiness(),
        this.settings.getBoolean(
          'abook:reconciliation-paused',
          'ABOOK_RECONCILIATION_PAUSED',
          false,
        ),
      ]);
      const blockingReasons = dto.reduceOnly
        ? readiness.reasons.filter((reason) => reason !== 'COLLATERAL_INSUFFICIENT')
        : readiness.reasons;
      if (reconciliationPaused && !dto.reduceOnly) {
        blockingReasons.push('PROVIDER_POSITION_MISMATCH');
      }
      if (book.provider !== 'HYPERLIQUID') {
        blockingReasons.push('MARKET_DATA_NOT_HYPERLIQUID');
      }
      if (blockingReasons.length > 0) {
        const collateralOnly = blockingReasons.length === 1 &&
          blockingReasons[0] === 'COLLATERAL_INSUFFICIENT';
        throw new ServiceUnavailableException({
          code: collateralOnly
            ? 'HYPERLIQUID_COLLATERAL_INSUFFICIENT'
            : 'PERP_EXECUTION_UNAVAILABLE',
          message: collateralOnly
            ? 'Hyperliquid collateral is below the configured minimum'
            : 'Perpetual execution is unavailable',
          reasons: blockingReasons,
        });
      }
    }
    const feeConfig = await this.getFeeConfig(market.id);
    let executionPrice = route === ExecutionRoute.B_BOOK_INTERNAL
      ? this.calculateBookVwap(book, dto.side, size)
      : mark;
    if (!dto.reduceOnly) {
      const availableBalance = this.isMainnetBalanceMode()
        ? await this.ledger.getUserMainnetSpotBalance({
            userId,
            assetId: market.quoteAssetId,
          })
        : await this.ledger.getUserSpotBalance({
            userId,
            assetId: market.quoteAssetId,
          });
      const maxAffordableSize = calculateMaxAffordablePerpSize({
        availableBalance,
        marginPrice: mark,
        feePrice: executionPrice,
        leverage,
        takerFeeBps: feeConfig.takerFeeBps,
        sizePrecision: market.sizePrecision,
        maxNotional,
      });
      const requestedMargin = size.mul(mark).div(leverage);
      const requestedFee = size.mul(executionPrice).mul(feeConfig.takerFeeBps).div(10_000);
      const feeOnlyShortfall = isFeeOnlyBalanceShortfall({
        availableBalance,
        margin: requestedMargin,
        fee: requestedFee,
      });
      if (dto.useAvailableBalance) {
        size = maxAffordableSize;
      } else if (feeOnlyShortfall) {
        size = Prisma.Decimal.min(size, maxAffordableSize);
      }
      if (
        route === ExecutionRoute.B_BOOK_INTERNAL &&
        (dto.useAvailableBalance || feeOnlyShortfall) &&
        size.greaterThan(0)
      ) {
        executionPrice = this.calculateBookVwap(book, dto.side, size);
        size = Prisma.Decimal.min(size, calculateMaxAffordablePerpSize({
          availableBalance,
          marginPrice: mark,
          feePrice: executionPrice,
          leverage,
          takerFeeBps: feeConfig.takerFeeBps,
          sizePrecision: market.sizePrecision,
          maxNotional,
        }));
      }
    }
    if (size.lessThan(market.minOrderSize)) {
      throw new BadRequestException('Order size is below market minimum');
    }
    const notional = size.mul(mark);
    if (!dto.reduceOnly && minNotional.greaterThan(0) && notional.lessThan(minNotional)) {
      throw new BadRequestException({
        code: 'PERP_NOTIONAL_TOO_LOW',
        message: `Minimum perpetual order notional is ${minNotional.toString()} USDC`,
      });
    }
    if (!dto.reduceOnly && notional.greaterThan(maxNotional)) {
      throw new BadRequestException({
        code: 'PERP_NOTIONAL_TOO_HIGH',
        message: `Maximum perpetual order notional is ${maxNotional.toString()} USDC`,
      });
    }
    const executionNotional = size.mul(executionPrice);
    const margin = dto.reduceOnly ? new Prisma.Decimal(0) : notional.div(leverage);
    const fee = executionNotional
      .mul(feeConfig.takerFeeBps)
      .div(10_000);

    const order = await this.prisma.$transaction(async (tx) => {
      if (route === ExecutionRoute.B_BOOK_INTERNAL) {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(742662001)');
        route = await this.routing.decide({
          marketId: market.id,
          notional,
          platformMarkAgeMs: Math.max(0, Date.now() - book.time),
          side: dto.side,
          book,
          notional24h: new Prisma.Decimal(ticker.notional24h),
          referenceMark: new Prisma.Decimal(ticker.markPrice ?? mark),
        }, tx);
      }
      if (!dto.reduceOnly) {
        await this.ledger.assertSufficientUserSpotBalance({
          userId,
          assetId: market.quoteAssetId,
          amount: margin.plus(fee),
          mainnetOnly: this.isMainnetBalanceMode(),
        }, tx);
      }
      const created = await tx.order.create({
        data: {
          userId,
          marketId: market.id,
          clientOrderId: dto.clientOrderId,
          side: dto.side,
          type: dto.type,
          status: OrderStatus.ROUTED,
          route,
          size,
          price: dto.price ? new Prisma.Decimal(dto.price) : undefined,
          triggerPrice: dto.triggerPrice
            ? new Prisma.Decimal(dto.triggerPrice)
            : undefined,
          leverage,
          reduceOnly: dto.reduceOnly ?? false,
          marginReserved: margin,
          feeAmount: fee,
          liquidationEventId: settlement?.liquidationEventId,
        },
        include: { market: true },
      });
      if (margin.greaterThan(0)) {
        const ledgerTx = await this.ledger.postTransaction({
          type: LedgerTransactionType.MARGIN_RESERVE,
          idempotencyKey: `order-margin:${created.id}`,
          referenceType: 'Order',
          referenceId: created.id,
          description: `Reserve isolated margin for ${market.symbol}`,
          entries: [
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId,
              assetId: market.quoteAssetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: margin,
            },
            {
              accountType: LedgerAccountType.USER_PERP_MARGIN,
              userId,
              assetId: market.quoteAssetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: margin,
            },
          ],
        }, tx);
        await tx.order.update({
          where: { id: created.id },
          data: { marginLedgerTransactionId: ledgerTx.id },
        });
      }
      if (route === ExecutionRoute.B_BOOK_INTERNAL) {
        await this.applyFill(tx, {
          orderId: created.id,
          userId,
          marketId: market.id,
          quoteAssetId: market.quoteAssetId,
          side: dto.side,
          route,
          size,
          price: executionPrice,
          margin,
          leverage,
          fee,
          maintenanceRate: risk.maintenanceMarginRate,
          reduceOnly: dto.reduceOnly ?? false,
          settlement,
        });
      }
      return tx.order.findUniqueOrThrow({
        where: { id: created.id },
        include: { market: true, providerOrder: true, trades: true },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });

    if (order.route === ExecutionRoute.B_BOOK_INTERNAL) {
      this.publishTradingUpdate(userId);
      return order;
    }
    return this.placeAbookOrder(order.id, mark, settlement);
  }

  async cancelOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { market: true, providerOrder: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (
      order.status !== OrderStatus.OPEN &&
      order.status !== OrderStatus.PARTIALLY_FILLED &&
      order.status !== OrderStatus.PROVIDER_PENDING
    ) {
      throw new BadRequestException('Order cannot be cancelled');
    }
    if (order.providerOrder) {
      if (!order.market.providerSymbol) {
        throw new ServiceUnavailableException('PERP_EXECUTION_UNAVAILABLE');
      }
      try {
        await this.hyperliquid.cancelOrder({
          providerSymbol: order.market.providerSymbol,
          providerOrderId: order.providerOrder.providerOrderId ?? undefined,
          cloid: order.providerOrder.cloid as `0x${string}`,
        });
        await this.prisma.providerOrder.update({
          where: { id: order.providerOrder.id },
          data: {
            status: ProviderOrderStatus.PENDING,
            nextSyncAt: new Date(),
            failureReason: 'Cancellation requested; awaiting provider confirmation',
          },
        });
        await this.reconcileProviderOrder(order.id);
      } catch (error) {
        await this.scheduleProviderRetry(
          order.providerOrder,
          error instanceof Error ? error.message : 'Provider cancellation result is ambiguous',
        );
      }
      const result = await this.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { market: true, providerOrder: true, trades: true },
      });
      this.publishTradingUpdate(userId);
      return result;
    }
    const result = await this.prisma.$transaction(async (tx) => {
      if (order.market.type === MarketType.SPOT) {
        await this.releaseSpotReserve(tx, order);
      } else {
        await this.releaseMargin(tx, order);
      }
      if (order.providerOrder) {
        await tx.providerOrder.update({
          where: { id: order.providerOrder.id },
          data: { status: ProviderOrderStatus.CANCELLED },
        });
      }
      return tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLED },
        include: { market: true, providerOrder: true },
      });
    });
    this.publishTradingUpdate(userId);
    return result;
  }

  async matchOpenSpotOrders(limit = 50) {
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.OPEN,
        type: OrderType.LIMIT,
        market: {
          type: MarketType.SPOT,
          status: MarketStatus.ACTIVE,
        },
      },
      include: { market: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    const matched = [];

    for (const order of orders) {
      try {
        const book = await this.marketData.getOrderBook(order.market.symbol);
        this.assertSpotExecutionBook(book.provider);
        const bestBid = book.bids[0];
        const bestAsk = book.asks[0];
        if (!bestBid || !bestAsk || !order.price) {
          continue;
        }
        const executionPrice =
          order.side === OrderSide.BUY
            ? new Prisma.Decimal(bestAsk.price)
            : new Prisma.Decimal(bestBid.price);
        const crosses =
          order.side === OrderSide.BUY
            ? executionPrice.lessThanOrEqualTo(order.price)
            : executionPrice.greaterThanOrEqualTo(order.price);
        if (!crosses) {
          continue;
        }

        const filled = await this.fillOpenSpotLimitOrder(order.id, executionPrice);
        if (filled) {
          matched.push(filled);
          this.publishTradingUpdate(filled.userId);
        }
      } catch (_error) {
        continue;
      }
    }

    return matched;
  }

  async matchOpenPerpTriggerOrders(limit = 50) {
    const orders = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.OPEN,
        type: { in: [OrderType.STOP_LOSS, OrderType.TAKE_PROFIT] },
        market: {
          type: MarketType.PERP,
          status: MarketStatus.ACTIVE,
        },
      },
      include: { market: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    const matched = [];

    for (const order of orders) {
      try {
        const position = await this.prisma.position.findFirst({
          where: {
            userId: order.userId,
            marketId: order.marketId,
            route: order.route ?? undefined,
            status: PositionStatus.OPEN,
          },
        });
        if (!position) {
          await this.prisma.order.updateMany({
            where: { id: order.id, status: OrderStatus.OPEN },
            data: {
              status: OrderStatus.CANCELLED,
              rejectionReason: 'Open position not found',
            },
          });
          continue;
        }
        if (!order.triggerPrice) {
          continue;
        }

        const book = await this.marketData.getOrderBook(order.market.symbol);
        const bestBid = book.bids[0];
        const bestAsk = book.asks[0];
        if (!bestBid || !bestAsk || Date.now() - book.time > 2_000) {
          continue;
        }
        const mark = new Prisma.Decimal(bestBid.price).plus(bestAsk.price).div(2);
        if (!this.shouldTriggerPerpOrder(order.type, position.side, mark, order.triggerPrice)) {
          continue;
        }

        if (order.route === ExecutionRoute.A_BOOK_HYPERLIQUID) {
          const routed = await this.triggerOpenAbookOrder(order.id, mark);
          if (routed) {
            matched.push(routed);
          }
        } else {
          const filled = await this.fillOpenPerpTriggerOrder(order.id, mark);
          if (filled) {
            matched.push(filled);
          }
        }
      } catch (_error) {
        continue;
      }
    }

    return matched;
  }

  private async createPerpTriggerOrder(
    userId: string,
    dto: CreateOrderDto,
    market: Awaited<ReturnType<MarketsService['getBySymbol']>>,
    size: Prisma.Decimal,
    existingPosition: Prisma.PositionGetPayload<object> | null,
    mark: Prisma.Decimal,
  ) {
    if (!dto.reduceOnly) {
      throw new BadRequestException('Perp trigger orders must be reduce-only');
    }
    if (!dto.triggerPrice || new Prisma.Decimal(dto.triggerPrice).lessThanOrEqualTo(0)) {
      throw new BadRequestException('Trigger price is required');
    }
    if (!existingPosition) {
      throw new BadRequestException('Trigger order requires an open position');
    }
    const expectedSide =
      existingPosition.side === PositionSide.LONG ? OrderSide.SELL : OrderSide.BUY;
    if (dto.side !== expectedSide) {
      throw new BadRequestException('Trigger order side must close the open position');
    }
    if (size.greaterThan(existingPosition.size)) {
      throw new BadRequestException('Trigger order size exceeds open position');
    }
    if (
      existingPosition.route === ExecutionRoute.A_BOOK_HYPERLIQUID &&
      !size.equals(existingPosition.size)
    ) {
      throw new BadRequestException('A-book TP/SL must cover the full open position');
    }
    const triggerPrice = new Prisma.Decimal(dto.triggerPrice);
    if (!this.isTriggerPriceValid(dto.type, existingPosition.side, mark, triggerPrice)) {
      throw new BadRequestException('Trigger price is on the wrong side of the current mark price');
    }
    const fee = existingPosition.route === ExecutionRoute.A_BOOK_HYPERLIQUID
      ? size.mul(mark).mul((await this.getFeeConfig(market.id)).takerFeeBps).div(10_000)
      : new Prisma.Decimal(0);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          userId,
          marketId: market.id,
          clientOrderId: dto.clientOrderId,
          side: dto.side,
          type: dto.type,
          status: OrderStatus.OPEN,
          route: existingPosition.route,
          size,
          triggerPrice,
          leverage: dto.leverage ?? existingPosition.leverage,
          reduceOnly: true,
          marginReserved: 0,
          feeAmount: fee,
        },
      });

      return tx.order.findUniqueOrThrow({
        where: { id: created.id },
        include: { market: true, providerOrder: true, trades: true },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  private async triggerOpenAbookOrder(orderId: string, mark: Prisma.Decimal) {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: {
          id: orderId,
          status: OrderStatus.OPEN,
          route: ExecutionRoute.A_BOOK_HYPERLIQUID,
        },
        data: { status: OrderStatus.ROUTED },
      });
      if (result.count !== 1) {
        return false;
      }
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      await tx.order.updateMany({
        where: {
          id: { not: order.id },
          userId: order.userId,
          marketId: order.marketId,
          route: ExecutionRoute.A_BOOK_HYPERLIQUID,
          status: OrderStatus.OPEN,
          type: { in: [OrderType.STOP_LOSS, OrderType.TAKE_PROFIT] },
          reduceOnly: true,
        },
        data: {
          status: OrderStatus.CANCELLED,
          rejectionReason: 'OCO sibling triggered',
        },
      });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return claimed ? this.placeAbookOrder(orderId, mark) : null;
  }

  private async fillOpenPerpTriggerOrder(orderId: string, price: Prisma.Decimal) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.OPEN },
        data: { status: OrderStatus.ROUTED },
      });
      if (claimed.count !== 1) {
        return null;
      }

      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { market: true },
      });
      await tx.order.updateMany({
        where: {
          id: { not: order.id },
          userId: order.userId,
          marketId: order.marketId,
          route: ExecutionRoute.B_BOOK_INTERNAL,
          status: OrderStatus.OPEN,
          type: { in: [OrderType.STOP_LOSS, OrderType.TAKE_PROFIT] },
          reduceOnly: true,
        },
        data: {
          status: OrderStatus.CANCELLED,
          rejectionReason: 'OCO sibling triggered',
        },
      });
      if (
        order.market.type !== MarketType.PERP ||
        (order.type !== OrderType.STOP_LOSS && order.type !== OrderType.TAKE_PROFIT) ||
        !order.reduceOnly
      ) {
        throw new BadRequestException('Only open reduce-only perp trigger orders can be matched');
      }

      const position = await tx.position.findFirst({
        where: {
          userId: order.userId,
          marketId: order.marketId,
          route: ExecutionRoute.B_BOOK_INTERNAL,
          status: PositionStatus.OPEN,
        },
      });
      if (!position) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.CANCELLED,
            rejectionReason: 'Open B-book position not found',
          },
        });
        return null;
      }

      const expectedSide =
        position.side === PositionSide.LONG ? OrderSide.SELL : OrderSide.BUY;
      if (order.side !== expectedSide || order.size.greaterThan(position.size)) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.CANCELLED,
            rejectionReason: 'Trigger order no longer matches open position',
          },
        });
        return null;
      }

      const feeConfig = await this.getFeeConfig(order.marketId);
      const size = new Prisma.Decimal(order.size);
      const fee = size.mul(price).mul(feeConfig.takerFeeBps).div(10_000);
      await this.applyFill(tx, {
        orderId: order.id,
        userId: order.userId,
        marketId: order.marketId,
        quoteAssetId: order.market.quoteAssetId,
        side: order.side,
        route: ExecutionRoute.B_BOOK_INTERNAL,
        size,
        price,
        margin: new Prisma.Decimal(0),
        leverage: order.leverage,
        fee,
        maintenanceRate: new Prisma.Decimal(0),
        reduceOnly: true,
      });
      await tx.order.update({
        where: { id: order.id },
        data: { feeAmount: fee },
      });

      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { market: true, providerOrder: true, trades: true },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  private shouldTriggerPerpOrder(
    type: OrderType,
    positionSide: PositionSide,
    mark: Prisma.Decimal,
    triggerPrice: Prisma.Decimal,
  ) {
    if (positionSide === PositionSide.LONG) {
      return type === OrderType.STOP_LOSS
        ? mark.lessThanOrEqualTo(triggerPrice)
        : mark.greaterThanOrEqualTo(triggerPrice);
    }
    return type === OrderType.STOP_LOSS
      ? mark.greaterThanOrEqualTo(triggerPrice)
      : mark.lessThanOrEqualTo(triggerPrice);
  }

  private isTriggerPriceValid(
    type: OrderType,
    positionSide: PositionSide,
    mark: Prisma.Decimal,
    triggerPrice: Prisma.Decimal,
  ) {
    if (positionSide === PositionSide.LONG) {
      return type === OrderType.STOP_LOSS
        ? triggerPrice.lessThan(mark)
        : triggerPrice.greaterThan(mark);
    }
    return type === OrderType.STOP_LOSS
      ? triggerPrice.greaterThan(mark)
      : triggerPrice.lessThan(mark);
  }

  private async createSpotOrder(
    userId: string,
    dto: CreateOrderDto,
    market: Awaited<ReturnType<MarketsService['getBySymbol']>>,
    size: Prisma.Decimal,
  ) {
    if (dto.reduceOnly) {
      throw new BadRequestException('Reduce-only is not supported for spot orders');
    }
    if (dto.triggerPrice) {
      throw new BadRequestException('Trigger price is not supported for spot orders');
    }
    if (dto.type !== OrderType.MARKET && dto.type !== OrderType.LIMIT) {
      throw new BadRequestException('Spot orders support market and limit types only');
    }

    const feeConfig = await this.getFeeConfig(market.id);
    const limitPrice = dto.price ? new Prisma.Decimal(dto.price) : null;
    const book = await this.marketData.getOrderBook(market.symbol);
    this.assertSpotExecutionBook(book.provider);
    if (dto.type === OrderType.LIMIT) {
      return this.prisma.$transaction(async (tx) => {
        const notional = size.mul(limitPrice!);
        const fee = notional.mul(feeConfig.takerFeeBps).div(10_000);
        const reserveAssetId =
          dto.side === OrderSide.BUY ? market.quoteAssetId : market.baseAssetId;
        const reserveAmount =
          dto.side === OrderSide.BUY ? notional.plus(fee) : size;

        await this.ledger.assertSufficientUserSpotBalance({
          userId,
          assetId: reserveAssetId,
          amount: reserveAmount,
          mainnetOnly: this.isMainnetBalanceMode(),
        }, tx);

        const created = await tx.order.create({
          data: {
            userId,
            marketId: market.id,
            clientOrderId: dto.clientOrderId,
            side: dto.side,
            type: dto.type,
            status: OrderStatus.OPEN,
            route: ExecutionRoute.B_BOOK_INTERNAL,
            size,
            price: limitPrice,
            leverage: 1,
            reduceOnly: false,
            marginReserved: reserveAmount,
            feeAmount: fee,
          },
        });
        const ledgerTx = await this.reserveSpotOrder(tx, {
          orderId: created.id,
          userId,
          assetId: reserveAssetId,
          amount: reserveAmount,
        });
        await tx.order.update({
          where: { id: created.id },
          data: { marginLedgerTransactionId: ledgerTx.id },
        });

        return tx.order.findUniqueOrThrow({
          where: { id: created.id },
          include: { market: true, providerOrder: true, trades: true },
        });
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    }

    const bestBid = book.bids[0];
    const bestAsk = book.asks[0];
    const executionLevel = dto.side === OrderSide.BUY ? bestAsk : bestBid;
    if (!executionLevel) {
      throw new ServiceUnavailableException('Spot price is unavailable');
    }

    const price = new Prisma.Decimal(executionLevel.price);
    const notional = size.mul(price);
    const fee = notional.mul(feeConfig.takerFeeBps).div(10_000);

    return this.prisma.$transaction(async (tx) => {
      await this.ledger.assertSufficientUserSpotBalance({
        userId,
        assetId: dto.side === OrderSide.BUY ? market.quoteAssetId : market.baseAssetId,
        amount: dto.side === OrderSide.BUY ? notional.plus(fee) : size,
        mainnetOnly: this.isMainnetBalanceMode(),
      }, tx);

      const created = await tx.order.create({
        data: {
          userId,
          marketId: market.id,
          clientOrderId: dto.clientOrderId,
          side: dto.side,
          type: dto.type,
          status: OrderStatus.ROUTED,
          route: ExecutionRoute.B_BOOK_INTERNAL,
          size,
          leverage: 1,
          reduceOnly: false,
          marginReserved: 0,
          feeAmount: fee,
        },
      });

      await this.applySpotFill(tx, {
        orderId: created.id,
        userId,
        marketId: market.id,
        baseAssetId: market.baseAssetId,
        quoteAssetId: market.quoteAssetId,
        side: dto.side,
        size,
        price,
        notional,
        fee,
      });

      return tx.order.findUniqueOrThrow({
        where: { id: created.id },
        include: { market: true, providerOrder: true, trades: true },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  private async applySpotFill(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      userId: string;
      marketId: string;
      baseAssetId: string;
      quoteAssetId: string;
      side: OrderSide;
      size: Prisma.Decimal;
      price: Prisma.Decimal;
      notional: Prisma.Decimal;
      fee: Prisma.Decimal;
    },
  ) {
    const exchangeEntries: LedgerPostingEntry[] =
      input.side === OrderSide.BUY
        ? [
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: input.userId,
              assetId: input.quoteAssetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: input.notional,
            },
            {
              accountType: LedgerAccountType.PLATFORM_BBOOK,
              assetId: input.quoteAssetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: input.notional,
            },
            {
              accountType: LedgerAccountType.PLATFORM_BBOOK,
              assetId: input.baseAssetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: input.size,
            },
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: input.userId,
              assetId: input.baseAssetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: input.size,
            },
          ]
        : [
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: input.userId,
              assetId: input.baseAssetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: input.size,
            },
            {
              accountType: LedgerAccountType.PLATFORM_BBOOK,
              assetId: input.baseAssetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: input.size,
            },
            {
              accountType: LedgerAccountType.PLATFORM_BBOOK,
              assetId: input.quoteAssetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: input.notional,
            },
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: input.userId,
              assetId: input.quoteAssetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: input.notional,
            },
          ];

    await this.ledger.postTransaction({
      type: LedgerTransactionType.SPOT_TRADE,
      idempotencyKey: `spot-trade:${input.orderId}`,
      referenceType: 'Order',
      referenceId: input.orderId,
      description: 'Execute internal spot trade',
      entries: exchangeEntries,
    }, tx);

    if (input.fee.greaterThan(0)) {
      await this.ledger.postTransaction({
        type: LedgerTransactionType.TRADING_FEE,
        idempotencyKey: `spot-fee:${input.orderId}`,
        referenceType: 'Order',
        referenceId: input.orderId,
        entries: [
          {
            accountType: LedgerAccountType.USER_SPOT,
            userId: input.userId,
            assetId: input.quoteAssetId,
            direction: LedgerEntryDirection.DEBIT,
            amount: input.fee,
          },
          {
            accountType: LedgerAccountType.PLATFORM_FEES,
            assetId: input.quoteAssetId,
            direction: LedgerEntryDirection.CREDIT,
            amount: input.fee,
          },
        ],
      }, tx);
    }

    await tx.trade.create({
      data: {
        userId: input.userId,
        orderId: input.orderId,
        marketId: input.marketId,
        route: ExecutionRoute.B_BOOK_INTERNAL,
        side: input.side,
        price: input.price,
        size: input.size,
        notional: input.notional,
        feeAmount: input.fee,
        executedAt: new Date(),
      },
    });
    await tx.order.update({
      where: { id: input.orderId },
      data: {
        status: OrderStatus.FILLED,
        filledSize: input.size,
        averageFillPrice: input.price,
      },
    });
  }

  private reserveSpotOrder(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      userId: string;
      assetId: string;
      amount: Prisma.Decimal;
    },
  ) {
    return this.ledger.postTransaction({
      type: LedgerTransactionType.SPOT_RESERVE,
      idempotencyKey: `spot-reserve:${input.orderId}`,
      referenceType: 'Order',
      referenceId: input.orderId,
      description: 'Reserve spot limit order funds',
      entries: [
        {
          accountType: LedgerAccountType.USER_SPOT,
          userId: input.userId,
          assetId: input.assetId,
          direction: LedgerEntryDirection.DEBIT,
          amount: input.amount,
        },
        {
          accountType: LedgerAccountType.PROVIDER_CLEARING,
          assetId: input.assetId,
          direction: LedgerEntryDirection.CREDIT,
          amount: input.amount,
        },
      ],
    }, tx);
  }

  private async releaseSpotReserve(
    tx: Prisma.TransactionClient,
    order: {
      id: string;
      userId: string;
      side: OrderSide;
      marginReserved: Prisma.Decimal;
      market: {
        baseAssetId: string;
        quoteAssetId: string;
      };
    },
  ) {
    if (order.marginReserved.lessThanOrEqualTo(0)) {
      return;
    }
    const assetId =
      order.side === OrderSide.BUY
        ? order.market.quoteAssetId
        : order.market.baseAssetId;
    await this.ledger.postTransaction({
      type: LedgerTransactionType.SPOT_RELEASE,
      idempotencyKey: `spot-release:${order.id}`,
      referenceType: 'Order',
      referenceId: order.id,
      description: 'Release spot limit order reserve',
      entries: [
        {
          accountType: LedgerAccountType.PROVIDER_CLEARING,
          assetId,
          direction: LedgerEntryDirection.DEBIT,
          amount: order.marginReserved,
        },
        {
          accountType: LedgerAccountType.USER_SPOT,
          userId: order.userId,
          assetId,
          direction: LedgerEntryDirection.CREDIT,
          amount: order.marginReserved,
        },
      ],
    }, tx);
  }

  private async fillOpenSpotLimitOrder(orderId: string, price: Prisma.Decimal) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.OPEN },
        data: { status: OrderStatus.ROUTED },
      });
      if (claimed.count !== 1) {
        return null;
      }

      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { market: true },
      });
      if (order.market.type !== MarketType.SPOT || order.type !== OrderType.LIMIT) {
        throw new BadRequestException('Only open spot limit orders can be matched');
      }
      const size = new Prisma.Decimal(order.size);
      const notional = size.mul(price);
      const fee = notional.mul((await this.getFeeConfig(order.marketId)).takerFeeBps).div(10_000);

      await this.applyReservedSpotFill(tx, {
        orderId: order.id,
        userId: order.userId,
        marketId: order.marketId,
        baseAssetId: order.market.baseAssetId,
        quoteAssetId: order.market.quoteAssetId,
        side: order.side,
        size,
        price,
        notional,
        fee,
        reservedAmount: new Prisma.Decimal(order.marginReserved),
      });

      return tx.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { market: true, providerOrder: true, trades: true },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  private async applyReservedSpotFill(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      userId: string;
      marketId: string;
      baseAssetId: string;
      quoteAssetId: string;
      side: OrderSide;
      size: Prisma.Decimal;
      price: Prisma.Decimal;
      notional: Prisma.Decimal;
      fee: Prisma.Decimal;
      reservedAmount: Prisma.Decimal;
    },
  ) {
    if (
      input.side === OrderSide.BUY &&
      input.reservedAmount.lessThan(input.notional.plus(input.fee))
    ) {
      throw new BadRequestException('Reserved spot quote balance is insufficient');
    }

    const exchangeEntries: LedgerPostingEntry[] =
      input.side === OrderSide.BUY
        ? [
            {
              accountType: LedgerAccountType.PROVIDER_CLEARING,
              assetId: input.quoteAssetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: input.notional,
            },
            {
              accountType: LedgerAccountType.PLATFORM_BBOOK,
              assetId: input.quoteAssetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: input.notional,
            },
            {
              accountType: LedgerAccountType.PLATFORM_BBOOK,
              assetId: input.baseAssetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: input.size,
            },
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: input.userId,
              assetId: input.baseAssetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: input.size,
            },
          ]
        : [
            {
              accountType: LedgerAccountType.PROVIDER_CLEARING,
              assetId: input.baseAssetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: input.size,
            },
            {
              accountType: LedgerAccountType.PLATFORM_BBOOK,
              assetId: input.baseAssetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: input.size,
            },
            {
              accountType: LedgerAccountType.PLATFORM_BBOOK,
              assetId: input.quoteAssetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: input.notional,
            },
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: input.userId,
              assetId: input.quoteAssetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: input.notional,
            },
          ];

    await this.ledger.postTransaction({
      type: LedgerTransactionType.SPOT_TRADE,
      idempotencyKey: `spot-trade:${input.orderId}`,
      referenceType: 'Order',
      referenceId: input.orderId,
      description: 'Execute reserved internal spot limit order',
      entries: exchangeEntries,
    }, tx);

    if (input.fee.greaterThan(0)) {
      await this.ledger.postTransaction({
        type: LedgerTransactionType.TRADING_FEE,
        idempotencyKey: `spot-fee:${input.orderId}`,
        referenceType: 'Order',
        referenceId: input.orderId,
        entries:
          input.side === OrderSide.BUY
            ? [
                {
                  accountType: LedgerAccountType.PROVIDER_CLEARING,
                  assetId: input.quoteAssetId,
                  direction: LedgerEntryDirection.DEBIT,
                  amount: input.fee,
                },
                {
                  accountType: LedgerAccountType.PLATFORM_FEES,
                  assetId: input.quoteAssetId,
                  direction: LedgerEntryDirection.CREDIT,
                  amount: input.fee,
                },
              ]
            : [
                {
                  accountType: LedgerAccountType.USER_SPOT,
                  userId: input.userId,
                  assetId: input.quoteAssetId,
                  direction: LedgerEntryDirection.DEBIT,
                  amount: input.fee,
                },
                {
                  accountType: LedgerAccountType.PLATFORM_FEES,
                  assetId: input.quoteAssetId,
                  direction: LedgerEntryDirection.CREDIT,
                  amount: input.fee,
                },
              ],
      }, tx);
    }

    const unusedQuoteReserve =
      input.side === OrderSide.BUY
        ? input.reservedAmount.minus(input.notional).minus(input.fee)
        : new Prisma.Decimal(0);
    if (unusedQuoteReserve.greaterThan(0)) {
      await this.ledger.postTransaction({
        type: LedgerTransactionType.SPOT_RELEASE,
        idempotencyKey: `spot-release-unused:${input.orderId}`,
        referenceType: 'Order',
        referenceId: input.orderId,
        description: 'Release unused spot quote reserve',
        entries: [
          {
            accountType: LedgerAccountType.PROVIDER_CLEARING,
            assetId: input.quoteAssetId,
            direction: LedgerEntryDirection.DEBIT,
            amount: unusedQuoteReserve,
          },
          {
            accountType: LedgerAccountType.USER_SPOT,
            userId: input.userId,
            assetId: input.quoteAssetId,
            direction: LedgerEntryDirection.CREDIT,
            amount: unusedQuoteReserve,
          },
        ],
      }, tx);
    }

    await tx.trade.create({
      data: {
        userId: input.userId,
        orderId: input.orderId,
        marketId: input.marketId,
        route: ExecutionRoute.B_BOOK_INTERNAL,
        side: input.side,
        price: input.price,
        size: input.size,
        notional: input.notional,
        feeAmount: input.fee,
        executedAt: new Date(),
      },
    });
    await tx.order.update({
      where: { id: input.orderId },
      data: {
        status: OrderStatus.FILLED,
        filledSize: input.size,
        averageFillPrice: input.price,
        feeAmount: input.fee,
      },
    });
  }

  private async placeAbookOrder(
    orderId: string,
    mark: Prisma.Decimal,
    _settlement?: {
      liquidationEventId: string;
      liquidationFee: Prisma.Decimal;
      liquidationPlatformFee: Prisma.Decimal;
      liquidationInsuranceFee: Prisma.Decimal;
    },
  ) {
    return this.withProviderExecutionLock(() =>
      this.placeAbookOrderLocked(orderId, mark, _settlement),
    );
  }

  private async placeAbookOrderLocked(
    orderId: string,
    mark: Prisma.Decimal,
    _settlement?: {
      liquidationEventId: string;
      liquidationFee: Prisma.Decimal;
      liquidationPlatformFee: Prisma.Decimal;
      liquidationInsuranceFee: Prisma.Decimal;
    },
  ) {
    let order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { market: true },
    });
    if (!order.market.providerSymbol || !this.hyperliquid.isExecutionEnabled()) {
      await this.failAndRelease(order, 'Hyperliquid execution is disabled');
      throw new ServiceUnavailableException('Hyperliquid execution is disabled');
    }
    const providerSymbol = order.market.providerSymbol;
    const coverage = order.reduceOnly
      ? await this.applyExistingProviderHedgeCoverage(order, mark, _settlement)
      : { remaining: new Prisma.Decimal(order.size), providerPosition: new Prisma.Decimal(0) };
    if (coverage.remaining.isZero()) {
      this.publishTradingUpdate(order.userId);
      return this.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { market: true, providerOrder: true, trades: true },
      });
    }
    order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { market: true },
    });
    const cloid = this.makeCloid(order.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.providerOrder.create({
        data: {
          orderId: order.id,
          marketId: order.marketId,
          provider: 'HYPERLIQUID',
          cloid,
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.PROVIDER_PENDING },
      });
    });
    try {
      const executionPrice =
        order.price ??
        (order.side === OrderSide.BUY ? mark.mul('1.01') : mark.mul('0.99'));
      const result = await this.hyperliquid.placeOrder({
        providerSymbol,
        cloid,
        side: order.side,
        type:
          order.type === OrderType.STOP_LOSS || order.type === OrderType.TAKE_PROFIT
            ? OrderType.MARKET
            : order.type,
        size: coverage.remaining.toString(),
        price: executionPrice.toDecimalPlaces(order.market.pricePrecision).toString(),
        triggerPrice: order.triggerPrice?.toString(),
        // A customer close can increase the omnibus net position. Only mark the
        // provider order reduce-only when this residual actually reduces the
        // current Hyperliquid master position without crossing through zero.
        reduceOnly: order.reduceOnly && this.providerDeltaIsReduceOnly(
          coverage.providerPosition,
          order.side,
          coverage.remaining,
        ),
      });
      await this.prisma.providerOrder.update({
        where: { orderId: order.id },
        data: {
          providerOrderId: result.providerOrderId,
          // A provider acknowledgement is not enough to finalize the internal
          // order. Fills must first be fetched and posted idempotently.
          status: result.status === 'OPEN'
            ? ProviderOrderStatus.OPEN
            : ProviderOrderStatus.PENDING,
          rawResponse: this.toJson(result.raw),
          lastSyncedAt: new Date(),
          nextSyncAt: new Date(),
          failureReason: null,
        },
      });
      if (result.status === 'REJECTED') {
        const currentOrder = await this.prisma.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { market: true },
        });
        await this.finalizeProviderRejection(
          currentOrder,
          result.reason ?? 'Provider rejected order',
        );
        return this.prisma.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { market: true, providerOrder: true, trades: true },
        });
      }
      await this.reconcileProviderOrder(order.id);
      return this.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { market: true, providerOrder: true, trades: true },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Provider request failed';
      if (this.isTerminalProviderRejection(reason)) {
        const currentOrder = await this.prisma.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { market: true },
        });
        await this.finalizeProviderRejection(
          currentOrder,
          reason,
        );
        return this.prisma.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { market: true, providerOrder: true, trades: true },
        });
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.providerOrder.updateMany({
          where: { orderId: order.id },
          data: {
            status: ProviderOrderStatus.PENDING,
            failureReason: reason.slice(0, 500),
            nextSyncAt: new Date(Date.now() + 5_000),
            syncAttempts: { increment: 1 },
          },
        });
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.PROVIDER_PENDING },
        });
      });
      return this.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { market: true, providerOrder: true, trades: true },
      });
    }
  }

  private async withProviderExecutionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.providerExecutionQueue;
    let release!: () => void;
    this.providerExecutionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async applyExistingProviderHedgeCoverage(
    order: {
      id: string;
      userId: string;
      marketId: string;
      side: OrderSide;
      size: Prisma.Decimal;
      filledSize: Prisma.Decimal;
      feeAmount: Prisma.Decimal;
      leverage: number;
      reduceOnly: boolean;
      market: { providerSymbol: string | null; quoteAssetId: string };
    },
    price: Prisma.Decimal,
    settlement?: {
      liquidationEventId: string;
      liquidationFee: Prisma.Decimal;
      liquidationPlatformFee: Prisma.Decimal;
      liquidationInsuranceFee: Prisma.Decimal;
    },
  ): Promise<{ remaining: Prisma.Decimal; providerPosition: Prisma.Decimal }> {
    if (!order.market.providerSymbol) {
      return { remaining: new Prisma.Decimal(order.size), providerPosition: new Prisma.Decimal(0) };
    }
    let providerPosition = new Prisma.Decimal(0);
    try {
      const state = await this.hyperliquid.getAccountState() as {
        assetPositions?: Array<{ position?: { coin?: string; szi?: string } }>;
      };
      const providerAsset = state.assetPositions?.find(
        (asset) => asset.position?.coin === order.market.providerSymbol,
      );
      providerPosition = new Prisma.Decimal(providerAsset?.position?.szi ?? 0);
    } catch (_error) {
      return { remaining: new Prisma.Decimal(order.size), providerPosition };
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(742662002)');
      const currentOrder = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      const remaining = new Prisma.Decimal(currentOrder.size).minus(currentOrder.filledSize);
      if (!currentOrder.reduceOnly || remaining.lessThanOrEqualTo(0)) {
        return { remaining: Prisma.Decimal.max(0, remaining), providerPosition };
      }
      const positions = await tx.position.findMany({
        where: {
          marketId: currentOrder.marketId,
          route: ExecutionRoute.A_BOOK_HYPERLIQUID,
          status: PositionStatus.OPEN,
        },
        select: { side: true, size: true },
      });
      const internalPosition = positions.reduce(
        (sum, position) => sum.plus(
          position.side === PositionSide.LONG ? position.size : position.size.negated(),
        ),
        new Prisma.Decimal(0),
      );
      const signedRemaining = currentOrder.side === OrderSide.BUY
        ? remaining
        : remaining.negated();
      const currentGap = providerPosition.minus(internalPosition);
      const gapAfterFullInternalFill = currentGap.minus(signedRemaining);
      let covered = new Prisma.Decimal(0);
      if (gapAfterFullInternalFill.abs().lessThanOrEqualTo(currentGap.abs())) {
        covered = remaining;
      } else if (currentGap.mul(signedRemaining).greaterThan(0)) {
        covered = Prisma.Decimal.min(currentGap.abs(), remaining);
      }
      if (settlement && covered.lessThan(remaining)) {
        covered = new Prisma.Decimal(0);
      }
      if (covered.lessThanOrEqualTo(0)) {
        return { remaining, providerPosition };
      }
      const risk = await tx.riskConfig.findUniqueOrThrow({
        where: { marketId: currentOrder.marketId },
      });
      const ratio = covered.div(currentOrder.size);
      await this.applyFill(tx, {
        orderId: currentOrder.id,
        userId: currentOrder.userId,
        marketId: currentOrder.marketId,
        quoteAssetId: order.market.quoteAssetId,
        side: currentOrder.side,
        route: ExecutionRoute.A_BOOK_HYPERLIQUID,
        size: covered,
        price,
        margin: new Prisma.Decimal(0),
        leverage: currentOrder.leverage,
        fee: new Prisma.Decimal(currentOrder.feeAmount).mul(ratio),
        maintenanceRate: risk.maintenanceMarginRate,
        reduceOnly: true,
        providerFillId: `internal-net:${currentOrder.id}`,
        settlement: settlement ? {
          liquidationEventId: settlement.liquidationEventId,
          liquidationFee: settlement.liquidationFee.mul(ratio),
          liquidationPlatformFee: settlement.liquidationPlatformFee.mul(ratio),
          liquidationInsuranceFee: settlement.liquidationInsuranceFee.mul(ratio),
        } : undefined,
      });
      const signedCovered = currentOrder.side === OrderSide.BUY
        ? covered
        : covered.negated();
      const nextProviderResidual = providerPosition.minus(
        internalPosition.plus(signedCovered),
      );
      await tx.systemSetting.upsert({
        where: {
          key: `abook:provider-position-offset:${order.market.providerSymbol}`,
        },
        create: {
          key: `abook:provider-position-offset:${order.market.providerSymbol}`,
          value: nextProviderResidual.toString(),
        },
        update: { value: nextProviderResidual.toString() },
      });
      return { remaining: remaining.minus(covered), providerPosition };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private providerDeltaIsReduceOnly(
    providerPosition: Prisma.Decimal,
    side: OrderSide,
    size: Prisma.Decimal,
  ): boolean {
    const delta = side === OrderSide.BUY ? size : size.negated();
    return providerPosition.mul(delta).lessThan(0) && size.lessThanOrEqualTo(providerPosition.abs());
  }

  async reconcilePendingProviderOrders(limit = 20): Promise<number> {
    if (!this.hyperliquid.isExecutionEnabled()) {
      return 0;
    }
    const pending = await this.prisma.providerOrder.findMany({
      where: {
        provider: 'HYPERLIQUID',
        status: {
          in: [
            ProviderOrderStatus.PENDING,
            ProviderOrderStatus.OPEN,
            ProviderOrderStatus.PARTIALLY_FILLED,
            ProviderOrderStatus.RECONCILIATION_REQUIRED,
          ],
        },
        OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    for (const providerOrder of pending) {
      await this.reconcileProviderOrder(providerOrder.orderId).catch(() => undefined);
    }
    return pending.length;
  }

  async reconcileProviderOrder(orderId: string) {
    const providerOrder = await this.prisma.providerOrder.findUnique({
      where: { orderId },
      include: { order: { include: { market: true, liquidationEvent: true } } },
    });
    if (!providerOrder) {
      throw new NotFoundException('Provider order not found');
    }
    if (
      (providerOrder.status === ProviderOrderStatus.FILLED &&
        (providerOrder.order.status === OrderStatus.FILLED ||
          providerOrder.order.status === OrderStatus.CANCELLED)) ||
      providerOrder.status === ProviderOrderStatus.CANCELLED ||
      providerOrder.status === ProviderOrderStatus.FAILED
    ) {
      return providerOrder.order;
    }
    if (
      !providerOrder.providerOrderId &&
      providerOrder.failureReason &&
      this.isTerminalProviderRejection(providerOrder.failureReason)
    ) {
      await this.finalizeProviderRejection(
        providerOrder.order,
        providerOrder.failureReason,
      );
      return this.prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { market: true, providerOrder: true, trades: true },
      });
    }
    try {
      const [snapshot, fills] = await Promise.all([
        this.hyperliquid.getOrderSnapshot(providerOrder.cloid as `0x${string}`),
        this.hyperliquid.getOrderFills(providerOrder.cloid as `0x${string}`),
      ]);
      for (const fill of fills.sort((left, right) =>
        left.occurredAt.getTime() - right.occurredAt.getTime(),
      )) {
        await this.applyProviderFill(orderId, fill);
      }
      const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const fullyFilled = new Prisma.Decimal(order.filledSize).greaterThanOrEqualTo(order.size);
      const now = new Date();

      // Provider fills are authoritative. Hyperliquid can expose a fill before
      // the order-by-cloid snapshot catches up; do not leave a fully filled
      // internal order in PROVIDER_PENDING until a later polling cycle.
      if (fullyFilled) {
        await this.prisma.$transaction(async (tx) => {
          await tx.providerOrder.update({
            where: { id: providerOrder.id },
            data: {
              providerOrderId: snapshot.providerOrderId ?? providerOrder.providerOrderId,
              status: ProviderOrderStatus.FILLED,
              rawResponse: this.toJson(snapshot.raw),
              lastSyncedAt: now,
              nextSyncAt: null,
              syncAttempts: 0,
              failureReason: null,
              reconciliationRequiredAt: null,
            },
          });
          await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.FILLED } });
        });
      } else if (snapshot.status === 'UNKNOWN') {
        await this.scheduleProviderRetry(providerOrder, 'Hyperliquid order is not visible by cloid');
      } else if (snapshot.status === 'OPEN') {
        await this.prisma.$transaction(async (tx) => {
          await tx.providerOrder.update({
            where: { id: providerOrder.id },
            data: {
              providerOrderId: snapshot.providerOrderId,
              status: new Prisma.Decimal(order.filledSize).greaterThan(0)
                ? ProviderOrderStatus.PARTIALLY_FILLED
                : ProviderOrderStatus.OPEN,
              rawResponse: this.toJson(snapshot.raw),
              lastSyncedAt: now,
              nextSyncAt: new Date(now.getTime() + 5_000),
              syncAttempts: 0,
              failureReason: null,
            },
          });
          await tx.order.update({
            where: { id: orderId },
            data: {
              status: new Prisma.Decimal(order.filledSize).greaterThan(0)
                ? OrderStatus.PARTIALLY_FILLED
                : OrderStatus.OPEN,
            },
          });
        });
      } else if (snapshot.status === 'FILLED') {
        await this.releaseUnfilledProviderMargin(providerOrder.order);
        await this.prisma.$transaction(async (tx) => {
          await tx.providerOrder.update({
            where: { id: providerOrder.id },
            data: {
              providerOrderId: snapshot.providerOrderId,
              status: ProviderOrderStatus.FILLED,
              rawResponse: this.toJson(snapshot.raw),
              lastSyncedAt: now,
              nextSyncAt: null,
              syncAttempts: 0,
              failureReason: 'IOC remainder cancelled after terminal partial fill',
              reconciliationRequiredAt: null,
            },
          });
          await tx.order.update({
            where: { id: orderId },
            data: {
              status: OrderStatus.CANCELLED,
              rejectionReason: 'Partially filled; unfilled IOC remainder cancelled',
            },
          });
        });
      } else {
        await this.releaseUnfilledProviderMargin(providerOrder.order);
        await this.prisma.$transaction(async (tx) => {
          await tx.providerOrder.update({
            where: { id: providerOrder.id },
            data: {
              providerOrderId: snapshot.providerOrderId,
              status: snapshot.status === 'CANCELLED'
                ? ProviderOrderStatus.CANCELLED
                : ProviderOrderStatus.FAILED,
              rawResponse: this.toJson(snapshot.raw),
              lastSyncedAt: now,
              nextSyncAt: null,
              failureReason: snapshot.reason ?? null,
            },
          });
          await tx.order.update({
            where: { id: orderId },
            data: {
              status: snapshot.status === 'CANCELLED' ? OrderStatus.CANCELLED : OrderStatus.FAILED,
              rejectionReason: snapshot.reason ?? undefined,
            },
          });
        });
      }
      // applyProviderFill commits separately and publishes an immediate balance
      // update. Publish once more after the provider/order terminal state is
      // committed so clients never remain on a stale PROVIDER_PENDING label.
      this.publishTradingUpdate(providerOrder.order.userId);
      return this.prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { market: true, providerOrder: true, trades: true },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Provider reconciliation failed';
      if (await this.tryTerminalizeSupersededReduceOnlyOrder(providerOrder, reason)) {
        return this.prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          include: { market: true, providerOrder: true, trades: true },
        });
      }
      await this.scheduleProviderRetry(
        providerOrder,
        reason,
      );
      this.publishTradingUpdate(providerOrder.order.userId);
      throw error;
    }
  }

  private async tryTerminalizeSupersededReduceOnlyOrder(
    providerOrder: Prisma.ProviderOrderGetPayload<{
      include: { order: { include: { market: true; liquidationEvent: true } } };
    }>,
    reason: string,
  ): Promise<boolean> {
    const order = providerOrder.order;
    if (
      !order.reduceOnly ||
      !order.route ||
      !providerOrder.providerOrderId ||
      reason !== 'Reduce-only size exceeds open position'
    ) {
      return false;
    }
    const [openPosition, replacementTrade] = await Promise.all([
      this.prisma.position.findFirst({
        where: {
          userId: order.userId,
          marketId: order.marketId,
          route: order.route,
          status: PositionStatus.OPEN,
        },
        select: { id: true },
      }),
      this.prisma.trade.findFirst({
        where: {
          userId: order.userId,
          marketId: order.marketId,
          side: order.side,
          size: order.size,
          providerFillId: { startsWith: 'internal-net:' },
          order: {
            id: { not: order.id },
            reduceOnly: true,
            status: OrderStatus.FILLED,
            createdAt: { gt: order.createdAt },
          },
        },
        select: { orderId: true },
        orderBy: { executedAt: 'asc' },
      }),
    ]);
    if (openPosition || !replacementTrade) {
      return false;
    }
    const explanation =
      `Provider fill accounted by replacement close order ${replacementTrade.orderId}`;
    await this.prisma.$transaction(async (tx) => {
      await tx.providerOrder.update({
        where: { id: providerOrder.id },
        data: {
          status: ProviderOrderStatus.FILLED,
          lastSyncedAt: new Date(),
          nextSyncAt: null,
          syncAttempts: 0,
          failureReason: explanation,
          reconciliationRequiredAt: null,
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.CANCELLED,
          rejectionReason: explanation,
        },
      });
    });
    this.publishTradingUpdate(order.userId);
    return true;
  }

  private async applyProviderFill(
    orderId: string,
    fill: {
      providerFillId: string;
      providerOrderId: string;
      price: string;
      size: string;
      feeAmount: string;
      occurredAt: Date;
      raw: unknown;
    },
  ): Promise<void> {
    const updatedUserId = await this.prisma.$transaction(async (tx) => {
      if (await tx.providerFill.findUnique({ where: { providerFillId: fill.providerFillId } })) {
        return null;
      }
      const provider = await tx.providerOrder.findUniqueOrThrow({
        where: { orderId },
        include: { order: { include: { market: true, liquidationEvent: true } } },
      });
      const order = provider.order;
      const size = new Prisma.Decimal(fill.size);
      const remaining = new Prisma.Decimal(order.size).minus(order.filledSize);
      if (size.lessThanOrEqualTo(0) || size.greaterThan(remaining)) {
        throw new Error('Provider fill size exceeds remaining internal order size');
      }
      await tx.providerFill.create({
        data: {
          providerOrderId: provider.id,
          providerFillId: fill.providerFillId,
          price: new Prisma.Decimal(fill.price),
          size,
          feeAmount: new Prisma.Decimal(fill.feeAmount).abs(),
          occurredAt: fill.occurredAt,
          rawPayload: this.toJson(fill.raw),
        },
      });
      const risk = await tx.riskConfig.findUniqueOrThrow({ where: { marketId: order.marketId } });
      const ratio = size.div(order.size);
      const liquidation = order.liquidationEvent;
      await this.applyFill(tx, {
        orderId: order.id,
        userId: order.userId,
        marketId: order.marketId,
        quoteAssetId: order.market.quoteAssetId,
        side: order.side,
        route: ExecutionRoute.A_BOOK_HYPERLIQUID,
        size,
        price: new Prisma.Decimal(fill.price),
        margin: order.reduceOnly ? new Prisma.Decimal(0) : new Prisma.Decimal(order.marginReserved).mul(ratio),
        leverage: order.leverage,
        fee: new Prisma.Decimal(order.feeAmount).mul(ratio),
        maintenanceRate: risk.maintenanceMarginRate,
        reduceOnly: order.reduceOnly,
        providerFillId: fill.providerFillId,
        settlement: liquidation ? {
          liquidationEventId: liquidation.id,
          liquidationFee: new Prisma.Decimal(liquidation.liquidationFee).mul(ratio),
          liquidationPlatformFee: new Prisma.Decimal(liquidation.platformFee).mul(ratio),
          liquidationInsuranceFee: new Prisma.Decimal(liquidation.insuranceFee).mul(ratio),
        } : undefined,
      });
      return order.userId;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (updatedUserId) this.publishTradingUpdate(updatedUserId);
  }

  private publishTradingUpdate(userId: string): void {
    this.userUpdates?.publish(userId, ['balances', 'orders', 'positions', 'trades']);
  }

  private assertSpotExecutionBook(provider: string): void {
    if (
      this.config.get<string>('MARKET_DATA_PROVIDER', 'MOCK') === 'HYPERLIQUID' &&
      provider !== 'HYPERLIQUID'
    ) {
      throw new ServiceUnavailableException({
        code: 'SPOT_EXECUTION_UNAVAILABLE',
        message: 'Spot order book is not connected to a production provider',
      });
    }
  }

  private isTerminalProviderRejection(reason: string): boolean {
    return /insufficient margin|invalid order|order size|minimum.*(?:size|notional)|maximum.*(?:size|notional)|reduce.?only|would immediately trigger|price.*(?:invalid|out of bounds)|asset.*(?:invalid|unavailable)/i.test(
      reason,
    );
  }

  private async finalizeProviderRejection(
    order: {
      id: string;
      userId: string;
      size: Prisma.Decimal;
      filledSize: Prisma.Decimal;
      marginReserved: Prisma.Decimal;
      market: { quoteAssetId: string };
    },
    reason: string,
  ): Promise<void> {
    const safeReason = reason.slice(0, 500);
    await this.releaseUnfilledProviderMargin(order);
    const partiallyFilled = new Prisma.Decimal(order.filledSize).greaterThan(0);
    await this.prisma.$transaction(async (tx) => {
      await tx.providerOrder.updateMany({
        where: { orderId: order.id },
        data: {
          status: ProviderOrderStatus.FAILED,
          failureReason: safeReason,
          lastSyncedAt: new Date(),
          nextSyncAt: null,
          reconciliationRequiredAt: null,
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: partiallyFilled ? OrderStatus.CANCELLED : OrderStatus.FAILED,
          rejectionReason: partiallyFilled
            ? `Partially filled; provider remainder rejected: ${safeReason}`.slice(0, 500)
            : safeReason,
        },
      });
    });
    this.publishTradingUpdate(order.userId);
  }

  private async scheduleProviderRetry(
    providerOrder: { id: string; createdAt: Date; syncAttempts: number },
    reason: string,
  ): Promise<void> {
    const attempts = providerOrder.syncAttempts + 1;
    const maxAttempts = this.config.get<number>('PROVIDER_RECONCILIATION_MAX_ATTEMPTS', 20);
    const graceMs = this.config.get<number>('PROVIDER_RECONCILIATION_UNKNOWN_GRACE_MS', 300_000);
    const requiresManual = attempts >= maxAttempts &&
      Date.now() - providerOrder.createdAt.getTime() >= graceMs;
    const manualRecheckMs = this.config.get<number>(
      'PROVIDER_RECONCILIATION_MANUAL_RECHECK_MS',
      300_000,
    );
    await this.prisma.providerOrder.update({
      where: { id: providerOrder.id },
      data: {
        status: requiresManual
          ? ProviderOrderStatus.RECONCILIATION_REQUIRED
          : ProviderOrderStatus.PENDING,
        syncAttempts: attempts,
        lastSyncedAt: new Date(),
        nextSyncAt: new Date(
          Date.now() +
            (requiresManual
              ? manualRecheckMs
              : Math.min(60_000, 2_000 * 2 ** Math.min(attempts, 5))),
        ),
        failureReason: reason.slice(0, 500),
        reconciliationRequiredAt: requiresManual ? new Date() : undefined,
      },
    });
  }

  private async releaseUnfilledProviderMargin(order: {
    id: string;
    userId: string;
    size: Prisma.Decimal;
    filledSize: Prisma.Decimal;
    marginReserved: Prisma.Decimal;
    market: { quoteAssetId: string };
  }): Promise<void> {
    const remaining = Prisma.Decimal.max(0, new Prisma.Decimal(order.size).minus(order.filledSize));
    const unused = new Prisma.Decimal(order.marginReserved).mul(remaining).div(order.size);
    if (unused.lessThanOrEqualTo(0)) return;
    await this.prisma.$transaction(async (tx) => {
      await this.ledger.postTransaction({
        type: LedgerTransactionType.MARGIN_RELEASE,
        idempotencyKey: `provider-order-release:${order.id}`,
        referenceType: 'Order',
        referenceId: order.id,
        description: 'Release unfilled A-book margin',
        entries: [
          {
            accountType: LedgerAccountType.USER_PERP_MARGIN,
            userId: order.userId,
            assetId: order.market.quoteAssetId,
            direction: LedgerEntryDirection.DEBIT,
            amount: unused,
          },
          {
            accountType: LedgerAccountType.USER_SPOT,
            userId: order.userId,
            assetId: order.market.quoteAssetId,
            direction: LedgerEntryDirection.CREDIT,
            amount: unused,
          },
        ],
      }, tx);
    });
  }

  private async applyFill(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      userId: string;
      marketId: string;
      quoteAssetId: string;
      side: OrderSide;
      route: ExecutionRoute;
      size: Prisma.Decimal;
      price: Prisma.Decimal;
      margin: Prisma.Decimal;
      leverage: number;
      fee: Prisma.Decimal;
      maintenanceRate: Prisma.Decimal;
      reduceOnly: boolean;
      providerFillId?: string;
      settlement?: {
        liquidationEventId: string;
        liquidationFee: Prisma.Decimal;
        liquidationPlatformFee: Prisma.Decimal;
        liquidationInsuranceFee: Prisma.Decimal;
      };
    },
  ) {
    const notional = input.size.mul(input.price);
    let feeSettledWithClose = new Prisma.Decimal(0);
    if (input.reduceOnly) {
      await this.closePositionWithFill(tx, input, notional);
    } else {
      const side =
        input.side === OrderSide.BUY ? PositionSide.LONG : PositionSide.SHORT;
      const existing = await tx.position.findFirst({
        where: {
          userId: input.userId,
          marketId: input.marketId,
          route: input.route,
          status: PositionStatus.OPEN,
        },
      });
      if (existing && existing.side !== side) {
        const closeSize = Prisma.Decimal.min(input.size, existing.size);
        const closeRatio = closeSize.div(input.size);
        const closeFee = input.fee.mul(closeRatio);
        const closeOrderMargin = input.margin.mul(closeRatio);
        await this.closePositionWithFill(tx, {
          ...input,
          size: closeSize,
          fee: closeFee,
          settlement: undefined,
        }, closeSize.mul(input.price));
        await this.releaseNettedOrderMargin(tx, input, closeOrderMargin);
        feeSettledWithClose = closeFee;

        const residualSize = input.size.minus(closeSize);
        if (residualSize.greaterThan(0)) {
          const residualMargin = input.margin.minus(closeOrderMargin);
          const residualNotional = residualSize.mul(input.price);
          const maintenance = residualNotional.mul(input.maintenanceRate);
          await tx.position.create({
            data: {
              userId: input.userId,
              marketId: input.marketId,
              side,
              route: input.route,
              size: residualSize,
              entryPrice: input.price,
              markPrice: input.price,
              leverage: input.leverage,
              margin: residualMargin,
              maintenanceMargin: maintenance,
              liquidationPrice: this.calculateLiquidationPrice(
                side,
                input.price,
                input.leverage,
                input.maintenanceRate,
              ),
            },
          });
          if (input.route === ExecutionRoute.B_BOOK_INTERNAL) {
            await this.updateExposure(tx, input.marketId, side, residualNotional);
          }
        }
      } else {
        const totalSize = new Prisma.Decimal(existing?.size ?? 0).plus(input.size);
        const weightedEntry = existing
          ? new Prisma.Decimal(existing.entryPrice)
              .mul(existing.size)
              .plus(input.price.mul(input.size))
              .div(totalSize)
          : input.price;
        const totalMargin = new Prisma.Decimal(existing?.margin ?? 0).plus(input.margin);
        const maintenance = totalSize.mul(weightedEntry).mul(input.maintenanceRate);
        const liquidationPrice = this.calculateLiquidationPrice(
          side,
          weightedEntry,
          input.leverage,
          input.maintenanceRate,
        );
        if (existing) {
          await tx.position.update({
            where: { id: existing.id },
            data: {
              size: totalSize,
              entryPrice: weightedEntry,
              markPrice: input.price,
              margin: totalMargin,
              maintenanceMargin: maintenance,
              liquidationPrice,
            },
          });
        } else {
          await tx.position.create({
            data: {
              userId: input.userId,
              marketId: input.marketId,
              side,
              route: input.route,
              size: input.size,
              entryPrice: input.price,
              markPrice: input.price,
              leverage: input.leverage,
              margin: input.margin,
              maintenanceMargin: maintenance,
              liquidationPrice,
            },
          });
        }
        if (input.route === ExecutionRoute.B_BOOK_INTERNAL) {
          await this.updateExposure(tx, input.marketId, side, notional);
        }
      }
    }
    const openingFee = input.fee.minus(feeSettledWithClose);
    if (!input.reduceOnly && openingFee.greaterThan(0)) {
      await this.ledger.postTransaction({
        type: LedgerTransactionType.TRADING_FEE,
        idempotencyKey: `order-fee:${input.providerFillId ?? input.orderId}`,
        referenceType: 'Order',
        referenceId: input.orderId,
        entries: [
          {
            accountType: LedgerAccountType.USER_SPOT,
            userId: input.userId,
            assetId: input.quoteAssetId,
            direction: LedgerEntryDirection.DEBIT,
            amount: openingFee,
          },
          {
            accountType: LedgerAccountType.PLATFORM_FEES,
            assetId: input.quoteAssetId,
            direction: LedgerEntryDirection.CREDIT,
            amount: openingFee,
          },
        ],
      }, tx);
    }
    await tx.trade.create({
      data: {
        userId: input.userId,
        orderId: input.orderId,
        providerFillId: input.providerFillId,
        marketId: input.marketId,
        route: input.route,
        side: input.side,
        price: input.price,
        size: input.size,
        notional,
        feeAmount: input.fee,
        executedAt: new Date(),
      },
    });
    if (input.providerFillId) {
      const order = await tx.order.findUniqueOrThrow({ where: { id: input.orderId } });
      const previousFilled = new Prisma.Decimal(order.filledSize);
      const nextFilled = previousFilled.plus(input.size);
      const averageFillPrice = previousFilled.greaterThan(0) && order.averageFillPrice
        ? new Prisma.Decimal(order.averageFillPrice).mul(previousFilled)
            .plus(input.price.mul(input.size)).div(nextFilled)
        : input.price;
      await tx.order.update({
        where: { id: input.orderId },
        data: {
          status: nextFilled.greaterThanOrEqualTo(order.size)
            ? OrderStatus.FILLED
            : OrderStatus.PARTIALLY_FILLED,
          filledSize: nextFilled,
          averageFillPrice,
        },
      });
    } else {
      await tx.order.update({
        where: { id: input.orderId },
        data: {
          status: OrderStatus.FILLED,
          filledSize: input.size,
          averageFillPrice: input.price,
        },
      });
    }
  }

  private async releaseNettedOrderMargin(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      userId: string;
      quoteAssetId: string;
      providerFillId?: string;
    },
    amount: Prisma.Decimal,
  ): Promise<void> {
    if (amount.lessThanOrEqualTo(0)) return;
    await this.ledger.postTransaction({
      type: LedgerTransactionType.MARGIN_RELEASE,
      idempotencyKey: `netted-order-margin-release:${input.providerFillId ?? input.orderId}`,
      referenceType: 'Order',
      referenceId: input.orderId,
      description: 'Release margin reserved by an order that reduced an opposite position',
      entries: [
        {
          accountType: LedgerAccountType.USER_PERP_MARGIN,
          userId: input.userId,
          assetId: input.quoteAssetId,
          direction: LedgerEntryDirection.DEBIT,
          amount,
        },
        {
          accountType: LedgerAccountType.USER_SPOT,
          userId: input.userId,
          assetId: input.quoteAssetId,
          direction: LedgerEntryDirection.CREDIT,
          amount,
        },
      ],
    }, tx);
  }

  private async closePositionWithFill(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      userId: string;
      marketId: string;
      quoteAssetId: string;
      side: OrderSide;
      route: ExecutionRoute;
      size: Prisma.Decimal;
      price: Prisma.Decimal;
      fee: Prisma.Decimal;
      providerFillId?: string;
      settlement?: {
        liquidationEventId: string;
        liquidationFee: Prisma.Decimal;
        liquidationPlatformFee: Prisma.Decimal;
        liquidationInsuranceFee: Prisma.Decimal;
      };
    },
    notional: Prisma.Decimal,
  ) {
    const position = await tx.position.findFirst({
      where: {
        userId: input.userId,
        marketId: input.marketId,
        route: input.route,
        status: PositionStatus.OPEN,
      },
    });
    if (!position || input.size.greaterThan(position.size)) {
      throw new BadRequestException('Reduce-only size exceeds open position');
    }
    const expectedSide =
      position.side === PositionSide.LONG ? OrderSide.SELL : OrderSide.BUY;
    if (input.side !== expectedSide) {
      throw new BadRequestException('Reduce-only side must close the open position');
    }
    const pnlPerUnit =
      position.side === PositionSide.LONG
        ? input.price.minus(position.entryPrice)
        : new Prisma.Decimal(position.entryPrice).minus(input.price);
    const realizedPnl = pnlPerUnit.mul(input.size);
    const marginShare = new Prisma.Decimal(position.margin).mul(input.size).div(position.size);
    const liquidationFee = input.settlement?.liquidationFee ?? new Prisma.Decimal(0);
    const settlementLedger = await this.settlePositionLedger(tx, {
      idempotencyKey: `position-close:${input.providerFillId ?? input.orderId}`,
      userId: input.userId,
      assetId: input.quoteAssetId,
      route: input.route,
      margin: marginShare,
      pnl: realizedPnl,
      fee: input.fee.plus(liquidationFee),
      platformFee: input.fee.plus(
        input.settlement?.liquidationPlatformFee ?? new Prisma.Decimal(0),
      ),
      insuranceFee:
        input.settlement?.liquidationInsuranceFee ?? new Prisma.Decimal(0),
      transactionType: input.settlement
        ? LedgerTransactionType.LIQUIDATION
        : LedgerTransactionType.TRADE_PNL,
    });
    const remaining = new Prisma.Decimal(position.size).minus(input.size);
    await tx.position.update({
      where: { id: position.id },
      data:
        remaining.isZero()
          ? {
              size: 0,
              margin: 0,
              realizedPnl: { increment: realizedPnl },
              unrealizedPnl: 0,
              status: input.settlement
                ? PositionStatus.LIQUIDATED
                : PositionStatus.CLOSED,
              closedAt: new Date(),
              markPrice: input.price,
            }
          : {
              size: remaining,
              margin: new Prisma.Decimal(position.margin).minus(marginShare),
              realizedPnl: { increment: realizedPnl },
              markPrice: input.price,
            },
    });
    if (remaining.isZero()) {
      await tx.order.updateMany({
        where: {
          id: { not: input.orderId },
          userId: input.userId,
          marketId: input.marketId,
          status: OrderStatus.OPEN,
          type: { in: [OrderType.STOP_LOSS, OrderType.TAKE_PROFIT] },
          reduceOnly: true,
        },
        data: {
          status: OrderStatus.CANCELLED,
          rejectionReason: 'Position closed',
        },
      });
    }
    if (input.route === ExecutionRoute.B_BOOK_INTERNAL) {
      const positionSide = position.side;
      await this.updateExposure(tx, input.marketId, positionSide, notional.negated());
    }
    if (input.settlement) {
      await tx.liquidationEvent.update({
        where: { id: input.settlement.liquidationEventId },
        data: {
          status: 'COMPLETED',
          ledgerTransactionId: settlementLedger.id,
          completedAt: new Date(),
        },
      });
    }
  }

  async settlePositionLedger(
    tx: Prisma.TransactionClient,
    input: {
      idempotencyKey: string;
      userId: string;
      assetId: string;
      route: ExecutionRoute;
      margin: Prisma.Decimal;
      pnl: Prisma.Decimal;
      fee: Prisma.Decimal;
      platformFee?: Prisma.Decimal;
      insuranceFee?: Prisma.Decimal;
      transactionType?: LedgerTransactionType;
    },
  ) {
    const platformAccount =
      input.route === ExecutionRoute.B_BOOK_INTERNAL
        ? LedgerAccountType.PLATFORM_BBOOK
        : LedgerAccountType.PROVIDER_CLEARING;
    const settlement = input.margin.plus(input.pnl);
    const requestedPlatformFee = input.platformFee ?? input.fee;
    const requestedInsuranceFee = input.insuranceFee ?? new Prisma.Decimal(0);
    // A liquidation quote is calculated from the trigger mark, while the
    // provider fill can be worse. Fees may therefore exceed the equity that is
    // actually left at execution. Only collect fees from non-negative equity;
    // otherwise the posting becomes unbalanced and the provider fill can never
    // be reconciled.
    const availableForFees = Prisma.Decimal.max(0, settlement);
    const platformFee = Prisma.Decimal.min(requestedPlatformFee, availableForFees);
    const insuranceFee = Prisma.Decimal.min(
      requestedInsuranceFee,
      Prisma.Decimal.max(0, availableForFees.minus(platformFee)),
    );
    const payout = Prisma.Decimal.max(0, settlement.minus(platformFee).minus(insuranceFee));
    const deficit = Prisma.Decimal.max(0, settlement.negated());
    const entries: LedgerPostingEntry[] = [
      {
        accountType: LedgerAccountType.USER_PERP_MARGIN,
        userId: input.userId,
        assetId: input.assetId,
        direction: LedgerEntryDirection.DEBIT,
        amount: input.margin,
      },
    ];
    if (input.pnl.greaterThan(0)) {
      entries.push({
        accountType: platformAccount,
        assetId: input.assetId,
        direction: LedgerEntryDirection.DEBIT,
        amount: input.pnl,
      });
    } else if (input.pnl.lessThan(0)) {
      entries.push({
        accountType: platformAccount,
        assetId: input.assetId,
        direction: LedgerEntryDirection.CREDIT,
        amount: input.pnl.abs(),
      });
    }
    if (deficit.greaterThan(0)) {
      entries.push({
        accountType: LedgerAccountType.INSURANCE,
        assetId: input.assetId,
        direction: LedgerEntryDirection.DEBIT,
        amount: deficit,
      });
    }
    if (payout.greaterThan(0)) {
      entries.push({
        accountType: LedgerAccountType.USER_SPOT,
        userId: input.userId,
        assetId: input.assetId,
        direction: LedgerEntryDirection.CREDIT,
        amount: payout,
      });
    }
    if (platformFee.greaterThan(0)) {
      entries.push({
        accountType: LedgerAccountType.PLATFORM_FEES,
        assetId: input.assetId,
        direction: LedgerEntryDirection.CREDIT,
        amount: platformFee,
      });
    }
    if (insuranceFee.greaterThan(0)) {
      entries.push({
        accountType: LedgerAccountType.INSURANCE,
        assetId: input.assetId,
        direction: LedgerEntryDirection.CREDIT,
        amount: insuranceFee,
      });
    }
    return this.ledger.postTransaction({
      type: input.transactionType ?? LedgerTransactionType.TRADE_PNL,
      idempotencyKey: input.idempotencyKey,
      entries,
    }, tx);
  }

  private async updateExposure(
    tx: Prisma.TransactionClient,
    marketId: string,
    side: PositionSide,
    notionalDelta: Prisma.Decimal,
  ) {
    const exposure = await tx.bBookExposure.upsert({
      where: { marketId },
      update: {},
      create: { marketId },
    });
    const long = new Prisma.Decimal(exposure.longNotional).plus(
      side === PositionSide.LONG ? notionalDelta : 0,
    );
    const short = new Prisma.Decimal(exposure.shortNotional).plus(
      side === PositionSide.SHORT ? notionalDelta : 0,
    );
    return tx.bBookExposure.update({
      where: { marketId },
      data: {
        longNotional: Prisma.Decimal.max(0, long),
        shortNotional: Prisma.Decimal.max(0, short),
        netNotional: Prisma.Decimal.max(0, long).minus(Prisma.Decimal.max(0, short)),
      },
    });
  }

  private async releaseMargin(
    tx: Prisma.TransactionClient,
    order: {
      id: string;
      userId: string;
      marginReserved: Prisma.Decimal;
      market: { quoteAssetId: string };
    },
  ) {
    if (order.marginReserved.lessThanOrEqualTo(0)) {
      return;
    }
    await this.ledger.postTransaction({
      type: LedgerTransactionType.MARGIN_RELEASE,
      idempotencyKey: `order-margin-release:${order.id}`,
      referenceType: 'Order',
      referenceId: order.id,
      entries: [
        {
          accountType: LedgerAccountType.USER_PERP_MARGIN,
          userId: order.userId,
          assetId: order.market.quoteAssetId,
          direction: LedgerEntryDirection.DEBIT,
          amount: order.marginReserved,
        },
        {
          accountType: LedgerAccountType.USER_SPOT,
          userId: order.userId,
          assetId: order.market.quoteAssetId,
          direction: LedgerEntryDirection.CREDIT,
          amount: order.marginReserved,
        },
      ],
    }, tx);
  }

  private async failAndRelease(
    order: {
      id: string;
      userId: string;
      marginReserved: Prisma.Decimal;
      market: { quoteAssetId: string };
    },
    reason: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.releaseMargin(tx, order);
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.FAILED, rejectionReason: reason },
      });
      await tx.providerOrder.updateMany({
        where: { orderId: order.id },
        data: { status: ProviderOrderStatus.FAILED },
      });
    });
  }

  private getRiskConfig(marketId: string, symbol: string) {
    return this.prisma.riskConfig.upsert({
      where: { marketId },
      update: {},
      create: {
        marketId,
        maxLeverage: symbol.startsWith('SOL') ? 5 : 10,
      },
    });
  }

  private getFeeConfig(marketId: string) {
    return this.prisma.feeConfig.upsert({
      where: { marketId },
      update: {},
      create: { marketId },
    });
  }

  private async assertUniqueClientOrderId(userId: string, clientOrderId: string) {
    const existing = await this.prisma.order.findUnique({
      where: {
        userId_clientOrderId: {
          userId,
          clientOrderId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('Duplicate client order id');
    }
  }

  private calculateLiquidationPrice(
    side: PositionSide,
    entry: Prisma.Decimal,
    leverage: number,
    maintenanceRate: Prisma.Decimal,
  ) {
    const initialMarginRate = new Prisma.Decimal(1).div(leverage);
    return side === PositionSide.LONG
      ? entry.mul(new Prisma.Decimal(1).minus(initialMarginRate).plus(maintenanceRate))
      : entry.mul(new Prisma.Decimal(1).plus(initialMarginRate).minus(maintenanceRate));
  }

  private calculateBookVwap(
    book: { bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> },
    side: OrderSide,
    requestedSize: Prisma.Decimal,
  ): Prisma.Decimal {
    const levels = side === OrderSide.BUY ? book.asks : book.bids;
    let remaining = requestedSize;
    let quote = new Prisma.Decimal(0);
    for (const level of levels) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const levelSize = new Prisma.Decimal(level.size);
      const used = Prisma.Decimal.min(remaining, levelSize);
      quote = quote.plus(used.mul(level.price));
      remaining = remaining.minus(used);
    }
    if (remaining.greaterThan(0)) {
      throw new ServiceUnavailableException({
        code: 'BBOOK_DEPTH_INSUFFICIENT',
        message: 'Market depth is insufficient for internal execution',
      });
    }
    return quote.div(requestedSize);
  }

  private makeCloid(orderId: string): `0x${string}` {
    return `0x${createHash('sha256').update(orderId).digest('hex').slice(0, 32)}`;
  }

  private isMainnetBalanceMode(): boolean {
    return (
      this.config.get<boolean>('DISPLAY_MAINNET_ONLY', false) ||
      this.config.get<boolean>('MAINNET_ENABLED', false)
    );
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
