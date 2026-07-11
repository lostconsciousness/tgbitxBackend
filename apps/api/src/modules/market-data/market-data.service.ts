import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { MarketsService } from '../markets/markets.service';
import { HyperliquidMarketDataProvider } from './hyperliquid-market-data.provider';
import { MockMarketDataProvider } from './mock-market-data.provider';
import { OrderBookSnapshot } from './types/orderbook.types';
import { MarketDataUnavailableException } from './market-data.errors';

const CANDLE_INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};
const DEFAULT_CANDLE_INTERVAL_MS = 60_000;

@Injectable()
export class MarketDataService {
  constructor(
    private readonly mockProvider: MockMarketDataProvider,
    private readonly hyperliquidProvider: HyperliquidMarketDataProvider,
    private readonly marketsService: MarketsService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async getOrderBook(symbol: string): Promise<OrderBookSnapshot> {
    if (this.config.get<string>('MARKET_DATA_PROVIDER', 'MOCK') !== 'HYPERLIQUID') {
      return this.mockProvider.getOrderBook(symbol);
    }
    const market = await this.marketsService.getBySymbol(symbol);
    if (!market.orderbookEnabled || !market.providerSymbol) {
      if (
        market.type === MarketType.PERP &&
        this.config.get<boolean>('HYPERLIQUID_EXECUTION_ENABLED', false)
      ) {
        throw new MarketDataUnavailableException('Hyperliquid PERP market mapping is missing');
      }
      return this.mockProvider.getOrderBook(market.symbol);
    }
    try {
      return await this.hyperliquidProvider.getOrderBook({
        internalSymbol: market.symbol,
        providerSymbol: market.providerSymbol,
      });
    } catch (error) {
      if (
        market.type === MarketType.PERP &&
        this.config.get<boolean>('HYPERLIQUID_EXECUTION_ENABLED', false)
      ) {
        throw error;
      }
      if (!this.config.get<boolean>('MARKET_DATA_FALLBACK_TO_MOCK', true)) {
        throw error;
      }
      return this.mockProvider.getOrderBook(market.symbol);
    }
  }

  async subscribeOrderBook(input: {
    symbol: string;
    onSnapshot: (snapshot: OrderBookSnapshot) => void;
  }): Promise<() => void> {
    if (this.config.get<string>('MARKET_DATA_PROVIDER', 'MOCK') !== 'HYPERLIQUID') {
      return this.mockProvider.subscribe({
        symbol: input.symbol,
        subscriber: input.onSnapshot,
      });
    }
    const market = await this.marketsService.getBySymbol(input.symbol);
    if (!market.orderbookEnabled || !market.providerSymbol) {
      if (
        market.type === MarketType.PERP &&
        this.config.get<boolean>('HYPERLIQUID_EXECUTION_ENABLED', false)
      ) {
        throw new MarketDataUnavailableException('Hyperliquid PERP market mapping is missing');
      }
      return this.mockProvider.subscribe({
        symbol: market.symbol,
        subscriber: input.onSnapshot,
      });
    }
    return this.hyperliquidProvider.subscribe({
      internalSymbol: market.symbol,
      providerSymbol: market.providerSymbol,
      subscriber: (snapshot) =>
        input.onSnapshot({
          ...snapshot,
          symbol: market.symbol,
        }),
    });
  }

  async getTicker(symbol: string) {
    const book = await this.getOrderBook(symbol);
    const bestBid = book.bids[0];
    const bestAsk = book.asks[0];
    const mid =
      bestBid && bestAsk
        ? new Prisma.Decimal(bestBid.price).plus(bestAsk.price).div(2)
        : null;
    const market = await this.marketsService.getBySymbol(book.symbol);
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const trades = await this.prisma.trade.findMany({
      where: {
        marketId: market.id,
        executedAt: { gte: since },
      },
      orderBy: { executedAt: 'asc' },
    });
    const first = trades[0];
    const last = trades[trades.length - 1];
    const volume24h = trades.reduce(
      (sum, trade) => sum.plus(trade.size),
      new Prisma.Decimal(0),
    );
    const notional24h = trades.reduce(
      (sum, trade) => sum.plus(trade.notional),
      new Prisma.Decimal(0),
    );
    const lastPrice = last?.price ?? mid;
    const priceChange24h =
      first && lastPrice
        ? new Prisma.Decimal(lastPrice).minus(first.price)
        : new Prisma.Decimal(0);
    const priceChangePct24h =
      first && !new Prisma.Decimal(first.price).isZero()
        ? priceChange24h.div(first.price).mul(100)
        : new Prisma.Decimal(0);

    return {
      symbol: market.symbol,
      provider: book.provider,
      providerSymbol: book.providerSymbol,
      time: book.time,
      bestBid: bestBid?.price ?? null,
      bestAsk: bestAsk?.price ?? null,
      markPrice: mid?.toString() ?? null,
      lastPrice: lastPrice?.toString() ?? null,
      priceChange24h: priceChange24h.toString(),
      priceChangePct24h: priceChangePct24h.toString(),
      volume24h: volume24h.toString(),
      notional24h: notional24h.toString(),
    };
  }

  async getTickers() {
    if (this.config.get<string>('MARKET_DATA_PROVIDER', 'MOCK') !== 'HYPERLIQUID') {
      const markets = await this.marketsService.list();
      return Promise.all(markets.map((market) => this.getTicker(market.symbol)));
    }

    const [markets, contexts] = await Promise.all([
      this.marketsService.list(),
      this.hyperliquidProvider.getMarketContexts(),
    ]);

    return markets.flatMap((market) => {
      if (market.type !== MarketType.PERP || !market.providerSymbol) {
        return [];
      }
      const context = contexts.get(market.providerSymbol);
      if (!context) {
        return [];
      }
      const markPrice = new Prisma.Decimal(context.markPx);
      const previousPrice = new Prisma.Decimal(context.prevDayPx);
      const priceChange24h = markPrice.minus(previousPrice);
      const priceChangePct24h = previousPrice.isZero()
        ? new Prisma.Decimal(0)
        : priceChange24h.div(previousPrice).mul(100);

      return [{
        symbol: market.symbol,
        provider: 'HYPERLIQUID',
        providerSymbol: market.providerSymbol,
        time: Date.now(),
        markPrice: markPrice.toString(),
        lastPrice: context.midPx ?? context.markPx,
        priceChange24h: priceChange24h.toString(),
        priceChangePct24h: priceChangePct24h.toString(),
        volume24h: context.dayBaseVlm,
        notional24h: context.dayNtlVlm,
      }];
    });
  }

  async getRecentTrades(symbol: string, take = 50) {
    const market = await this.marketsService.getBySymbol(symbol);
    const trades = await this.prisma.trade.findMany({
      where: { marketId: market.id },
      orderBy: { executedAt: 'desc' },
      take: Math.min(Math.max(take, 1), 200),
    });
    return trades.map((trade) => ({
      id: trade.id,
      symbol: market.symbol,
      side: trade.side,
      route: trade.route,
      price: trade.price.toString(),
      size: trade.size.toString(),
      notional: trade.notional.toString(),
      feeAmount: trade.feeAmount.toString(),
      executedAt: trade.executedAt,
    }));
  }

  async getCandles(
    symbol: string,
    interval = '1m',
    limit = 2_000,
    from?: number,
    to?: number,
  ) {
    const intervalMs = CANDLE_INTERVAL_MS[interval] ?? DEFAULT_CANDLE_INTERVAL_MS;
    const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 2_000;
    const take = Math.min(Math.max(requestedLimit, 1), 5_000);
    const market = await this.marketsService.getBySymbol(symbol);
    const endTime = this.normalizeCandleTimestamp(to) ?? Date.now();
    const startTime = this.normalizeCandleTimestamp(from) ?? endTime - intervalMs * take;
    const since = new Date(Math.min(startTime, endTime));
    if (
      this.config.get<string>('MARKET_DATA_PROVIDER', 'MOCK') === 'HYPERLIQUID' &&
      market.type === MarketType.PERP &&
      market.providerSymbol
    ) {
      const candles = await this.hyperliquidProvider.getCandles({
        providerSymbol: market.providerSymbol,
        interval: CANDLE_INTERVAL_MS[interval] ? interval : '1m',
        startTime: since.getTime(),
        endTime,
      });
      return candles.slice(-take).map((candle) => ({
        symbol: market.symbol,
        interval: candle.i,
        time: candle.t,
        closeTime: candle.T,
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c,
        volume: candle.v,
        trades: candle.n,
        provider: 'HYPERLIQUID',
        providerSymbol: candle.s,
      }));
    }
    const trades = await this.prisma.trade.findMany({
      where: {
        marketId: market.id,
        executedAt: { gte: since },
      },
      orderBy: { executedAt: 'asc' },
    });
    const buckets = new Map<
      number,
      {
        open: Prisma.Decimal;
        high: Prisma.Decimal;
        low: Prisma.Decimal;
        close: Prisma.Decimal;
        volume: Prisma.Decimal;
        notional: Prisma.Decimal;
        trades: number;
      }
    >();

    for (const trade of trades) {
      const bucketTime = Math.floor(trade.executedAt.getTime() / intervalMs) * intervalMs;
      const price = new Prisma.Decimal(trade.price);
      const existing = buckets.get(bucketTime);
      if (!existing) {
        buckets.set(bucketTime, {
          open: price,
          high: price,
          low: price,
          close: price,
          volume: new Prisma.Decimal(trade.size),
          notional: new Prisma.Decimal(trade.notional),
          trades: 1,
        });
        continue;
      }
      existing.high = Prisma.Decimal.max(existing.high, price);
      existing.low = Prisma.Decimal.min(existing.low, price);
      existing.close = price;
      existing.volume = existing.volume.plus(trade.size);
      existing.notional = existing.notional.plus(trade.notional);
      existing.trades += 1;
    }

    return [...buckets.entries()]
      .sort(([left], [right]) => left - right)
      .slice(-take)
      .map(([time, candle]) => ({
        symbol: market.symbol,
        interval,
        time,
        open: candle.open.toString(),
        high: candle.high.toString(),
        low: candle.low.toString(),
        close: candle.close.toString(),
        volume: candle.volume.toString(),
        notional: candle.notional.toString(),
        trades: candle.trades,
      }));
  }

  private normalizeCandleTimestamp(value?: number): number | undefined {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
}
