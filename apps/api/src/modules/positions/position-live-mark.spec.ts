import { PositionSide, Prisma } from '@prisma/client';
import { midpointMarkFromBook, unrealizedPnlForPosition } from './position-live-mark';

describe('position-live-mark', () => {
  it('computes midpoint mark and long unrealized pnl', () => {
    const mark = midpointMarkFromBook({
      symbol: 'BTC-PERP',
      provider: 'HYPERLIQUID',
      providerSymbol: 'BTC',
      time: Date.now(),
      bids: [{ price: '100', size: '1', orders: 1 }],
      asks: [{ price: '102', size: '1', orders: 1 }],
    });
    expect(mark?.toString()).toBe('101');

    const pnl = unrealizedPnlForPosition({
      side: PositionSide.LONG,
      size: new Prisma.Decimal('2'),
      entryPrice: new Prisma.Decimal('100'),
      markPrice: new Prisma.Decimal('101'),
    });
    expect(pnl.toString()).toBe('2');
  });
});
