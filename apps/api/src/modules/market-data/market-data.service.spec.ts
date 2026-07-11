import { MockMarketDataProvider } from './mock-market-data.provider';
import { MarketDataService } from './market-data.service';
import { ConfigService } from '@nestjs/config';
import { HyperliquidMarketDataProvider } from './hyperliquid-market-data.provider';
import { MarketsService } from '../markets/markets.service';
import { PrismaService } from '../../database/prisma.service';
import { MarketType } from '@prisma/client';

describe('MarketDataService', () => {
  let provider: MockMarketDataProvider;
  let service: MarketDataService;

  beforeEach(() => {
    provider = new MockMarketDataProvider();
    service = new MarketDataService(
      provider,
      {} as HyperliquidMarketDataProvider,
      {} as MarketsService,
      {
        get: jest.fn().mockReturnValue('MOCK'),
      } as unknown as ConfigService,
      {} as PrismaService,
    );
  });

  afterEach(() => {
    provider.onModuleDestroy();
  });

  it('returns order book data matching the frontend contract', async () => {
    const book = await service.getOrderBook('btc-perp');

    expect(book.symbol).toBe('BTC-PERP');
    expect(book.provider).toBe('MOCK');
    expect(book.providerSymbol).toBe('BTC');
    expect(typeof book.time).toBe('number');
    expect(book.bids).toHaveLength(17);
    expect(book.asks).toHaveLength(17);

    for (const entry of [...book.bids, ...book.asks]) {
      expect(entry.price).toMatch(/^\d+\.\d{2}$/);
      expect(entry.size).toMatch(/^\d+\.\d{5}$/);
      expect(entry.orders).toBeGreaterThanOrEqual(1);
      expect(entry.orders).toBeLessThanOrEqual(20);
    }
  });

  it('sorts bids descending and asks ascending', async () => {
    const book = await service.getOrderBook('BTC-PERP');

    const bidPrices = book.bids.map((entry) => Number(entry.price));
    const askPrices = book.asks.map((entry) => Number(entry.price));

    expect(bidPrices).toEqual([...bidPrices].sort((left, right) => right - left));
    expect(askPrices).toEqual([...askPrices].sort((left, right) => left - right));
  });

  it('subscribes to mock order book updates and returns an unsubscribe function', async () => {
    const onSnapshot = jest.fn();

    const unsubscribe = await service.subscribeOrderBook({
      symbol: 'BTC-PERP',
      onSnapshot,
    });

    expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTC-PERP',
        provider: 'MOCK',
        providerSymbol: 'BTC',
      }),
    );

    unsubscribe();
  });

  it('returns all Hyperliquid tickers from one provider context request', async () => {
    const hyperliquid = {
      getMarketContexts: jest.fn().mockResolvedValue(new Map([
        ['BTC', {
          markPx: '60000',
          midPx: '60001',
          prevDayPx: '59000',
          dayNtlVlm: '1234567',
          dayBaseVlm: '20.5',
        }],
      ])),
    };
    const markets = {
      list: jest.fn().mockResolvedValue([
        { symbol: 'BTC-PERP', type: MarketType.PERP, providerSymbol: 'BTC' },
        { symbol: 'BTC-USDC', type: MarketType.SPOT, providerSymbol: null },
      ]),
    };
    const hyperliquidService = new MarketDataService(
      provider,
      hyperliquid as unknown as HyperliquidMarketDataProvider,
      markets as unknown as MarketsService,
      { get: jest.fn().mockReturnValue('HYPERLIQUID') } as unknown as ConfigService,
      {} as PrismaService,
    );

    await expect(hyperliquidService.getTickers()).resolves.toEqual([
      expect.objectContaining({
        symbol: 'BTC-PERP',
        markPrice: '60000',
        lastPrice: '60001',
        priceChange24h: '1000',
        volume24h: '20.5',
        notional24h: '1234567',
      }),
    ]);
    expect(hyperliquid.getMarketContexts).toHaveBeenCalledTimes(1);
  });

  it('uses Hyperliquid candles for a configured perpetual market', async () => {
    const hyperliquid = {
      getCandles: jest.fn().mockResolvedValue([{
        t: 1_000,
        T: 60_999,
        s: 'FIL',
        i: '1m',
        o: '1.50',
        h: '1.55',
        l: '1.49',
        c: '1.53',
        v: '100',
        n: 12,
      }]),
    };
    const markets = {
      getBySymbol: jest.fn().mockResolvedValue({
        symbol: 'FIL-PERP',
        type: MarketType.PERP,
        providerSymbol: 'FIL',
      }),
    };
    const hyperliquidService = new MarketDataService(
      provider,
      hyperliquid as unknown as HyperliquidMarketDataProvider,
      markets as unknown as MarketsService,
      { get: jest.fn().mockReturnValue('HYPERLIQUID') } as unknown as ConfigService,
      {} as PrismaService,
    );

    await expect(hyperliquidService.getCandles('FIL-PERP', '1m', 100)).resolves.toEqual([{
      symbol: 'FIL-PERP',
      interval: '1m',
      time: 1_000,
      closeTime: 60_999,
      open: '1.50',
      high: '1.55',
      low: '1.49',
      close: '1.53',
      volume: '100',
      trades: 12,
      provider: 'HYPERLIQUID',
      providerSymbol: 'FIL',
    }]);
    expect(hyperliquid.getCandles).toHaveBeenCalledWith(expect.objectContaining({
      providerSymbol: 'FIL',
      interval: '1m',
    }));
  });

  it('supports up to 5000 candles and TradingView timestamps in seconds', async () => {
    const hyperliquid = { getCandles: jest.fn().mockResolvedValue([]) };
    const markets = {
      getBySymbol: jest.fn().mockResolvedValue({
        symbol: 'BTC-PERP',
        type: MarketType.PERP,
        providerSymbol: 'BTC',
      }),
    };
    const hyperliquidService = new MarketDataService(
      provider,
      hyperliquid as unknown as HyperliquidMarketDataProvider,
      markets as unknown as MarketsService,
      { get: jest.fn().mockReturnValue('HYPERLIQUID') } as unknown as ConfigService,
      {} as PrismaService,
    );

    await hyperliquidService.getCandles('BTC-PERP', '1h', 10_000, 1_700_000_000, 1_700_003_600);

    expect(hyperliquid.getCandles).toHaveBeenCalledWith({
      providerSymbol: 'BTC',
      interval: '1h',
      startTime: 1_700_000_000_000,
      endTime: 1_700_003_600_000,
    });
  });
});
