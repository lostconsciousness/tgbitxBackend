import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversionProvider, Prisma, TokenStandard } from '@prisma/client';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { PrismaService } from '../../database/prisma.service';
import { OneInchSwapProviderService } from '../spot/one-inch-swap-provider.service';
import { ConvertService } from './convert.service';

const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ONEINCH_EVM_NETWORKS = new Map<string, number>([
  ['arbitrum', 42161],
  ['base', 8453],
  ['optimism', 10],
  ['polygon', 137],
  ['bnb', 56],
  ['avalanche', 43114],
  ['ethereum', 1],
  ['zksync', 324],
  ['linea', 59144],
]);

export type ConvertOrderBookLevel = {
  price: string;
  size: string;
  total: string;
};

export type ConvertOrderBookSnapshot = {
  symbol: string;
  provider: 'ONEINCH_AGGREGATED';
  indicative: true;
  quality: 'REFERENCE_SEED' | 'ONEINCH_QUOTED';
  network: string;
  bids: ConvertOrderBookLevel[];
  asks: ConvertOrderBookLevel[];
  spreadBps: number;
  time: number;
};

type CachedBook = {
  expiresAt: number;
  value: ConvertOrderBookSnapshot;
};

/**
 * Indicative Spot liquidity ladder built from a small series of 1inch exact-input
 * quotes. Cached aggressively because the shared 1inch client is ~1 RPS.
 */
@Injectable()
export class ConvertOrderbookService {
  private readonly logger = new Logger(ConvertOrderbookService.name);
  private readonly cache = new Map<string, CachedBook>();
  private readonly inflight = new Map<string, Promise<ConvertOrderBookSnapshot>>();
  private readonly pairCache = new Map<string, any>();
  private readonly liveRouteCache = new Map<string, {
    chainId: number;
    fromToken: string;
    toToken: string;
    fromDecimals: number;
    toDecimals: number;
  }>();
  private readonly listeners = new Map<string, Set<(snapshot: ConvertOrderBookSnapshot) => void>>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly oneInch: OneInchSwapProviderService,
    private readonly convert: ConvertService,
  ) {}

  async getOrderBook(pairInput: string): Promise<ConvertOrderBookSnapshot> {
    const symbol = this.normalizePair(pairInput);
    const cached = this.cache.get(symbol);
    if (cached) {
      if (cached.expiresAt <= Date.now()) {
        void this.refresh(symbol).catch((error) => {
          this.logger.warn(`convert orderbook background refresh failed for ${symbol}: ${this.safeError(error)}`);
        });
      }
      return cached.value;
    }
    const seed = await this.buildSeed(symbol);
    this.cache.set(symbol, {
      value: seed,
      expiresAt: Date.now() + Math.min(3_000, this.cacheTtlMs()),
    });
    const calibrationTimer = setTimeout(() => {
      void this.refresh(symbol).catch((error) => {
        this.logger.warn(`convert orderbook initial quote refresh failed for ${symbol}: ${this.safeError(error)}`);
      });
    }, this.streamIntervalMs() * 2);
    calibrationTimer.unref();
    return seed;
  }

  subscribe(pairInput: string, onSnapshot: (snapshot: ConvertOrderBookSnapshot) => void): () => void {
    const symbol = this.normalizePair(pairInput);
    const set = this.listeners.get(symbol) ?? new Set();
    set.add(onSnapshot);
    this.listeners.set(symbol, set);

    void this.getOrderBook(symbol)
      .then((snapshot) => onSnapshot(snapshot))
      .catch((error) => {
        this.logger.warn(`convert orderbook seed failed for ${symbol}: ${this.safeError(error)}`);
      });

    if (!this.refreshTimers.has(symbol)) {
      const intervalMs = this.streamIntervalMs();
      const timer = setInterval(() => {
        void this.refreshLive(symbol)
          .then((snapshot) => this.emit(symbol, snapshot))
          .catch((error) => {
            this.logger.warn(`convert orderbook live refresh failed for ${symbol}: ${this.safeError(error)}`);
          });
      }, intervalMs);
      this.refreshTimers.set(symbol, timer);
    }

    return () => {
      const current = this.listeners.get(symbol);
      if (!current) return;
      current.delete(onSnapshot);
      if (current.size === 0) {
        this.listeners.delete(symbol);
        const timer = this.refreshTimers.get(symbol);
        if (timer) {
          clearInterval(timer);
          this.refreshTimers.delete(symbol);
        }
      }
    };
  }

  private emit(symbol: string, snapshot: ConvertOrderBookSnapshot) {
    const set = this.listeners.get(symbol);
    if (!set) return;
    for (const listener of set) listener(snapshot);
  }

  private async refresh(symbol: string): Promise<ConvertOrderBookSnapshot> {
    const existing = this.inflight.get(symbol);
    if (existing) return existing;

    const promise = this.buildQuoted(symbol)
      .then((value) => {
        this.cache.set(symbol, { value, expiresAt: Date.now() + this.cacheTtlMs() });
        this.emit(symbol, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(symbol);
      });
    this.inflight.set(symbol, promise);
    return promise;
  }

  private async refreshLive(symbol: string): Promise<ConvertOrderBookSnapshot> {
    let cached = this.cache.get(symbol);
    if (!cached) {
      const seed = await this.buildSeed(symbol);
      cached = {
        value: seed,
        expiresAt: Date.now() + Math.min(3_000, this.cacheTtlMs()),
      };
      this.cache.set(symbol, cached);
    }

    const live = await this.buildLive(symbol, cached.value);
    this.cache.set(symbol, { value: live, expiresAt: cached.expiresAt });
    if (cached.expiresAt <= Date.now()) {
      void this.refresh(symbol).catch((error) => {
        this.logger.warn(`convert orderbook quote calibration failed for ${symbol}: ${this.safeError(error)}`);
      });
    }
    return live;
  }

  private async buildLive(
    symbol: string,
    current: ConvertOrderBookSnapshot,
  ): Promise<ConvertOrderBookSnapshot> {
    const pair = await this.loadCatalogPair(symbol);
    let route = this.liveRouteCache.get(symbol);
    if (!route) {
      const [baseAsset, quoteAsset] = await Promise.all([
        this.loadAsset(pair.baseAsset),
        this.loadAsset(pair.quoteAsset),
      ]);
      route = this.routeForNetwork(quoteAsset, baseAsset, pair.preferredNetwork) ?? undefined;
      if (route) this.liveRouteCache.set(symbol, route);
    }
    if (!route) return current;

    const prices = await this.oneInch.getSpotPrices(route.chainId);
    const normalized = Object.fromEntries(
      Object.entries(prices).map(([address, price]) => [address.toLowerCase(), price]),
    );
    const basePrice = normalized[route.toToken.toLowerCase()];
    const quotePrice = normalized[route.fromToken.toLowerCase()];
    if (!basePrice || !quotePrice) return current;
    const liveMid = new Prisma.Decimal(basePrice).div(quotePrice);
    const currentBestAsk = current.asks[0] ? new Prisma.Decimal(current.asks[0].price) : liveMid;
    const currentBestBid = current.bids[0] ? new Prisma.Decimal(current.bids[0].price) : liveMid;
    const currentMid = currentBestAsk.plus(currentBestBid).div(2);
    if (!liveMid.isPositive() || !currentMid.isPositive()) return current;
    const scale = liveMid.div(currentMid);

    return {
      ...current,
      bids: this.scaleLevels(current.bids, scale),
      asks: this.scaleLevels(current.asks, scale),
      time: Date.now(),
    };
  }

  private scaleLevels(
    levels: ConvertOrderBookLevel[],
    scale: Prisma.Decimal,
  ): ConvertOrderBookLevel[] {
    let runningTotal = new Prisma.Decimal(0);
    return levels.map((level) => {
      const price = new Prisma.Decimal(level.price).mul(scale);
      const size = new Prisma.Decimal(level.size);
      runningTotal = runningTotal.plus(price.mul(size));
      return {
        price: this.formatPrice(price),
        size: level.size,
        total: runningTotal.toFixed(2),
      };
    });
  }

  private async buildSeed(symbol: string): Promise<ConvertOrderBookSnapshot> {
    const pair = await this.loadCatalogPair(symbol);
    const mid = new Prisma.Decimal(pair.ticker.lastPrice);
    if (!mid.isFinite() || mid.lessThanOrEqualTo(0)) {
      throw new ServiceUnavailableException(`Spot price is unavailable for ${symbol}`);
    }
    const { bids, asks } = this.referenceSeedLadder(mid);
    return {
      symbol,
      provider: 'ONEINCH_AGGREGATED',
      indicative: true,
      quality: 'REFERENCE_SEED',
      network: pair.preferredNetwork,
      bids,
      asks,
      spreadBps: this.calculateSpreadBps(bids, asks),
      time: Date.now(),
    };
  }

  private async buildQuoted(symbol: string): Promise<ConvertOrderBookSnapshot> {
    const pair = await this.loadCatalogPair(symbol);
    const [baseAsset, quoteAsset] = await Promise.all([
      this.loadAsset(pair.baseAsset),
      this.loadAsset(pair.quoteAsset),
    ]);

    const network = pair.preferredNetwork;
    const buyRoute = this.routeForNetwork(quoteAsset, baseAsset, network);
    const sellRoute = this.routeForNetwork(baseAsset, quoteAsset, network);
    if (!buyRoute || !sellRoute) {
      throw new ServiceUnavailableException(`No verified 1inch route for ${symbol} on ${network}`);
    }

    // Three cumulative anchor quotes per side preserve the real 1inch depth
    // curve. They are expanded locally into enough incremental display levels
    // to fill a desktop book without increasing provider traffic.
    const quoteNotionals = this.notionalLadder();
    const askAnchors: ConvertOrderBookLevel[] = [];
    for (const notional of quoteNotionals) {
      const level = await this.quoteLevel({
        fromRoute: buyRoute,
        fromAmount: notional,
        side: 'ask',
      });
      if (level) askAnchors.push(level);
    }

    const referenceMid = new Prisma.Decimal(pair.ticker.lastPrice);
    const midAsk = askAnchors[0]
      ? new Prisma.Decimal(askAnchors[0].price)
      : referenceMid;
    const bidAnchors: ConvertOrderBookLevel[] = [];
    for (const notional of quoteNotionals) {
      const baseSize = midAsk.greaterThan(0)
        ? new Prisma.Decimal(notional).div(midAsk)
        : new Prisma.Decimal(notional).div(100);
      const level = await this.quoteLevel({
        fromRoute: sellRoute,
        fromAmount: baseSize,
        side: 'bid',
      });
      if (level) bidAnchors.push(level);
    }

    const asks = this.expandCumulativeAnchors(askAnchors, 'ask');
    const bids = this.expandCumulativeAnchors(bidAnchors, 'bid');

    return {
      symbol,
      provider: 'ONEINCH_AGGREGATED',
      indicative: true,
      quality: 'ONEINCH_QUOTED',
      network,
      bids,
      asks,
      spreadBps: this.calculateSpreadBps(bids, asks),
      time: Date.now(),
    };
  }

  private async loadCatalogPair(symbol: string) {
    const cached = this.pairCache.get(symbol);
    if (cached) return cached;
    if (!this.config.get<boolean>('CONVERT_ENABLED', false)) {
      throw new ServiceUnavailableException('Conversion is disabled');
    }
    if (!this.config.get<boolean>('CONVERT_EVM_ENABLED', false) || !this.oneInch.getStatus().enabled) {
      throw new ServiceUnavailableException('1inch Spot liquidity is unavailable');
    }

    const catalog = await this.convert.listSpotCatalog();
    const pair = catalog.pairs.find((item) => item.symbol === symbol);
    if (!pair) {
      throw new NotFoundException(`Spot pair ${symbol} is not in the convert catalog`);
    }
    if (pair.provider !== ConversionProvider.ONEINCH) {
      throw new BadRequestException(`${symbol} does not use 1inch aggregated liquidity`);
    }
    this.pairCache.set(symbol, pair);
    return pair;
  }

  private async quoteLevel(input: {
    fromRoute: {
      chainId: number;
      fromToken: string;
      toToken: string;
      fromDecimals: number;
      toDecimals: number;
    };
    fromAmount: Prisma.Decimal;
    side: 'ask' | 'bid';
  }): Promise<ConvertOrderBookLevel | null> {
    if (input.fromAmount.lessThanOrEqualTo(0)) return null;
    try {
      const fromRaw = parseUnits(
        input.fromAmount.toFixed(Math.min(8, input.fromRoute.fromDecimals)),
        input.fromRoute.fromDecimals,
      );
      if (fromRaw <= 0n) return null;
      const response = await this.oneInch.quoteExactInput({
        fromTokenAddress: input.fromRoute.fromToken,
        toTokenAddress: input.fromRoute.toToken,
        amount: fromRaw.toString(),
        chainId: input.fromRoute.chainId,
      });
      const toAmount = new Prisma.Decimal(
        formatUnits(BigInt(response.dstAmount), input.fromRoute.toDecimals),
      );
      if (toAmount.lessThanOrEqualTo(0)) return null;

      if (input.side === 'ask') {
        // Spent quoteAsset (fromAmount), received base (toAmount).
        const price = input.fromAmount.div(toAmount);
        return {
          price: this.formatPrice(price),
          size: toAmount.toFixed(8),
          total: input.fromAmount.toFixed(2),
        };
      }

      // Spent base (fromAmount), received quoteAsset (toAmount).
      const price = toAmount.div(input.fromAmount);
      return {
        price: this.formatPrice(price),
        size: input.fromAmount.toFixed(8),
        total: toAmount.toFixed(2),
      };
    } catch (error) {
      this.logger.warn(`convert orderbook level failed: ${this.safeError(error)}`);
      return null;
    }
  }

  private routeForNetwork(fromAsset: any, toAsset: any, networkKey: string) {
    const from = fromAsset.tokenContracts.find(
      (item: any) =>
        item.network?.chainKey === networkKey &&
        item.contractVerifiedAt &&
        (item.standard === TokenStandard.ERC20 || item.standard === TokenStandard.NATIVE),
    );
    const to = toAsset.tokenContracts.find(
      (item: any) =>
        item.network?.chainKey === networkKey &&
        item.contractVerifiedAt &&
        (item.standard === TokenStandard.ERC20 || item.standard === TokenStandard.NATIVE),
    );
    const chainId = ONEINCH_EVM_NETWORKS.get(networkKey);
    if (!from || !to || !chainId) return null;
    if (from.network.chainId !== chainId || to.network.chainId !== chainId) return null;
    return {
      chainId,
      fromToken: from.standard === TokenStandard.NATIVE
        ? NATIVE_TOKEN_ADDRESS
        : getAddress(from.address),
      toToken: to.standard === TokenStandard.NATIVE
        ? NATIVE_TOKEN_ADDRESS
        : getAddress(to.address),
      fromDecimals: from.decimals as number,
      toDecimals: to.decimals as number,
    };
  }

  private async loadAsset(symbol: string) {
    const asset = await this.prisma.asset.findUnique({
      where: { symbol },
      include: { tokenContracts: { include: { network: true } } },
    });
    if (!asset) throw new NotFoundException(`Asset ${symbol} not found`);
    return asset;
  }

  private normalizePair(pairInput: string): string {
    const raw = pairInput.trim().toUpperCase().replace(/^CONVERT:/, '');
    if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(raw)) {
      throw new BadRequestException(`Invalid Spot pair "${pairInput}"`);
    }
    return raw;
  }

  private notionalLadder(): Prisma.Decimal[] {
    // Small ladders keep 1inch within ~1 RPS while still showing depth shape.
    return [25, 100, 400].map((value) => new Prisma.Decimal(value));
  }

  private referenceSeedLadder(mid: Prisma.Decimal): {
    bids: ConvertOrderBookLevel[];
    asks: ConvertOrderBookLevel[];
  } {
    const levels = 24;
    const maxNotional = this.notionalLadder().at(-1) ?? new Prisma.Decimal(400);
    const perLevel = maxNotional.div(levels);
    const halfSpreadBps = new Prisma.Decimal(5);
    const depthImpactBps = new Prisma.Decimal(45);
    let bidTotal = new Prisma.Decimal(0);
    let askTotal = new Prisma.Decimal(0);
    const bids: ConvertOrderBookLevel[] = [];
    const asks: ConvertOrderBookLevel[] = [];

    for (let index = 0; index < levels; index += 1) {
      const depth = new Prisma.Decimal(index + 1).div(levels);
      const offsetBps = halfSpreadBps.plus(depthImpactBps.mul(depth.pow(2)));
      const askPrice = mid.mul(new Prisma.Decimal(1).plus(offsetBps.div(10_000)));
      const bidPrice = mid.mul(new Prisma.Decimal(1).minus(offsetBps.div(10_000)));
      askTotal = askTotal.plus(perLevel);
      bidTotal = bidTotal.plus(perLevel);
      asks.push({
        price: this.formatPrice(askPrice),
        size: perLevel.div(askPrice).toFixed(8),
        total: askTotal.toFixed(2),
      });
      bids.push({
        price: this.formatPrice(bidPrice),
        size: perLevel.div(bidPrice).toFixed(8),
        total: bidTotal.toFixed(2),
      });
    }

    return { bids, asks };
  }

  private expandCumulativeAnchors(
    anchors: ConvertOrderBookLevel[],
    side: 'ask' | 'bid',
  ): ConvertOrderBookLevel[] {
    const sorted = [...anchors].sort(
      (left, right) => Number(left.total) - Number(right.total),
    );
    const result: ConvertOrderBookLevel[] = [];
    const subdivisions = 8;
    let previousSize = new Prisma.Decimal(0);
    let previousTotal = new Prisma.Decimal(0);
    let runningTotal = new Prisma.Decimal(0);
    let lastPrice: Prisma.Decimal | null = null;

    for (const anchor of sorted) {
      const cumulativeSize = new Prisma.Decimal(anchor.size);
      const cumulativeTotal = new Prisma.Decimal(anchor.total);
      const segmentSize = cumulativeSize.minus(previousSize);
      const segmentTotal = cumulativeTotal.minus(previousTotal);
      previousSize = cumulativeSize;
      previousTotal = cumulativeTotal;
      if (segmentSize.lessThanOrEqualTo(0) || segmentTotal.lessThanOrEqualTo(0)) continue;

      let segmentPrice = segmentTotal.div(segmentSize);
      if (lastPrice) {
        segmentPrice = side === 'ask'
          ? Prisma.Decimal.max(segmentPrice, lastPrice)
          : Prisma.Decimal.min(segmentPrice, lastPrice);
      }
      const sizePerLevel = segmentSize.div(subdivisions);
      for (let index = 0; index < subdivisions; index += 1) {
        const microOffset = new Prisma.Decimal(index)
          .minus(new Prisma.Decimal(subdivisions - 1).div(2))
          .mul('0.00002');
        let price = side === 'ask'
          ? segmentPrice.mul(new Prisma.Decimal(1).plus(microOffset))
          : segmentPrice.mul(new Prisma.Decimal(1).minus(microOffset));
        if (lastPrice) {
          price = side === 'ask'
            ? Prisma.Decimal.max(price, lastPrice)
            : Prisma.Decimal.min(price, lastPrice);
        }
        const quoteAmount = sizePerLevel.mul(price);
        runningTotal = runningTotal.plus(quoteAmount);
        result.push({
          price: this.formatPrice(price),
          size: sizePerLevel.toFixed(8),
          total: runningTotal.toFixed(2),
        });
        lastPrice = price;
      }
    }

    return side === 'ask'
      ? result.sort((left, right) => Number(left.price) - Number(right.price))
      : result.sort((left, right) => Number(right.price) - Number(left.price));
  }

  private calculateSpreadBps(
    bids: ConvertOrderBookLevel[],
    asks: ConvertOrderBookLevel[],
  ): number {
    const bestAsk = asks[0] ? Number(asks[0].price) : 0;
    const bestBid = bids[0] ? Number(bids[0].price) : 0;
    const mid = bestAsk > 0 && bestBid > 0 ? (bestAsk + bestBid) / 2 : 0;
    return mid > 0
      ? Number((((bestAsk - bestBid) / mid) * 10_000).toFixed(2))
      : 0;
  }

  private cacheTtlMs(): number {
    return this.config.get<number>('CONVERT_ORDERBOOK_CACHE_MS', 30_000);
  }

  private streamIntervalMs(): number {
    return this.config.get<number>('CONVERT_ORDERBOOK_STREAM_MS', 5_000);
  }

  private formatPrice(price: Prisma.Decimal): string {
    const n = Number(price.toString());
    if (!Number.isFinite(n) || n <= 0) return price.toFixed(8);
    if (n >= 1000) return price.toFixed(1);
    if (n >= 1) return price.toFixed(4);
    return price.toFixed(6);
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
