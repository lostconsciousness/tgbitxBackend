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
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { HyperliquidExecutionService } from '../hyperliquid/hyperliquid-execution.service';

jest.mock('../hyperliquid/hyperliquid-order-format', () => ({
  formatHyperliquidPrice: (price: string) => price,
  formatHyperliquidSize: (size: string) => size,
}));

import { LedgerService } from '../ledger/ledger.service';
import { MarketDataService } from '../market-data/market-data.service';
import { MarketsService } from '../markets/markets.service';
import { RoutingService } from '../routing/routing.service';
import { OperationalSettingsService } from '../settings/operational-settings.service';
import { assertBalancedLedgerEntries } from '../ledger/ledger.validator';
import { OrdersService } from './orders.service';

describe('OrdersService settlement ledger', () => {
  it('deducts close and liquidation fees before payout without unbalancing entries', async () => {
    const postTransaction = jest.fn().mockResolvedValue({ id: 'ledger-1' });
    const service = new OrdersService(
      {} as PrismaService,
      {} as ConfigService,
      {} as MarketsService,
      {} as MarketDataService,
      {} as RoutingService,
      { postTransaction } as unknown as LedgerService,
      {} as HyperliquidExecutionService,
      {} as OperationalSettingsService,
    );

    await service.settlePositionLedger({} as Prisma.TransactionClient, {
      idempotencyKey: 'liquidation:test',
      userId: 'user-1',
      assetId: 'usdc',
      route: ExecutionRoute.B_BOOK_INTERNAL,
      margin: new Prisma.Decimal(10),
      pnl: new Prisma.Decimal(-9),
      fee: new Prisma.Decimal(1),
      platformFee: new Prisma.Decimal('0.7'),
      insuranceFee: new Prisma.Decimal('0.3'),
      transactionType: LedgerTransactionType.LIQUIDATION,
    });

    const posting = postTransaction.mock.calls[0][0];
    const debit = posting.entries
      .filter((entry: { direction: LedgerEntryDirection }) =>
        entry.direction === LedgerEntryDirection.DEBIT,
      )
      .reduce(
        (sum: Prisma.Decimal, entry: { amount: Prisma.Decimal }) =>
          sum.plus(entry.amount),
        new Prisma.Decimal(0),
      );
    const credit = posting.entries
      .filter((entry: { direction: LedgerEntryDirection }) =>
        entry.direction === LedgerEntryDirection.CREDIT,
      )
      .reduce(
        (sum: Prisma.Decimal, entry: { amount: Prisma.Decimal }) =>
          sum.plus(entry.amount),
        new Prisma.Decimal(0),
      );

    expect(debit.equals(credit)).toBe(true);
    expect(
      posting.entries.some(
        (entry: { userId?: string; direction: LedgerEntryDirection }) =>
          entry.userId === 'user-1' &&
          entry.direction === LedgerEntryDirection.CREDIT,
      ),
    ).toBe(false);
  });

  it('absorbs negative liquidation equity without crediting uncollectible fees', async () => {
    const postTransaction = jest.fn().mockResolvedValue({ id: 'ledger-negative-equity' });
    const service = new OrdersService(
      {} as PrismaService,
      {} as ConfigService,
      {} as MarketsService,
      {} as MarketDataService,
      {} as RoutingService,
      { postTransaction } as unknown as LedgerService,
      {} as HyperliquidExecutionService,
      {} as OperationalSettingsService,
    );

    await service.settlePositionLedger({} as Prisma.TransactionClient, {
      idempotencyKey: 'liquidation:negative-equity',
      userId: 'user-1',
      assetId: 'usdc',
      route: ExecutionRoute.A_BOOK_HYPERLIQUID,
      margin: new Prisma.Decimal('9.9487665'),
      pnl: new Prisma.Decimal('-10.1559'),
      fee: new Prisma.Decimal('0.0546868575'),
      platformFee: new Prisma.Decimal('0.2142947955'),
      insuranceFee: new Prisma.Decimal('0.068403402'),
      transactionType: LedgerTransactionType.LIQUIDATION,
    });

    const posting = postTransaction.mock.calls[0][0];
    assertBalancedLedgerEntries(posting.entries);
    expect(posting.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ accountType: LedgerAccountType.PLATFORM_FEES }),
    ]));
    expect(posting.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountType: LedgerAccountType.INSURANCE,
        direction: LedgerEntryDirection.DEBIT,
      }),
    ]));
  });
});

describe('OrdersService execution readiness', () => {
  function createUnavailablePerpService() {
    const market = {
      id: 'market-btc-perp',
      symbol: 'BTC-PERP',
      type: MarketType.PERP,
      status: MarketStatus.ACTIVE,
      baseAssetId: 'asset-btc',
      quoteAssetId: 'asset-usdc',
      pricePrecision: 1,
      sizePrecision: 5,
      minOrderSize: new Prisma.Decimal('0.00001'),
    };
    const prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(null) },
      position: { findFirst: jest.fn().mockResolvedValue(null) },
      bBookExposure: { findMany: jest.fn().mockResolvedValue([]) },
      riskConfig: {
        upsert: jest.fn().mockResolvedValue({
          maxLeverage: 10,
          maxMarkAgeMs: 2_000,
          maintenanceMarginRate: new Prisma.Decimal('0.005'),
        }),
      },
      $transaction: jest.fn(),
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => ({
        BBOOK_ENABLED: true,
        PLATFORM_CAPITAL_USDC: '0',
        INSURANCE_CAPITAL_USDC: '0',
        PERP_MIN_ORDER_NOTIONAL_USDC: '10',
        PERP_MAX_ORDER_NOTIONAL_USDC: '100',
      } as Record<string, unknown>)[key] ?? fallback),
    };
    const settings = {
      getBoolean: jest.fn().mockResolvedValue(false),
    };
    const hyperliquid = {
      isExecutionEnabled: jest.fn().mockReturnValue(false),
      getReadiness: jest.fn().mockResolvedValue({
        ready: false,
        reasons: ['CONFIG_INCOMPLETE'],
        masterAddressConfigured: false,
        agentAddressConfigured: false,
        agentRegistered: false,
      }),
    };
    const service = new OrdersService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      { getBySymbol: jest.fn().mockResolvedValue(market) } as unknown as MarketsService,
      { getOrderBook: jest.fn().mockResolvedValue({
        time: Date.now(),
        bids: [{ price: '59900' }],
        asks: [{ price: '60100' }],
      }), getTicker: jest.fn().mockResolvedValue({
        markPrice: '60000',
        notional24h: '5000000',
      }) } as unknown as MarketDataService,
      { decide: jest.fn().mockResolvedValue(ExecutionRoute.A_BOOK_HYPERLIQUID) } as unknown as RoutingService,
      {} as LedgerService,
      hyperliquid as unknown as HyperliquidExecutionService,
      settings as unknown as OperationalSettingsService,
    );
    return { service, prisma };
  }

  it('rejects an unavailable A-book route before reserving margin', async () => {
    const { service, prisma } = createUnavailablePerpService();

    await expect(service.createOrder('user-1', {
      symbol: 'BTC-PERP',
      clientOrderId: 'unavailable-perp-1',
      side: OrderSide.BUY,
      type: OrderType.MARKET,
      size: '0.0002',
      leverage: 10,
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PERP_EXECUTION_UNAVAILABLE' }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports why perpetual execution is unavailable', async () => {
    const { service } = createUnavailablePerpService();
    await expect(service.getExecutionReadiness()).resolves.toMatchObject({
      ready: false,
      perp: {
        ready: false,
        aBook: { ready: false },
        bBook: { ready: false, capitalConfigured: false, insuranceConfigured: false },
      },
    });
  });

  it.each([
    ['0.00005', 'PERP_NOTIONAL_TOO_LOW'],
    ['0.002', 'PERP_NOTIONAL_TOO_HIGH'],
  ])('rejects pilot notional %s with %s before margin reservation', async (size, code) => {
    const { service, prisma } = createUnavailablePerpService();
    await expect(service.createOrder('user-1', {
      symbol: 'BTC-PERP',
      clientOrderId: `pilot-limit-${code}`,
      side: OrderSide.BUY,
      type: OrderType.MARKET,
      size,
      leverage: 10,
    })).rejects.toMatchObject({ response: expect.objectContaining({ code }) });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('OrdersService provider recovery', () => {
  const market = {
    id: 'market-btc-perp',
    symbol: 'BTC-PERP',
    type: MarketType.PERP,
    providerSymbol: 'BTC',
    quoteAssetId: 'asset-usdc',
  };

  it('terminalizes a provider margin rejection instead of retrying it forever', async () => {
    const order = {
      id: 'order-margin-rejected',
      userId: 'user-1',
      marketId: market.id,
      status: OrderStatus.PROVIDER_PENDING,
      size: new Prisma.Decimal('0.00024'),
      filledSize: new Prisma.Decimal(0),
      marginReserved: new Prisma.Decimal(0),
      market,
      liquidationEvent: null,
    };
    const providerOrder = {
      id: 'provider-margin-rejected',
      orderId: order.id,
      providerOrderId: null,
      cloid: `0x${'b'.repeat(32)}`,
      status: ProviderOrderStatus.PENDING,
      syncAttempts: 1,
      createdAt: new Date(),
      failureReason: 'order 0: Insufficient margin to place order. asset=0',
      order,
    };
    const tx = {
      providerOrder: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      order: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      providerOrder: { findUnique: jest.fn().mockResolvedValue(providerOrder) },
      order: { findUniqueOrThrow: jest.fn().mockResolvedValue({ ...order, status: OrderStatus.FAILED }) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const hyperliquid = {
      getOrderSnapshot: jest.fn(),
      getOrderFills: jest.fn(),
    };
    const updates = { publish: jest.fn() };
    const service = new OrdersService(
      prisma as unknown as PrismaService,
      { get: jest.fn((_key: string, fallback: unknown) => fallback) } as unknown as ConfigService,
      {} as MarketsService,
      {} as MarketDataService,
      {} as RoutingService,
      { postTransaction: jest.fn() } as unknown as LedgerService,
      hyperliquid as unknown as HyperliquidExecutionService,
      {} as OperationalSettingsService,
      updates as never,
    );

    await service.reconcileProviderOrder(order.id);

    expect(tx.providerOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: ProviderOrderStatus.FAILED, nextSyncAt: null }),
    }));
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: OrderStatus.FAILED }),
    }));
    expect(hyperliquid.getOrderSnapshot).not.toHaveBeenCalled();
    expect(updates.publish).toHaveBeenCalledWith('user-1', [
      'balances',
      'orders',
      'positions',
      'trades',
    ]);
  });

  it('escalates an old unknown cloid without releasing margin and schedules a slow recheck', async () => {
    const order = {
      id: 'order-unknown',
      userId: 'user-1',
      marketId: market.id,
      status: OrderStatus.PROVIDER_PENDING,
      size: new Prisma.Decimal('0.001'),
      filledSize: new Prisma.Decimal(0),
      marginReserved: new Prisma.Decimal('10'),
      market,
      liquidationEvent: null,
    };
    const providerOrder = {
      id: 'provider-unknown',
      orderId: order.id,
      cloid: `0x${'a'.repeat(32)}`,
      status: ProviderOrderStatus.PENDING,
      syncAttempts: 19,
      createdAt: new Date(Date.now() - 600_000),
      order,
    };
    const prisma = {
      providerOrder: {
        findUnique: jest.fn().mockResolvedValue(providerOrder),
        update: jest.fn().mockResolvedValue(providerOrder),
      },
      order: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(order),
      },
      $transaction: jest.fn(),
    };
    const hyperliquid = {
      getOrderSnapshot: jest.fn().mockResolvedValue({ status: 'UNKNOWN', raw: {} }),
      getOrderFills: jest.fn().mockResolvedValue([]),
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => ({
        PROVIDER_RECONCILIATION_MAX_ATTEMPTS: 20,
        PROVIDER_RECONCILIATION_UNKNOWN_GRACE_MS: 300_000,
        PROVIDER_RECONCILIATION_MANUAL_RECHECK_MS: 300_000,
      } as Record<string, unknown>)[key] ?? fallback),
    };
    const service = new OrdersService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      {} as MarketsService,
      {} as MarketDataService,
      {} as RoutingService,
      { postTransaction: jest.fn() } as unknown as LedgerService,
      hyperliquid as unknown as HyperliquidExecutionService,
      {} as OperationalSettingsService,
    );

    await service.reconcileProviderOrder(order.id);

    expect(prisma.providerOrder.update).toHaveBeenCalledWith({
      where: { id: providerOrder.id },
      data: expect.objectContaining({
        status: ProviderOrderStatus.RECONCILIATION_REQUIRED,
        nextSyncAt: expect.any(Date),
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('terminalizes a fully accounted fill even while the provider snapshot is still unknown', async () => {
    const originalOrder = {
      id: 'order-filled-before-snapshot',
      userId: 'user-1',
      marketId: market.id,
      status: OrderStatus.PROVIDER_PENDING,
      size: new Prisma.Decimal('0.001'),
      filledSize: new Prisma.Decimal(0),
      marginReserved: new Prisma.Decimal('10'),
      market,
      liquidationEvent: null,
    };
    const filledOrder = {
      ...originalOrder,
      status: OrderStatus.FILLED,
      filledSize: new Prisma.Decimal('0.001'),
    };
    const providerOrder = {
      id: 'provider-filled-before-snapshot',
      orderId: originalOrder.id,
      providerOrderId: null,
      cloid: `0x${'d'.repeat(32)}`,
      status: ProviderOrderStatus.PENDING,
      syncAttempts: 0,
      createdAt: new Date(),
      order: originalOrder,
    };
    const tx = {
      providerOrder: { update: jest.fn().mockResolvedValue({}) },
      order: { update: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      providerOrder: { findUnique: jest.fn().mockResolvedValue(providerOrder) },
      order: { findUniqueOrThrow: jest.fn().mockResolvedValue(filledOrder) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const hyperliquid = {
      getOrderSnapshot: jest.fn().mockResolvedValue({ status: 'UNKNOWN', raw: {} }),
      getOrderFills: jest.fn().mockResolvedValue([{
        providerFillId: 'fill-1',
        providerOrderId: 'provider-oid',
        price: '65000',
        size: '0.001',
        feeAmount: '0.01',
        occurredAt: new Date(),
        raw: {},
      }]),
    };
    const updates = { publish: jest.fn() };
    const service = new OrdersService(
      prisma as unknown as PrismaService,
      { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      {} as MarketsService,
      {} as MarketDataService,
      {} as RoutingService,
      {} as LedgerService,
      hyperliquid as unknown as HyperliquidExecutionService,
      {} as OperationalSettingsService,
      updates as never,
    );
    jest.spyOn(service as never, 'applyProviderFill' as never).mockResolvedValue(undefined as never);

    await service.reconcileProviderOrder(originalOrder.id);

    expect(tx.providerOrder.update).toHaveBeenCalledWith({
      where: { id: providerOrder.id },
      data: expect.objectContaining({
        status: ProviderOrderStatus.FILLED,
        nextSyncAt: null,
        reconciliationRequiredAt: null,
      }),
    });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: originalOrder.id },
      data: { status: OrderStatus.FILLED },
    });
    expect(updates.publish).toHaveBeenCalledWith('user-1', [
      'balances',
      'orders',
      'positions',
      'trades',
    ]);
  });

  it('cancels an A-book order by cloid and delegates release to reconciliation', async () => {
    const providerOrder = {
      id: 'provider-open',
      providerOrderId: null,
      cloid: `0x${'b'.repeat(32)}`,
      status: ProviderOrderStatus.OPEN,
      syncAttempts: 0,
      createdAt: new Date(),
    };
    const order = {
      id: 'order-open',
      userId: 'user-1',
      status: OrderStatus.OPEN,
      market,
      providerOrder,
    };
    const prisma = {
      order: {
        findFirst: jest.fn().mockResolvedValue(order),
        findUniqueOrThrow: jest.fn().mockResolvedValue(order),
      },
      providerOrder: { update: jest.fn().mockResolvedValue(providerOrder) },
      $transaction: jest.fn(),
    };
    const hyperliquid = { cancelOrder: jest.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(
      prisma as unknown as PrismaService,
      {} as ConfigService,
      {} as MarketsService,
      {} as MarketDataService,
      {} as RoutingService,
      {} as LedgerService,
      hyperliquid as unknown as HyperliquidExecutionService,
      {} as OperationalSettingsService,
    );
    jest.spyOn(service, 'reconcileProviderOrder').mockResolvedValue(order as never);

    await service.cancelOrder('user-1', order.id);

    expect(hyperliquid.cancelOrder).toHaveBeenCalledWith({
      providerSymbol: 'BTC',
      providerOrderId: undefined,
      cloid: providerOrder.cloid,
    });
    expect(service.reconcileProviderOrder).toHaveBeenCalledWith(order.id);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('terminalizes a partial IOC fill, releases unused margin and publishes after commit', async () => {
    const order = {
      id: 'order-partial-ioc',
      userId: 'user-1',
      marketId: market.id,
      status: OrderStatus.PARTIALLY_FILLED,
      size: new Prisma.Decimal('0.01'),
      filledSize: new Prisma.Decimal('0.006'),
      marginReserved: new Prisma.Decimal('100'),
      market,
      liquidationEvent: null,
    };
    const providerOrder = {
      id: 'provider-partial-ioc',
      orderId: order.id,
      cloid: `0x${'c'.repeat(32)}`,
      status: ProviderOrderStatus.PENDING,
      syncAttempts: 2,
      createdAt: new Date(),
      order,
    };
    const tx = {
      providerOrder: { update: jest.fn() },
      order: { update: jest.fn() },
    };
    const prisma = {
      providerOrder: { findUnique: jest.fn().mockResolvedValue(providerOrder) },
      order: { findUniqueOrThrow: jest.fn().mockResolvedValue(order) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const ledger = { postTransaction: jest.fn().mockResolvedValue({ id: 'release-1' }) };
    const updates = { publish: jest.fn() };
    const hyperliquid = {
      getOrderSnapshot: jest.fn().mockResolvedValue({
        status: 'FILLED',
        providerOrderId: 'provider-oid',
        raw: {},
      }),
      getOrderFills: jest.fn().mockResolvedValue([]),
    };
    const service = new OrdersService(
      prisma as unknown as PrismaService,
      { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      {} as MarketsService,
      {} as MarketDataService,
      {} as RoutingService,
      ledger as unknown as LedgerService,
      hyperliquid as unknown as HyperliquidExecutionService,
      {} as OperationalSettingsService,
      updates as never,
    );

    await service.reconcileProviderOrder(order.id);

    expect(ledger.postTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `provider-order-release:${order.id}`,
        entries: expect.arrayContaining([
          expect.objectContaining({ amount: new Prisma.Decimal('40') }),
        ]),
      }),
      tx,
    );
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: order.id },
      data: expect.objectContaining({ status: OrderStatus.CANCELLED }),
    });
    expect(tx.providerOrder.update).toHaveBeenCalledWith({
      where: { id: providerOrder.id },
      data: expect.objectContaining({
        status: ProviderOrderStatus.FILLED,
        nextSyncAt: null,
      }),
    });
    expect(updates.publish).toHaveBeenCalledWith('user-1', [
      'balances',
      'orders',
      'positions',
      'trades',
    ]);
  });
});

describe('OrdersService omnibus close netting', () => {
  it('fills a reduce-only close internally when it reduces the provider/internal mismatch', async () => {
    const order = {
      id: 'close-order-1',
      userId: 'user-long',
      marketId: 'market-btc-perp',
      side: OrderSide.SELL,
      size: new Prisma.Decimal('0.00024'),
      filledSize: new Prisma.Decimal(0),
      feeAmount: new Prisma.Decimal('0.0075'),
      leverage: 10,
      reduceOnly: true,
      market: { providerSymbol: 'BTC', quoteAssetId: 'asset-usdc' },
    };
    const tx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      order: { findUniqueOrThrow: jest.fn().mockResolvedValue(order) },
      position: {
        findMany: jest.fn().mockResolvedValue([
          { side: PositionSide.LONG, size: new Prisma.Decimal('0.00024') },
          { side: PositionSide.SHORT, size: new Prisma.Decimal('0.00159') },
        ]),
      },
      riskConfig: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          maintenanceMarginRate: new Prisma.Decimal('0.005'),
        }),
      },
      systemSetting: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const hyperliquid = {
      getAccountState: jest.fn().mockResolvedValue({
        assetPositions: [{ position: { coin: 'BTC', szi: '-0.00156' } }],
      }),
    };
    const service = new OrdersService(
      prisma as unknown as PrismaService,
      {} as ConfigService,
      {} as MarketsService,
      {} as MarketDataService,
      {} as RoutingService,
      {} as LedgerService,
      hyperliquid as unknown as HyperliquidExecutionService,
      {} as OperationalSettingsService,
    );
    const applyFill = jest.spyOn(service as never, 'applyFill' as never)
      .mockResolvedValue(undefined as never);

    const result = await (service as unknown as {
      applyExistingProviderHedgeCoverage: (
        value: typeof order,
        price: Prisma.Decimal,
      ) => Promise<{ remaining: Prisma.Decimal; providerPosition: Prisma.Decimal }>;
    }).applyExistingProviderHedgeCoverage(order, new Prisma.Decimal('63111.5'));

    expect(result.remaining.isZero()).toBe(true);
    expect(result.providerPosition.equals('-0.00156')).toBe(true);
    expect(applyFill).toHaveBeenCalledWith(tx, expect.objectContaining({
      size: expect.objectContaining({ s: 1 }),
      reduceOnly: true,
      providerFillId: `internal-net:${order.id}`,
    }));
    expect(tx.systemSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'abook:provider-position-offset:BTC' },
      create: {
        key: 'abook:provider-position-offset:BTC',
        value: '0.00003',
      },
      update: { value: '0.00003' },
    });
  });

  it('nets a filled opposite-side provider order into the existing user position', async () => {
    const position = {
      id: 'position-eth-short',
      userId: 'user-icloud',
      marketId: 'market-eth-perp',
      route: ExecutionRoute.A_BOOK_HYPERLIQUID,
      side: PositionSide.SHORT,
      size: new Prisma.Decimal('0.3366'),
      entryPrice: new Prisma.Decimal('1882.5'),
      margin: new Prisma.Decimal('63.32'),
    };
    const order = {
      id: 'order-buy-eth',
      size: new Prisma.Decimal('0.2652'),
      filledSize: new Prisma.Decimal(0),
      averageFillPrice: null,
    };
    const tx = {
      position: {
        findFirst: jest.fn().mockResolvedValue(position),
        update: jest.fn().mockResolvedValue(position),
        create: jest.fn(),
      },
      order: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(order),
        update: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      trade: { create: jest.fn().mockResolvedValue({}) },
    };
    const ledger = {
      postTransaction: jest.fn().mockImplementation(async (posting: { idempotencyKey: string }) => ({
        id: posting.idempotencyKey,
      })),
    };
    const service = new OrdersService(
      {} as PrismaService,
      {} as ConfigService,
      {} as MarketsService,
      {} as MarketDataService,
      {} as RoutingService,
      ledger as unknown as LedgerService,
      {} as HyperliquidExecutionService,
      {} as OperationalSettingsService,
    );

    await (service as unknown as {
      applyFill: (client: typeof tx, input: Record<string, unknown>) => Promise<void>;
    }).applyFill(tx, {
      orderId: order.id,
      userId: position.userId,
      marketId: position.marketId,
      quoteAssetId: 'asset-usdc',
      side: OrderSide.BUY,
      route: ExecutionRoute.A_BOOK_HYPERLIQUID,
      size: new Prisma.Decimal('0.2652'),
      price: new Prisma.Decimal('1882.49'),
      margin: new Prisma.Decimal('49.75'),
      leverage: 10,
      fee: new Prisma.Decimal('0.1'),
      maintenanceRate: new Prisma.Decimal('0.005'),
      reduceOnly: false,
      providerFillId: 'provider-fill-netting',
    });

    expect(tx.position.update).toHaveBeenCalledWith({
      where: { id: position.id },
      data: expect.objectContaining({
        size: expect.objectContaining({ s: 1 }),
        margin: expect.any(Prisma.Decimal),
      }),
    });
    const positionUpdate = tx.position.update.mock.calls[0][0].data;
    expect(positionUpdate.size.equals('0.0714')).toBe(true);
    expect(tx.position.create).not.toHaveBeenCalled();
    expect(ledger.postTransaction.mock.calls.map(([posting]) => posting.idempotencyKey)).toEqual([
      'position-close:provider-fill-netting',
      'netted-order-margin-release:provider-fill-netting',
    ]);
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: order.id },
      data: expect.objectContaining({ status: OrderStatus.FILLED }),
    });
  });
});

describe('OrdersService spot orders', () => {
  const spotMarket = {
    id: 'market-btc-usdc',
    symbol: 'BTC-USDC',
    type: MarketType.SPOT,
    status: MarketStatus.ACTIVE,
    baseAssetId: 'asset-btc',
    quoteAssetId: 'asset-usdc',
    pricePrecision: 1,
    sizePrecision: 5,
    minOrderSize: new Prisma.Decimal('0.00001'),
    providerName: null,
    providerSymbol: null,
    tradingViewSymbol: null,
    orderbookEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    baseAsset: {},
    quoteAsset: {},
  };

  function createSpotHarness(marketDataProvider = 'MOCK') {
    const tx = {
      order: {
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
          id: 'order-1',
          ...data,
        })),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'order-1',
          status: OrderStatus.FILLED,
          market: spotMarket,
          providerOrder: null,
          trades: [],
        }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      trade: {
        create: jest.fn(),
      },
    };
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      feeConfig: {
        upsert: jest.fn().mockResolvedValue({
          marketId: spotMarket.id,
          takerFeeBps: 5,
        }),
      },
      $transaction: jest.fn(
        async (
          callback: (client: typeof tx) => Promise<unknown>,
          _options?: unknown,
        ) => callback(tx),
      ),
    };
    const markets = {
      getBySymbol: jest.fn().mockResolvedValue(spotMarket),
    };
    const marketData = {
      getOrderBook: jest.fn().mockResolvedValue({
        symbol: spotMarket.symbol,
        provider: 'MOCK',
        providerSymbol: 'BTC',
        time: Date.now(),
        bids: [{ price: '99', size: '1', orders: 1 }],
        asks: [{ price: '101', size: '1', orders: 1 }],
      }),
    };
    const ledger = {
      assertSufficientUserSpotBalance: jest.fn(),
      postTransaction: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    };
    const updates = { publish: jest.fn() };
    const service = new OrdersService(
      prisma as unknown as PrismaService,
      {
        get: jest.fn((key: string, fallback: unknown) =>
          key === 'MARKET_DATA_PROVIDER' ? marketDataProvider : fallback,
        ),
      } as unknown as ConfigService,
      markets as unknown as MarketsService,
      marketData as unknown as MarketDataService,
      {} as RoutingService,
      ledger as unknown as LedgerService,
      {} as HyperliquidExecutionService,
      { getBoolean: jest.fn().mockResolvedValue(false) } as unknown as OperationalSettingsService,
      updates as never,
    );

    return { service, prisma, tx, markets, marketData, ledger, updates };
  }

  it('fills a spot market buy through balanced ledger entries', async () => {
    const { service, tx, ledger, updates } = createSpotHarness();

    await service.createOrder('user-1', {
      symbol: 'BTC-USDC',
      clientOrderId: 'client-buy-1',
      side: OrderSide.BUY,
      type: OrderType.MARKET,
      size: '2',
    });

    expect(ledger.assertSufficientUserSpotBalance).toHaveBeenCalledWith({
      userId: 'user-1',
      assetId: 'asset-usdc',
      amount: expect.objectContaining({ s: 1 }),
      mainnetOnly: false,
    }, tx);
    expect(ledger.assertSufficientUserSpotBalance.mock.calls[0][0].amount.toString())
      .toBe('202.101');

    const exchangePosting = ledger.postTransaction.mock.calls[0][0];
    const feePosting = ledger.postTransaction.mock.calls[1][0];
    assertBalancedLedgerEntries(exchangePosting.entries);
    assertBalancedLedgerEntries(feePosting.entries);
    expect(updates.publish).toHaveBeenCalledWith('user-1', [
      'balances',
      'orders',
      'positions',
      'trades',
    ]);
    expect(exchangePosting.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountType: LedgerAccountType.USER_SPOT,
          userId: 'user-1',
          assetId: 'asset-usdc',
          direction: LedgerEntryDirection.DEBIT,
        }),
        expect.objectContaining({
          accountType: LedgerAccountType.USER_SPOT,
          userId: 'user-1',
          assetId: 'asset-btc',
          direction: LedgerEntryDirection.CREDIT,
        }),
      ]),
    );
    expect(feePosting.type).toBe(LedgerTransactionType.TRADING_FEE);
    expect(tx.trade.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        side: OrderSide.BUY,
        feeAmount: expect.objectContaining({ s: 1 }),
      }),
    });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: expect.objectContaining({
        status: OrderStatus.FILLED,
        filledSize: expect.objectContaining({ s: 1 }),
        averageFillPrice: expect.objectContaining({ s: 1 }),
      }),
    });
  });

  it('does not execute a production spot order against a mock order book', async () => {
    const { service, prisma, ledger } = createSpotHarness('HYPERLIQUID');

    await expect(service.createOrder('user-1', {
      symbol: 'BTC-USDC',
      clientOrderId: 'client-production-mock-rejected',
      side: OrderSide.BUY,
      type: OrderType.MARKET,
      size: '0.01',
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SPOT_EXECUTION_UNAVAILABLE' }),
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(ledger.assertSufficientUserSpotBalance).not.toHaveBeenCalled();
  });

  it('fills a spot market sell through balanced ledger entries', async () => {
    const { service, tx, ledger } = createSpotHarness();

    await service.createOrder('user-1', {
      symbol: 'BTC-USDC',
      clientOrderId: 'client-sell-1',
      side: OrderSide.SELL,
      type: OrderType.MARKET,
      size: '2',
    });

    expect(ledger.assertSufficientUserSpotBalance).toHaveBeenCalledWith({
      userId: 'user-1',
      assetId: 'asset-btc',
      amount: expect.objectContaining({ s: 1 }),
      mainnetOnly: false,
    }, tx);
    expect(ledger.assertSufficientUserSpotBalance.mock.calls[0][0].amount.toString())
      .toBe('2');

    const exchangePosting = ledger.postTransaction.mock.calls[0][0];
    const feePosting = ledger.postTransaction.mock.calls[1][0];
    assertBalancedLedgerEntries(exchangePosting.entries);
    assertBalancedLedgerEntries(feePosting.entries);
    expect(exchangePosting.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountType: LedgerAccountType.USER_SPOT,
          userId: 'user-1',
          assetId: 'asset-btc',
          direction: LedgerEntryDirection.DEBIT,
        }),
        expect.objectContaining({
          accountType: LedgerAccountType.USER_SPOT,
          userId: 'user-1',
          assetId: 'asset-usdc',
          direction: LedgerEntryDirection.CREDIT,
        }),
      ]),
    );
    expect(feePosting.entries[0].amount.toString()).toBe('0.099');
    expect(tx.trade.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        side: OrderSide.SELL,
      }),
    });
  });

  it('creates an open spot limit order and reserves quote balance for buys', async () => {
    const { service, tx, marketData, ledger } = createSpotHarness();
    tx.order.findUniqueOrThrow.mockResolvedValueOnce({
      id: 'order-1',
      status: OrderStatus.OPEN,
      market: spotMarket,
      providerOrder: null,
      trades: [],
    });

    await service.createOrder('user-1', {
      symbol: 'BTC-USDC',
      clientOrderId: 'client-limit-1',
      side: OrderSide.BUY,
      type: OrderType.LIMIT,
      size: '2',
      price: '100',
    });

    expect(tx.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: OrderStatus.OPEN,
        route: ExecutionRoute.B_BOOK_INTERNAL,
        leverage: 1,
        marginReserved: expect.objectContaining({ s: 1 }),
        feeAmount: expect.objectContaining({ s: 1 }),
      }),
    });
    expect(tx.order.create.mock.calls[0][0].data.marginReserved.toString()).toBe('200.1');
    expect(tx.order.create.mock.calls[0][0].data.feeAmount.toString()).toBe('0.1');
    expect(ledger.assertSufficientUserSpotBalance).toHaveBeenCalledWith({
      userId: 'user-1',
      assetId: 'asset-usdc',
      amount: expect.objectContaining({ s: 1 }),
      mainnetOnly: false,
    }, tx);
    expect(ledger.assertSufficientUserSpotBalance.mock.calls[0][0].amount.toString())
      .toBe('200.1');
    expect(ledger.postTransaction).toHaveBeenCalledWith({
      type: LedgerTransactionType.SPOT_RESERVE,
      idempotencyKey: 'spot-reserve:order-1',
      referenceType: 'Order',
      referenceId: 'order-1',
      description: 'Reserve spot limit order funds',
      entries: expect.any(Array),
    }, tx);
    assertBalancedLedgerEntries(ledger.postTransaction.mock.calls[0][0].entries);
    expect(marketData.getOrderBook).toHaveBeenCalledWith('BTC-USDC');
  });

  it('releases a spot limit reserve on cancel', async () => {
    const { service, prisma, tx, ledger, marketData } = createSpotHarness();
    prisma.order.findFirst.mockResolvedValueOnce({
      id: 'order-1',
      userId: 'user-1',
      side: OrderSide.BUY,
      status: OrderStatus.OPEN,
      marginReserved: new Prisma.Decimal('200.1'),
      providerOrder: null,
      market: spotMarket,
    });
    tx.order.update.mockResolvedValueOnce({
      id: 'order-1',
      status: OrderStatus.CANCELLED,
      market: spotMarket,
      providerOrder: null,
    });

    await service.cancelOrder('user-1', 'order-1');

    expect(ledger.postTransaction).toHaveBeenCalledWith({
      type: LedgerTransactionType.SPOT_RELEASE,
      idempotencyKey: 'spot-release:order-1',
      referenceType: 'Order',
      referenceId: 'order-1',
      description: 'Release spot limit order reserve',
      entries: expect.any(Array),
    }, tx);
    assertBalancedLedgerEntries(ledger.postTransaction.mock.calls[0][0].entries);
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { status: OrderStatus.CANCELLED },
      include: { market: true, providerOrder: true },
    });
  });

  it('matches and fills an executable spot limit buy once', async () => {
    const { service, prisma, tx, ledger, marketData } = createSpotHarness();
    const openOrder = {
      id: 'order-1',
      userId: 'user-1',
      marketId: spotMarket.id,
      clientOrderId: 'client-limit-1',
      side: OrderSide.BUY,
      type: OrderType.LIMIT,
      status: OrderStatus.OPEN,
      route: ExecutionRoute.B_BOOK_INTERNAL,
      size: new Prisma.Decimal('2'),
      filledSize: new Prisma.Decimal(0),
      price: new Prisma.Decimal('100'),
      averageFillPrice: null,
      triggerPrice: null,
      leverage: 1,
      reduceOnly: false,
      marginReserved: new Prisma.Decimal('200.1'),
      feeAmount: new Prisma.Decimal('0.1'),
      rejectionReason: null,
      marginLedgerTransactionId: 'ledger-reserve',
      createdAt: new Date(),
      updatedAt: new Date(),
      market: spotMarket,
    };
    prisma.order.findMany.mockResolvedValueOnce([openOrder]);
    marketData.getOrderBook.mockResolvedValueOnce({
      symbol: spotMarket.symbol,
      provider: 'MOCK',
      providerSymbol: 'BTC',
      time: Date.now(),
      bids: [{ price: '98', size: '1', orders: 1 }],
      asks: [{ price: '99', size: '1', orders: 1 }],
    });
    tx.order.findUniqueOrThrow
      .mockResolvedValueOnce(openOrder)
      .mockResolvedValueOnce({
        ...openOrder,
        status: OrderStatus.FILLED,
        filledSize: new Prisma.Decimal('2'),
        averageFillPrice: new Prisma.Decimal('99'),
        providerOrder: null,
        trades: [],
      });

    const matched = await service.matchOpenSpotOrders();

    expect(matched).toHaveLength(1);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: OrderStatus.OPEN },
      data: { status: OrderStatus.ROUTED },
    });
    const tradePosting = ledger.postTransaction.mock.calls[0][0];
    const feePosting = ledger.postTransaction.mock.calls[1][0];
    const releasePosting = ledger.postTransaction.mock.calls[2][0];
    expect(tradePosting.type).toBe(LedgerTransactionType.SPOT_TRADE);
    expect(feePosting.type).toBe(LedgerTransactionType.TRADING_FEE);
    expect(releasePosting.type).toBe(LedgerTransactionType.SPOT_RELEASE);
    expect(releasePosting.entries[0].amount.toString()).toBe('2.001');
    assertBalancedLedgerEntries(tradePosting.entries);
    assertBalancedLedgerEntries(feePosting.entries);
    assertBalancedLedgerEntries(releasePosting.entries);
    expect(tx.trade.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        price: expect.objectContaining({ s: 1 }),
        feeAmount: expect.objectContaining({ s: 1 }),
      }),
    });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: expect.objectContaining({
        status: OrderStatus.FILLED,
        feeAmount: expect.objectContaining({ s: 1 }),
      }),
    });
  });

  it('does not duplicate-fill a spot limit order already claimed elsewhere', async () => {
    const { service, prisma, tx, ledger } = createSpotHarness();
    const openOrder = {
      id: 'order-1',
      side: OrderSide.BUY,
      type: OrderType.LIMIT,
      status: OrderStatus.OPEN,
      size: new Prisma.Decimal('2'),
      price: new Prisma.Decimal('100'),
      market: spotMarket,
      createdAt: new Date(),
    };
    prisma.order.findMany.mockResolvedValueOnce([openOrder]);
    tx.order.updateMany.mockResolvedValueOnce({ count: 0 });

    const matched = await service.matchOpenSpotOrders();

    expect(matched).toHaveLength(0);
    expect(ledger.postTransaction).not.toHaveBeenCalled();
    expect(tx.trade.create).not.toHaveBeenCalled();
  });

  it('rejects unsupported spot trigger orders', async () => {
    const { service } = createSpotHarness();

    await expect(service.createOrder('user-1', {
      symbol: 'BTC-USDC',
      clientOrderId: 'client-stop-1',
      side: OrderSide.BUY,
      type: OrderType.STOP_LOSS,
      size: '2',
      triggerPrice: '89',
    })).rejects.toThrow('Trigger price is not supported for spot orders');
  });

  it('does not create a spot order when balance assertion fails', async () => {
    const { service, tx, ledger } = createSpotHarness();
    ledger.assertSufficientUserSpotBalance.mockRejectedValueOnce(
      new Error('Insufficient available balance'),
    );

    await expect(service.createOrder('user-1', {
      symbol: 'BTC-USDC',
      clientOrderId: 'client-buy-2',
      side: OrderSide.BUY,
      type: OrderType.MARKET,
      size: '2',
    })).rejects.toThrow('Insufficient available balance');

    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate client order ids before creating another order', async () => {
    const { service, prisma, markets } = createSpotHarness();
    prisma.order.findUnique.mockResolvedValueOnce({ id: 'existing-order' });

    await expect(service.createOrder('user-1', {
      symbol: 'BTC-USDC',
      clientOrderId: 'client-buy-1',
      side: OrderSide.BUY,
      type: OrderType.MARKET,
      size: '2',
    })).rejects.toThrow('Duplicate client order id');

    expect(markets.getBySymbol).not.toHaveBeenCalled();
  });
});

describe('OrdersService perp trigger orders', () => {
  const perpMarket = {
    id: 'market-btc-perp',
    symbol: 'BTC-PERP',
    type: MarketType.PERP,
    status: MarketStatus.ACTIVE,
    baseAssetId: 'asset-btc',
    quoteAssetId: 'asset-usdc',
    pricePrecision: 1,
    sizePrecision: 5,
    minOrderSize: new Prisma.Decimal('0.00001'),
    providerName: null,
    providerSymbol: null,
    tradingViewSymbol: null,
    orderbookEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    baseAsset: {},
    quoteAsset: {},
  };
  const longPosition = {
    id: 'position-1',
    userId: 'user-1',
    marketId: perpMarket.id,
    side: PositionSide.LONG,
    status: PositionStatus.OPEN,
    route: ExecutionRoute.B_BOOK_INTERNAL,
    marginMode: 'ISOLATED',
    size: new Prisma.Decimal('2'),
    entryPrice: new Prisma.Decimal('100'),
    markPrice: new Prisma.Decimal('100'),
    leverage: 5,
    margin: new Prisma.Decimal('40'),
    maintenanceMargin: new Prisma.Decimal('1'),
    liquidationPrice: new Prisma.Decimal('81'),
    unrealizedPnl: new Prisma.Decimal(0),
    realizedPnl: new Prisma.Decimal(0),
    fundingPaid: new Prisma.Decimal(0),
    providerPositionRef: null,
    openedAt: new Date(),
    closedAt: null,
    updatedAt: new Date(),
  };

  function createPerpHarness(
    position: (Omit<typeof longPosition, 'route'> & { route: ExecutionRoute }) | null = longPosition,
  ) {
    const tx = {
      order: {
        create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
          id: 'order-trigger-1',
          ...data,
        })),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'order-trigger-1',
          status: OrderStatus.OPEN,
          market: perpMarket,
          providerOrder: null,
          trades: [],
        }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      position: {
        findFirst: jest.fn().mockResolvedValue(position),
        update: jest.fn(),
      },
      trade: {
        create: jest.fn(),
      },
      bBookExposure: {
        upsert: jest.fn().mockResolvedValue({
          marketId: perpMarket.id,
          longNotional: new Prisma.Decimal('200'),
          shortNotional: new Prisma.Decimal(0),
          netNotional: new Prisma.Decimal('200'),
          unrealizedPlatformPnl: new Prisma.Decimal(0),
          updatedAt: new Date(),
        }),
        update: jest.fn(),
      },
      liquidationEvent: {
        update: jest.fn(),
      },
    };
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      position: {
        findFirst: jest.fn().mockResolvedValue(position),
      },
      riskConfig: {
        upsert: jest.fn().mockResolvedValue({
          marketId: perpMarket.id,
          maxLeverage: 10,
          maxMarkAgeMs: 2_000,
          maintenanceMarginRate: new Prisma.Decimal('0.005'),
        }),
      },
      feeConfig: {
        upsert: jest.fn().mockResolvedValue({
          marketId: perpMarket.id,
          takerFeeBps: 5,
        }),
      },
      $transaction: jest.fn(
        async (
          callback: (client: typeof tx) => Promise<unknown>,
          _options?: unknown,
        ) => callback(tx),
      ),
    };
    const markets = {
      getBySymbol: jest.fn().mockResolvedValue(perpMarket),
    };
    const marketData = {
      getOrderBook: jest.fn().mockResolvedValue({
        symbol: perpMarket.symbol,
        provider: 'MOCK',
        providerSymbol: 'BTC',
        time: Date.now(),
        bids: [{ price: '89', size: '1', orders: 1 }],
        asks: [{ price: '91', size: '1', orders: 1 }],
      }),
    };
    const ledger = {
      assertSufficientUserSpotBalance: jest.fn(),
      postTransaction: jest.fn().mockResolvedValue({ id: 'ledger-1' }),
    };
    const service = new OrdersService(
      prisma as unknown as PrismaService,
      { get: jest.fn((_key: string, fallback: unknown) => fallback) } as unknown as ConfigService,
      markets as unknown as MarketsService,
      marketData as unknown as MarketDataService,
      {} as RoutingService,
      ledger as unknown as LedgerService,
      {} as HyperliquidExecutionService,
      { getBoolean: jest.fn().mockResolvedValue(false) } as unknown as OperationalSettingsService,
    );

    return { service, prisma, tx, marketData, ledger };
  }

  it('creates a reduce-only stop-loss as an open trigger order', async () => {
    const { service, tx, ledger } = createPerpHarness();

    await service.createOrder('user-1', {
      symbol: 'BTC-PERP',
      clientOrderId: 'sl-1',
      side: OrderSide.SELL,
      type: OrderType.STOP_LOSS,
      size: '1',
      leverage: 5,
      reduceOnly: true,
      triggerPrice: '89',
    });

    expect(tx.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: OrderStatus.OPEN,
        route: ExecutionRoute.B_BOOK_INTERNAL,
        reduceOnly: true,
        triggerPrice: expect.anything(),
        marginReserved: 0,
        feeAmount: expect.anything(),
      }),
    });
    expect(ledger.postTransaction).not.toHaveBeenCalled();
    expect(tx.trade.create).not.toHaveBeenCalled();
  });

  it('creates a full-size A-book stop-loss as an internal open trigger', async () => {
    const aBookPosition = {
      ...longPosition,
      route: ExecutionRoute.A_BOOK_HYPERLIQUID,
    };
    const { service, tx } = createPerpHarness(aBookPosition);

    await service.createOrder('user-1', {
      symbol: 'BTC-PERP',
      clientOrderId: 'sl-a-1',
      side: OrderSide.SELL,
      type: OrderType.STOP_LOSS,
      size: '2',
      leverage: 5,
      reduceOnly: true,
      triggerPrice: '89',
    });

    expect(tx.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: OrderStatus.OPEN,
        route: ExecutionRoute.A_BOOK_HYPERLIQUID,
        reduceOnly: true,
        marginReserved: 0,
        feeAmount: expect.objectContaining({ s: 1 }),
      }),
    });
  });

  it('rejects a partial-size A-book trigger order', async () => {
    const aBookPosition = {
      ...longPosition,
      route: ExecutionRoute.A_BOOK_HYPERLIQUID,
    };
    const { service } = createPerpHarness(aBookPosition);

    await expect(service.createOrder('user-1', {
      symbol: 'BTC-PERP',
      clientOrderId: 'sl-a-2',
      side: OrderSide.SELL,
      type: OrderType.STOP_LOSS,
      size: '1',
      leverage: 5,
      reduceOnly: true,
      triggerPrice: '89',
    })).rejects.toThrow('A-book TP/SL must cover the full open position');
  });

  it('rejects a trigger order without an open position', async () => {
    const { service, prisma } = createPerpHarness(null);
    prisma.position.findFirst.mockResolvedValueOnce(null);

    await expect(service.createOrder('user-1', {
      symbol: 'BTC-PERP',
      clientOrderId: 'sl-2',
      side: OrderSide.SELL,
      type: OrderType.STOP_LOSS,
      size: '1',
      reduceOnly: true,
      triggerPrice: '90',
    })).rejects.toThrow('Trigger order requires an open position');
  });

  it('rejects a trigger order with the wrong closing side', async () => {
    const { service } = createPerpHarness();

    await expect(service.createOrder('user-1', {
      symbol: 'BTC-PERP',
      clientOrderId: 'sl-3',
      side: OrderSide.BUY,
      type: OrderType.STOP_LOSS,
      size: '1',
      reduceOnly: true,
      triggerPrice: '90',
    })).rejects.toThrow('Trigger order side must close the open position');
  });

  it('rejects a trigger order larger than the open position', async () => {
    const { service } = createPerpHarness();

    await expect(service.createOrder('user-1', {
      symbol: 'BTC-PERP',
      clientOrderId: 'sl-4',
      side: OrderSide.SELL,
      type: OrderType.STOP_LOSS,
      size: '3',
      reduceOnly: true,
      triggerPrice: '90',
    })).rejects.toThrow('Trigger order size exceeds open position');
  });

  it('matches and fills a triggered stop-loss once', async () => {
    const { service, prisma, tx, ledger } = createPerpHarness();
    const openOrder = {
      id: 'order-trigger-1',
      userId: 'user-1',
      marketId: perpMarket.id,
      side: OrderSide.SELL,
      type: OrderType.STOP_LOSS,
      status: OrderStatus.OPEN,
      route: ExecutionRoute.B_BOOK_INTERNAL,
      size: new Prisma.Decimal('1'),
      filledSize: new Prisma.Decimal(0),
      price: null,
      averageFillPrice: null,
      triggerPrice: new Prisma.Decimal('90'),
      leverage: 5,
      reduceOnly: true,
      marginReserved: new Prisma.Decimal(0),
      feeAmount: new Prisma.Decimal(0),
      rejectionReason: null,
      marginLedgerTransactionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      market: perpMarket,
    };
    prisma.order.findMany.mockResolvedValueOnce([openOrder]);
    tx.order.findUniqueOrThrow
      .mockResolvedValueOnce(openOrder)
      .mockResolvedValueOnce({
        ...openOrder,
        status: OrderStatus.FILLED,
        filledSize: new Prisma.Decimal('1'),
        averageFillPrice: new Prisma.Decimal('90'),
        providerOrder: null,
        trades: [],
      });

    const matched = await service.matchOpenPerpTriggerOrders();

    expect(matched).toHaveLength(1);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-trigger-1', status: OrderStatus.OPEN },
      data: { status: OrderStatus.ROUTED },
    });
    expect(ledger.postTransaction).toHaveBeenCalledWith({
      type: LedgerTransactionType.TRADE_PNL,
      idempotencyKey: 'position-close:order-trigger-1',
      entries: expect.any(Array),
    }, tx);
    assertBalancedLedgerEntries(ledger.postTransaction.mock.calls[0][0].entries);
    expect(tx.trade.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-trigger-1',
        side: OrderSide.SELL,
      }),
    });
  });

  it('does not duplicate-fill a trigger order already claimed elsewhere', async () => {
    const { service, prisma, tx, ledger } = createPerpHarness();
    prisma.order.findMany.mockResolvedValueOnce([{
      id: 'order-trigger-1',
      userId: 'user-1',
      marketId: perpMarket.id,
      side: OrderSide.SELL,
      type: OrderType.STOP_LOSS,
      status: OrderStatus.OPEN,
      size: new Prisma.Decimal('1'),
      triggerPrice: new Prisma.Decimal('90'),
      market: perpMarket,
    }]);
    tx.order.updateMany.mockResolvedValueOnce({ count: 0 });

    const matched = await service.matchOpenPerpTriggerOrders();

    expect(matched).toHaveLength(0);
    expect(ledger.postTransaction).not.toHaveBeenCalled();
    expect(tx.trade.create).not.toHaveBeenCalled();
  });
});
