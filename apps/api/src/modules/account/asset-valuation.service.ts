import { Injectable } from '@nestjs/common';
import { Asset, AssetType, Market, MarketStatus, MarketType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { MarketDataService } from '../market-data/market-data.service';

type ValuationMarket = Market & { baseAsset: Asset; quoteAsset?: Asset };

@Injectable()
export class AssetValuationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly marketDataService: MarketDataService,
  ) {}

  loadUsdcMarkets(): Promise<ValuationMarket[]> {
    return this.prisma.market.findMany({
      where: {
        status: MarketStatus.ACTIVE,
        quoteAsset: { symbol: 'USDC' },
        type: { in: [MarketType.SPOT, MarketType.PERP] },
      },
      include: { baseAsset: true, quoteAsset: true },
      orderBy: [{ type: 'asc' }, { symbol: 'asc' }],
    });
  }

  async getAssetPriceUsdc(
    asset: Pick<Asset, 'id' | 'symbol'> & { type?: AssetType | string },
    markets?: ValuationMarket[],
  ): Promise<Prisma.Decimal | null> {
    if (this.isStablecoin(asset)) {
      return new Prisma.Decimal(1);
    }

    const activeMarkets = markets ?? (await this.loadUsdcMarkets());
    const market = this.findValuationMarket(asset, activeMarkets);
    if (!market) {
      return null;
    }

    try {
      const book = await this.marketDataService.getOrderBook(market.symbol);
      const bid = book.bids[0]?.price;
      const ask = book.asks[0]?.price;
      if (!bid || !ask) {
        return null;
      }
      return new Prisma.Decimal(bid).plus(ask).div(2);
    } catch (_error) {
      return null;
    }
  }

  async getAmountValueUsdc(
    asset: Pick<Asset, 'id' | 'symbol'> & { type?: AssetType | string },
    amount: string,
    markets?: ValuationMarket[],
  ): Promise<Prisma.Decimal | null> {
    try {
      const normalized = new Prisma.Decimal(amount);
      if (normalized.lte(0)) {
        return new Prisma.Decimal(0);
      }
      const price = await this.getAssetPriceUsdc(asset, markets);
      return price ? normalized.mul(price) : null;
    } catch (_error) {
      return null;
    }
  }

  compareUsdcValues(
    left: string | null | undefined,
    right: string | null | undefined,
    leftSymbol: string,
    rightSymbol: string,
  ): number {
    const leftValue = this.parseUsdc(left);
    const rightValue = this.parseUsdc(right);

    if (leftValue && rightValue) {
      const compared = rightValue.comparedTo(leftValue);
      if (compared !== 0) {
        return compared;
      }
    } else if (leftValue) {
      return -1;
    } else if (rightValue) {
      return 1;
    }

    return leftSymbol.localeCompare(rightSymbol);
  }

  async enrichAndSortByBalanceUsdc<
    T extends { id: string; symbol: string; type?: AssetType | string },
  >(
    assets: T[],
    getBalance: (asset: T) => string,
  ): Promise<Array<T & { priceUsdc: string | null; balanceValueUsdc: string | null }>> {
    const markets = await this.loadUsdcMarkets();
    const enriched = await Promise.all(
      assets.map(async (asset) => {
        const price = await this.getAssetPriceUsdc(asset, markets);
        const value = await this.getAmountValueUsdc(asset, getBalance(asset), markets);

        return {
          ...asset,
          priceUsdc: price?.toString() ?? null,
          balanceValueUsdc: value?.toString() ?? null,
        };
      }),
    );

    return enriched.sort((left, right) =>
      this.compareUsdcValues(
        left.balanceValueUsdc,
        right.balanceValueUsdc,
        left.symbol,
        right.symbol,
      ),
    );
  }

  private parseUsdc(value: string | null | undefined): Prisma.Decimal | null {
    if (!value) {
      return null;
    }
    try {
      return new Prisma.Decimal(value);
    } catch (_error) {
      return null;
    }
  }

  async loadNativePricesUsd(): Promise<Partial<Record<string, string>>> {
    const markets = await this.loadUsdcMarkets();
    const symbols = ['BTC', 'ETH', 'BNB', 'SOL', 'POL', 'AVAX', 'TRX'];
    const prices: Partial<Record<string, string>> = {};
    for (const symbol of symbols) {
      const asset = markets.find((market) => market.baseAsset.symbol === symbol)?.baseAsset;
      if (!asset) {
        continue;
      }
      const price = await this.getAssetPriceUsdc(asset, markets);
      if (price) {
        prices[symbol] = price.toString();
      }
    }
    return prices;
  }

  private findValuationMarket(
    asset: Pick<Asset, 'id' | 'symbol'>,
    markets: ValuationMarket[],
  ): ValuationMarket | null {
    const directSpot = markets.filter(
      (market) => market.type === MarketType.SPOT && market.baseAssetId === asset.id,
    );
    const directPerp = markets.filter(
      (market) => market.type === MarketType.PERP && market.baseAssetId === asset.id,
    );
    const wrappedSpot = markets.filter(
      (market) =>
        market.type === MarketType.SPOT &&
        (market.baseAsset.symbol === `W${asset.symbol}` ||
          market.baseAsset.symbol.replace(/^W/, '') === asset.symbol),
    );

    return (
      this.pickPricedMarket(directSpot) ??
      this.pickPricedMarket(directPerp) ??
      this.pickPricedMarket(wrappedSpot) ??
      directPerp[0] ??
      directSpot[0] ??
      wrappedSpot[0] ??
      null
    );
  }

  private pickPricedMarket(candidates: ValuationMarket[]): ValuationMarket | null {
    return (
      candidates.find((market) => market.orderbookEnabled && Boolean(market.providerSymbol)) ??
      null
    );
  }

  private isStablecoin(asset: { symbol: string; type?: AssetType | string }): boolean {
    if (asset.type === AssetType.STABLECOIN || asset.type === 'STABLECOIN') {
      return true;
    }

    return asset.symbol === 'USDC' || asset.symbol === 'USDT';
  }
}
