import { MarketType, Prisma } from '@prisma/client';
import { presentPosition } from './position.presenter';

describe('presentPosition share prices', () => {
  it('exposes a zero-decimal BTC display precision and the committed exit price', () => {
    const position = presentPosition({
      id: 'position-closed-btc',
      side: 'LONG',
      status: 'CLOSED',
      size: new Prisma.Decimal(0),
      entryPrice: new Prisma.Decimal('64251.42'),
      markPrice: new Prisma.Decimal('64810.73'),
      liquidationPrice: new Prisma.Decimal('58000'),
      leverage: 5,
      margin: new Prisma.Decimal(0),
      unrealizedPnl: new Prisma.Decimal(0),
      realizedPnl: new Prisma.Decimal('1.25'),
      openedAt: new Date('2026-07-15T00:00:00Z'),
      closedAt: new Date('2026-07-15T00:10:00Z'),
      updatedAt: new Date('2026-07-15T00:10:00Z'),
      market: {
        symbol: 'BTC-PERP',
        type: MarketType.PERP,
        pricePrecision: 1,
        sizePrecision: 5,
        baseAsset: { symbol: 'BTC' },
        quoteAsset: { symbol: 'USDC' },
      },
    });

    expect(position).toMatchObject({
      entryPrice: '64251.42',
      exitPrice: '64810.73',
      pricePrecision: 1,
      displayPricePrecision: 0,
    });
  });

  it('keeps five price decimals for a low-priced market', () => {
    const position = presentPosition({
      id: 'position-open-pendle',
      side: 'LONG',
      status: 'OPEN',
      size: new Prisma.Decimal('207'),
      entryPrice: new Prisma.Decimal('1.61625'),
      markPrice: new Prisma.Decimal('1.6183'),
      liquidationPrice: new Prisma.Decimal('1.31'),
      leverage: 5,
      margin: new Prisma.Decimal('66.91'),
      unrealizedPnl: new Prisma.Decimal('0.42'),
      realizedPnl: new Prisma.Decimal(0),
      openedAt: new Date('2026-07-15T00:00:00Z'),
      updatedAt: new Date('2026-07-15T00:00:01Z'),
      market: {
        symbol: 'PENDLE-PERP',
        type: MarketType.PERP,
        pricePrecision: 6,
        sizePrecision: 0,
        baseAsset: { symbol: 'PENDLE' },
        quoteAsset: { symbol: 'USDC' },
      },
    });

    expect(position).toMatchObject({
      exitPrice: null,
      displayPricePrecision: 5,
    });
  });
});
