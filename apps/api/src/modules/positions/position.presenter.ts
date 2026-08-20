import { MarketType, Prisma } from '@prisma/client';

type PositionMarket = {
  symbol: string;
  type: MarketType;
  pricePrecision: number;
  sizePrecision: number;
  baseAsset?: { symbol: string } | null;
  quoteAsset?: { symbol: string } | null;
};

type PositionLike = {
  id: string;
  side: string;
  status: string;
  route?: string | null;
  marginMode?: string | null;
  size: Prisma.Decimal | { toString(): string };
  entryPrice: Prisma.Decimal | { toString(): string };
  markPrice: Prisma.Decimal | { toString(): string };
  liquidationPrice: Prisma.Decimal | { toString(): string };
  leverage: number;
  margin: Prisma.Decimal | { toString(): string };
  maintenanceMargin?: Prisma.Decimal | { toString(): string } | null;
  unrealizedPnl: Prisma.Decimal | { toString(): string };
  realizedPnl: Prisma.Decimal | { toString(): string };
  fundingPaid?: Prisma.Decimal | { toString(): string } | null;
  openedAt: Date;
  closedAt?: Date | null;
  updatedAt: Date;
  market: PositionMarket;
  liquidations?: unknown[];
};

function resolveBaseAssetSymbol(market: PositionMarket): string {
  if (market.baseAsset?.symbol) {
    return market.baseAsset.symbol;
  }
  const [base] = market.symbol.split('-');
  return base ?? market.symbol;
}

function resolveQuoteAssetSymbol(market: PositionMarket): string {
  return market.quoteAsset?.symbol ?? 'USDC';
}

export function presentPosition(
  position: PositionLike,
  live?: {
    markPrice: Prisma.Decimal;
    unrealizedPnl: Prisma.Decimal;
  },
) {
  const size = new Prisma.Decimal(position.size.toString());
  const markPrice = live?.markPrice ?? new Prisma.Decimal(position.markPrice.toString());
  const unrealizedPnl =
    live?.unrealizedPnl ?? new Prisma.Decimal(position.unrealizedPnl.toString());
  const baseAsset = resolveBaseAssetSymbol(position.market);
  const quoteAsset = resolveQuoteAssetSymbol(position.market);
  const maximumDisplayPrecision = new Prisma.Decimal(position.entryPrice.toString())
    .abs()
    .greaterThanOrEqualTo('0.001')
    ? 5
    : 8;
  const displayPricePrecision = baseAsset === 'BTC'
    ? 0
    : Math.max(0, Math.min(maximumDisplayPrecision, position.market.pricePrecision));
  const exitPrice = position.status === 'CLOSED'
    ? position.markPrice.toString()
    : null;

  return {
    id: position.id,
    market: position.market.symbol,
    marketType: position.market.type,
    side: position.side,
    status: position.status,
    ...(position.route !== undefined ? { route: position.route } : {}),
    ...(position.marginMode !== undefined ? { marginMode: position.marginMode } : {}),
    size: size.toString(),
    baseAsset,
    quoteAsset,
    pricePrecision: position.market.pricePrecision,
    sizePrecision: position.market.sizePrecision,
    displayPricePrecision,
    notionalUsdc: size.mul(markPrice).toString(),
    entryPrice: position.entryPrice.toString(),
    exitPrice,
    markPrice: markPrice.toString(),
    liquidationPrice: position.liquidationPrice.toString(),
    leverage: position.leverage,
    margin: position.margin.toString(),
    ...(position.maintenanceMargin !== undefined && position.maintenanceMargin !== null
      ? { maintenanceMargin: position.maintenanceMargin.toString() }
      : {}),
    unrealizedPnl: unrealizedPnl.toString(),
    realizedPnl: position.realizedPnl.toString(),
    pnlCurrency: quoteAsset,
    ...(position.fundingPaid !== undefined && position.fundingPaid !== null
      ? { fundingPaid: position.fundingPaid.toString() }
      : {}),
    openedAt: position.openedAt,
    ...(position.closedAt !== undefined ? { closedAt: position.closedAt } : {}),
    updatedAt: position.updatedAt,
    ...(position.liquidations !== undefined ? { liquidations: position.liquidations } : {}),
  };
}
