import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket = require('ws');
import { MarketDataUnavailableException } from './market-data.errors';
import { OrderBookLevel, OrderBookSnapshot } from './types/orderbook.types';

type HyperliquidBookLevel = {
  px: string;
  sz: string;
  n: number;
};

type HyperliquidBook = {
  coin: string;
  time: number;
  levels: [HyperliquidBookLevel[], HyperliquidBookLevel[]];
};

type HyperliquidInfoResponse = HyperliquidBook | {
  error: string;
};

type HyperliquidAssetContext = {
  markPx: string;
  midPx?: string | null;
  prevDayPx: string;
  dayNtlVlm: string;
  dayBaseVlm: string;
};

type HyperliquidMetaAndAssetContexts = [
  { universe: Array<{ name: string }> },
  HyperliquidAssetContext[],
];

type HyperliquidCandle = {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
};

type HyperliquidWsMessage = {
  channel?: string;
  data?: HyperliquidBook;
};

type Subscriber = (snapshot: OrderBookSnapshot) => void;

@Injectable()
export class HyperliquidMarketDataProvider implements OnModuleDestroy {
  private readonly logger = new Logger(HyperliquidMarketDataProvider.name);
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly cache = new Map<string, OrderBookSnapshot>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private isDestroyed = false;

  constructor(private readonly config: ConfigService) {}

  async getOrderBook(input: {
    internalSymbol: string;
    providerSymbol: string;
  }): Promise<OrderBookSnapshot> {
    const response = await this.postInfo<HyperliquidInfoResponse>({
      type: 'l2Book',
      coin: input.providerSymbol,
    });

    if ('error' in response) {
      throw new MarketDataUnavailableException(response.error);
    }

    const snapshot = this.normalizeBook({
      internalSymbol: input.internalSymbol,
      providerSymbol: input.providerSymbol,
      book: response,
    });
    this.cache.set(input.providerSymbol, snapshot);
    return snapshot;
  }

  getCached(providerSymbol: string): OrderBookSnapshot | undefined {
    return this.cache.get(providerSymbol);
  }

  async getMarketContexts(): Promise<Map<string, HyperliquidAssetContext>> {
    const [meta, contexts] = await this.postInfo<HyperliquidMetaAndAssetContexts>({
      type: 'metaAndAssetCtxs',
    });
    return new Map(
      meta.universe.flatMap((asset, index) => {
        const context = contexts[index];
        return context ? [[asset.name, context] as const] : [];
      }),
    );
  }

  getCandles(input: {
    providerSymbol: string;
    interval: string;
    startTime: number;
    endTime: number;
  }): Promise<HyperliquidCandle[]> {
    return this.postInfo<HyperliquidCandle[]>({
      type: 'candleSnapshot',
      req: {
        coin: input.providerSymbol,
        interval: input.interval,
        startTime: input.startTime,
        endTime: input.endTime,
      },
    });
  }

  subscribe(input: {
    internalSymbol: string;
    providerSymbol: string;
    subscriber: Subscriber;
  }): () => void {
    const current = this.subscribers.get(input.providerSymbol) ?? new Set<Subscriber>();
    current.add(input.subscriber);
    this.subscribers.set(input.providerSymbol, current);

    this.ensureSocket();
    this.sendSubscription('subscribe', input.providerSymbol);
    this.startRefreshLoop(input.providerSymbol);

    const cached = this.cache.get(input.providerSymbol);
    if (cached) {
      input.subscriber(cached);
    }

    return () => {
      const subscribers = this.subscribers.get(input.providerSymbol);
      if (!subscribers) {
        return;
      }

      subscribers.delete(input.subscriber);
      if (subscribers.size === 0) {
        this.subscribers.delete(input.providerSymbol);
        this.sendSubscription('unsubscribe', input.providerSymbol);
        this.stopRefreshLoop(input.providerSymbol);
      }
    };
  }

  onModuleDestroy(): void {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    for (const timer of this.refreshTimers.values()) {
      clearInterval(timer);
    }
    this.refreshTimers.clear();
    this.socket?.close();
  }

  private ensureSocket(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.socket = new WebSocket(this.config.getOrThrow<string>('HYPERLIQUID_WS_URL'));

    this.socket.on('open', () => {
      this.reconnectAttempts = 0;
      for (const providerSymbol of this.subscribers.keys()) {
        this.sendSubscription('subscribe', providerSymbol);
      }
    });

    this.socket.on('message', (raw) => {
      this.handleMessage(raw.toString());
    });

    this.socket.on('close', () => {
      this.scheduleReconnect();
    });

    this.socket.on('error', (error) => {
      this.logger.warn(`Hyperliquid websocket error: ${error.message}`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.isDestroyed || this.subscribers.size === 0 || this.reconnectTimer) {
      return;
    }

    const delayMs = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.socket = undefined;
      this.ensureSocket();
    }, delayMs);
  }

  private sendSubscription(method: 'subscribe' | 'unsubscribe', providerSymbol: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(
      JSON.stringify({
        method,
        subscription: {
          type: 'l2Book',
          coin: providerSymbol,
        },
      }),
    );
  }

  private handleMessage(rawMessage: string): void {
    let message: HyperliquidWsMessage;
    try {
      message = JSON.parse(rawMessage) as HyperliquidWsMessage;
    } catch (_error) {
      return;
    }

    if (message.channel !== 'l2Book' || !message.data) {
      return;
    }

    const providerSymbol = message.data.coin;
    const snapshot = this.normalizeBook({
      internalSymbol: providerSymbol,
      providerSymbol,
      book: message.data,
    });

    this.broadcast(providerSymbol, snapshot);
  }

  private startRefreshLoop(providerSymbol: string): void {
    if (this.refreshTimers.has(providerSymbol)) {
      return;
    }

    const refreshMs = this.config.get<number>('ORDERBOOK_REFRESH_MS', 750);
    const timer = setInterval(() => {
      void this.refreshAndBroadcast(providerSymbol);
    }, refreshMs);
    this.refreshTimers.set(providerSymbol, timer);
    void this.refreshAndBroadcast(providerSymbol);
  }

  private stopRefreshLoop(providerSymbol: string): void {
    const timer = this.refreshTimers.get(providerSymbol);
    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.refreshTimers.delete(providerSymbol);
  }

  private async refreshAndBroadcast(providerSymbol: string): Promise<void> {
    if (!this.subscribers.has(providerSymbol)) {
      this.stopRefreshLoop(providerSymbol);
      return;
    }

    try {
      const snapshot = await this.getOrderBook({
        internalSymbol: providerSymbol,
        providerSymbol,
      });
      this.broadcast(providerSymbol, snapshot);
    } catch (error) {
      this.logger.warn(
        `Failed to refresh ${providerSymbol} order book: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private broadcast(providerSymbol: string, snapshot: OrderBookSnapshot): void {
    this.cache.set(providerSymbol, snapshot);
    const subscribers = this.subscribers.get(providerSymbol);
    if (!subscribers) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber(snapshot);
    }
  }

  private normalizeBook(input: {
    internalSymbol: string;
    providerSymbol: string;
    book: HyperliquidBook;
  }): OrderBookSnapshot {
    const maxLevels = this.config.get<number>('ORDERBOOK_MAX_LEVELS', 25);
    return {
      symbol: input.internalSymbol,
      provider: 'HYPERLIQUID',
      providerSymbol: input.providerSymbol,
      time: input.book.time,
      bids: this.normalizeLevels(input.book.levels[0], maxLevels),
      asks: this.normalizeLevels(input.book.levels[1], maxLevels),
    };
  }

  private normalizeLevels(levels: HyperliquidBookLevel[], maxLevels: number): OrderBookLevel[] {
    return levels.slice(0, maxLevels).map((level) => ({
      price: level.px,
      size: level.sz,
      orders: level.n,
    }));
  }

  private async postInfo<T>(body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const response = await fetch(this.config.getOrThrow<string>('HYPERLIQUID_INFO_URL'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new MarketDataUnavailableException(`Hyperliquid returned HTTP ${response.status}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof MarketDataUnavailableException) {
        throw error;
      }
      throw new MarketDataUnavailableException(
        error instanceof Error ? error.message : 'Hyperliquid request failed',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
