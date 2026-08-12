import {
  AssetType,
  Chain,
  MarketStatus,
  MarketType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

type HyperliquidMetaAsset = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
};

export type HyperliquidPerpSyncResult = {
  total: number;
  marketsUpserted: number;
  assetsCreated: number;
  skippedDelisted: number;
};

function configuredLegacyChain(): Chain {
  const chains: Record<number, Chain> = {
    42161: Chain.ARBITRUM,
    421614: Chain.ARBITRUM_SEPOLIA,
  };
  return chains[Number(process.env.ONCHAIN_CHAIN_ID ?? 421614)] ?? Chain.ARBITRUM;
}

function resolveBaseAssetSymbol(hlName: string, existing: Set<string>): string {
  if (existing.has(hlName)) {
    return hlName;
  }
  if (hlName.startsWith('k') && existing.has(hlName.slice(1))) {
    return hlName.slice(1);
  }
  return hlName;
}

function pricePrecisionForSzDecimals(szDecimals: number): number {
  return Math.max(0, Math.min(6, 6 - szDecimals));
}

function minOrderSizeForSzDecimals(szDecimals: number): string {
  if (szDecimals <= 0) {
    return '1';
  }
  return `0.${'0'.repeat(Math.max(0, szDecimals - 1))}1`;
}

export function hyperliquidTradingViewSymbolFor(providerSymbol: string): string {
  return `HYPERLIQUID:${providerSymbol.toUpperCase()}USDC.P`;
}

export async function syncHyperliquidPerpMarkets(
  prisma: PrismaClient,
  input?: { infoUrl?: string },
): Promise<HyperliquidPerpSyncResult> {
  const infoUrl = input?.infoUrl ?? process.env.HYPERLIQUID_INFO_URL ?? 'https://api.hyperliquid.xyz/info';
  const response = await fetch(infoUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  if (!response.ok) {
    throw new Error(`Hyperliquid meta request failed with HTTP ${response.status}`);
  }

  const meta = (await response.json()) as { universe: HyperliquidMetaAsset[] };
  const usdc = await prisma.asset.findUniqueOrThrow({ where: { symbol: 'USDC' } });
  const assets = await prisma.asset.findMany({ select: { id: true, symbol: true } });
  const assetBySymbol = new Map(assets.map((asset) => [asset.symbol, asset.id]));
  const assetSymbols = new Set(assetBySymbol.keys());
  const chain = configuredLegacyChain();

  let marketsUpserted = 0;
  let assetsCreated = 0;
  let skippedDelisted = 0;

  for (const hlAsset of meta.universe) {
    if (hlAsset.isDelisted) {
      skippedDelisted += 1;
      continue;
    }

    const baseAssetSymbol = resolveBaseAssetSymbol(hlAsset.name, assetSymbols);
    if (!assetBySymbol.has(baseAssetSymbol)) {
      const created = await prisma.asset.upsert({
        where: { symbol: baseAssetSymbol },
        update: {},
        create: {
          symbol: baseAssetSymbol,
          name: baseAssetSymbol,
          type: AssetType.CRYPTO,
          chain,
          decimals: 8,
          depositEnabled: false,
          withdrawalEnabled: false,
          withdrawalFeeAmount: new Prisma.Decimal(0),
          minWithdrawalAmount: new Prisma.Decimal(0),
        },
      });
      assetBySymbol.set(baseAssetSymbol, created.id);
      assetSymbols.add(baseAssetSymbol);
      assetsCreated += 1;
    }

    const marketSymbol = `${baseAssetSymbol}-PERP`;
    const pricePrecision = pricePrecisionForSzDecimals(hlAsset.szDecimals);
    const sizePrecision = hlAsset.szDecimals;
    const minOrderSize = minOrderSizeForSzDecimals(hlAsset.szDecimals);
    const maxLeverage = Math.min(hlAsset.maxLeverage, 10);

    const market = await prisma.market.upsert({
      where: { symbol: marketSymbol },
      update: {
        status: MarketStatus.ACTIVE,
        baseAssetId: assetBySymbol.get(baseAssetSymbol)!,
        quoteAssetId: usdc.id,
        providerName: 'HYPERLIQUID',
        providerSymbol: hlAsset.name,
        tradingViewSymbol: hyperliquidTradingViewSymbolFor(hlAsset.name),
        orderbookEnabled: true,
        pricePrecision,
        sizePrecision,
        minOrderSize: new Prisma.Decimal(minOrderSize),
      },
      create: {
        symbol: marketSymbol,
        type: MarketType.PERP,
        status: MarketStatus.ACTIVE,
        baseAssetId: assetBySymbol.get(baseAssetSymbol)!,
        quoteAssetId: usdc.id,
        providerName: 'HYPERLIQUID',
        providerSymbol: hlAsset.name,
        tradingViewSymbol: hyperliquidTradingViewSymbolFor(hlAsset.name),
        orderbookEnabled: true,
        pricePrecision,
        sizePrecision,
        minOrderSize: new Prisma.Decimal(minOrderSize),
      },
    });

    await prisma.riskConfig.upsert({
      where: { marketId: market.id },
      update: { maxLeverage },
      create: {
        marketId: market.id,
        bbookEnabled: true,
        maxLeverage,
      },
    });
    await prisma.feeConfig.upsert({
      where: { marketId: market.id },
      update: {},
      create: { marketId: market.id },
    });
    await prisma.bBookExposure.upsert({
      where: { marketId: market.id },
      update: {},
      create: { marketId: market.id },
    });

    marketsUpserted += 1;
  }

  return {
    total: meta.universe.length,
    marketsUpserted,
    assetsCreated,
    skippedDelisted,
  };
}
