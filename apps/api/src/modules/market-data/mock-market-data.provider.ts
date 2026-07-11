import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { OrderBookSnapshot } from './types/orderbook.types';

type Subscriber = (snapshot: OrderBookSnapshot) => void;
const ORDER_BOOK_LEVELS = 17;

@Injectable()
export class MockMarketDataProvider implements OnModuleDestroy {
  private readonly midPrices = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  getOrderBook(symbol: string): OrderBookSnapshot {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const midPrice = this.getMidPrice(normalizedSymbol);

    return {
      symbol: normalizedSymbol,
      provider: 'MOCK',
      providerSymbol: this.toProviderSymbol(normalizedSymbol),
      time: Date.now(),
      bids: Array.from({ length: ORDER_BOOK_LEVELS }, (_value, index) => ({
        price: this.formatPrice(midPrice - 1 - index + this.randomBetween(-0.5, 0.5)),
        size: this.formatSize(this.randomBetween(0.01, 5)),
        orders: this.randomInteger(1, 20),
      })).sort((left, right) => Number(right.price) - Number(left.price)),
      asks: Array.from({ length: ORDER_BOOK_LEVELS }, (_value, index) => ({
        price: this.formatPrice(midPrice + 1 + index + this.randomBetween(-0.5, 0.5)),
        size: this.formatSize(this.randomBetween(0.01, 5)),
        orders: this.randomInteger(1, 20),
      })).sort((left, right) => Number(left.price) - Number(right.price)),
    };
  }

  subscribe(input: { symbol: string; subscriber: Subscriber }): () => void {
    const symbol = this.normalizeSymbol(input.symbol);
    const subscribers = this.subscribers.get(symbol) ?? new Set<Subscriber>();
    subscribers.add(input.subscriber);
    this.subscribers.set(symbol, subscribers);

    input.subscriber(this.getOrderBook(symbol));
    this.startTimer(symbol);

    return () => {
      const currentSubscribers = this.subscribers.get(symbol);
      if (!currentSubscribers) {
        return;
      }

      currentSubscribers.delete(input.subscriber);
      if (currentSubscribers.size === 0) {
        this.subscribers.delete(symbol);
        this.stopTimer(symbol);
      }
    };
  }

  onModuleDestroy(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  private startTimer(symbol: string): void {
    if (this.timers.has(symbol)) {
      return;
    }

    const timer = setInterval(() => {
      this.driftMidPrice(symbol);
      this.broadcast(symbol, this.getOrderBook(symbol));
    }, 1_000);
    this.timers.set(symbol, timer);
  }

  private stopTimer(symbol: string): void {
    const timer = this.timers.get(symbol);
    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.timers.delete(symbol);
  }

  private broadcast(symbol: string, snapshot: OrderBookSnapshot): void {
    const subscribers = this.subscribers.get(symbol);
    if (!subscribers) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber(snapshot);
    }
  }

  private getMidPrice(symbol: string): number {
    const existing = this.midPrices.get(symbol);
    if (existing !== undefined) {
      return existing;
    }

    const initial = this.getInitialMidPrice(symbol);
    this.midPrices.set(symbol, initial);
    return initial;
  }

  private driftMidPrice(symbol: string): void {
    const current = this.getMidPrice(symbol);
    const delta = current * this.randomBetween(-0.002, 0.002);
    this.midPrices.set(symbol, Math.max(current + delta, 0.000_001));
  }

  private getInitialMidPrice(symbol: string): number {
    const providerSymbol = this.toProviderSymbol(symbol);
    const prices: Record<string, number> = {
      BTC: 62_800,
      ETH: 3_400,
      SOL: 150,
      BNB: 600,
      AVAX: 35,
      ARB: 1.2,
      WBTC: 62_800,
      WETH: 3_400,
      TRX: 0.25,
      POL: 0.35,
      USDC: 1,
      USDT: 1,
    };

    return prices[providerSymbol] ?? 100;
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.trim().toUpperCase();
  }

  private toProviderSymbol(symbol: string): string {
    return symbol.split('-')[0] ?? symbol;
  }

  private formatPrice(value: number): string {
    return value.toFixed(2);
  }

  private formatSize(value: number): string {
    return value.toFixed(5);
  }

  private randomBetween(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  private randomInteger(min: number, max: number): number {
    return Math.floor(this.randomBetween(min, max + 1));
  }
}
