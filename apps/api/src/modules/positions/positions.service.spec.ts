import { MarketType, PositionStatus, Prisma } from '@prisma/client';
import { PositionsService } from './positions.service';

describe('PositionsService', () => {
  it('returns live mark and pnl for open positions', async () => {
    const prisma = {
      position: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'position-1',
          market: {
            symbol: 'BTC-PERP',
            type: MarketType.PERP,
            pricePrecision: 1,
            sizePrecision: 5,
            baseAsset: { symbol: 'BTC' },
            quoteAsset: { symbol: 'USDC' },
          },
          side: 'LONG',
          status: PositionStatus.OPEN,
          route: 'B_BOOK_INTERNAL',
          marginMode: 'ISOLATED',
          size: new Prisma.Decimal('0.000049'),
          entryPrice: new Prisma.Decimal('60000'),
          markPrice: new Prisma.Decimal('60100'),
          liquidationPrice: new Prisma.Decimal('54300'),
          leverage: 10,
          margin: new Prisma.Decimal('0.294'),
          maintenanceMargin: new Prisma.Decimal('0.0147'),
          unrealizedPnl: new Prisma.Decimal('0.0049'),
          realizedPnl: new Prisma.Decimal(0),
          fundingPaid: new Prisma.Decimal(0),
          openedAt: new Date('2026-06-28T00:00:00Z'),
          closedAt: null,
          updatedAt: new Date('2026-06-28T00:00:05Z'),
          liquidations: [],
        }]),
      },
    };
    const marketData = {
      getOrderBook: jest.fn().mockResolvedValue({
        symbol: 'BTC-PERP',
        provider: 'HYPERLIQUID',
        providerSymbol: 'BTC',
        time: Date.now(),
        bids: [{ price: '60200', size: '1', orders: 1 }],
        asks: [{ price: '60400', size: '1', orders: 1 }],
      }),
    };
    const service = new PositionsService(
      prisma as never,
      {} as never,
      marketData as never,
    );

    await expect(service.listUserPositions('user-1')).resolves.toEqual([
      expect.objectContaining({
        market: 'BTC-PERP',
        markPrice: '60300',
        notionalUsdc: '2.9547',
        unrealizedPnl: '0.0147',
        pnlCurrency: 'USDC',
        displayPricePrecision: 0,
        exitPrice: null,
      }),
    ]);

    marketData.getOrderBook.mockClear();
    await expect(
      service.listUserPositions('user-1', { includeLiveMarks: false }),
    ).resolves.toEqual([
      expect.objectContaining({
        markPrice: '60100',
        unrealizedPnl: '0.0049',
      }),
    ]);
    expect(marketData.getOrderBook).not.toHaveBeenCalled();
  });
});
