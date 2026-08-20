import { MarketType, PositionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
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

  it('returns cursor-paginated history without nested liquidations', async () => {
    const row = (id: string, closedAt: string) => ({
      id,
      market: {
        symbol: 'BTC-PERP',
        type: MarketType.PERP,
        pricePrecision: 1,
        sizePrecision: 5,
        baseAsset: { symbol: 'BTC' },
        quoteAsset: { symbol: 'USDC' },
      },
      side: 'LONG',
      status: PositionStatus.CLOSED,
      route: 'A_BOOK_HYPERLIQUID',
      marginMode: 'ISOLATED',
      size: new Prisma.Decimal('0.001'),
      entryPrice: new Prisma.Decimal('60000'),
      markPrice: new Prisma.Decimal('61000'),
      liquidationPrice: new Prisma.Decimal('54000'),
      leverage: 10,
      margin: new Prisma.Decimal('6'),
      maintenanceMargin: new Prisma.Decimal('0.03'),
      unrealizedPnl: new Prisma.Decimal(0),
      realizedPnl: new Prisma.Decimal(1),
      fundingPaid: new Prisma.Decimal(0),
      openedAt: new Date('2026-08-19T00:00:00Z'),
      closedAt: new Date(closedAt),
      updatedAt: new Date(closedAt),
    });
    const findMany = jest.fn().mockResolvedValue([
      row('position-2', '2026-08-20T02:00:00Z'),
      row('position-1', '2026-08-20T01:00:00Z'),
    ]);
    const service = new PositionsService(
      { position: { findMany } } as unknown as PrismaService,
      {} as never,
      {} as never,
    );

    const result = await service.listUserPositionHistory({
      userId: 'user-1',
      limit: 1,
    });
    expect(result).toEqual({
      items: [expect.objectContaining({ id: 'position-2', status: PositionStatus.CLOSED })],
      nextCursor: expect.any(String),
    });
    expect(JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString('utf8'))).toEqual({
      updatedAt: '2026-08-20T02:00:00.000Z',
      id: 'position-2',
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 2,
      where: {
        userId: 'user-1',
        status: { in: [PositionStatus.CLOSED, PositionStatus.LIQUIDATED] },
      },
      include: expect.not.objectContaining({ liquidations: expect.anything() }),
    }));
  });

  it('loads liquidations only after verifying position ownership', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 'liquidation-1' }]);
    const service = new PositionsService(
      {
        position: { findFirst: jest.fn().mockResolvedValue({ id: 'position-1' }) },
        liquidationEvent: { findMany },
      } as unknown as PrismaService,
      {} as never,
      {} as never,
    );

    await expect(
      service.listPositionLiquidations('user-1', 'position-1'),
    ).resolves.toEqual([{ id: 'liquidation-1' }]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { positionId: 'position-1' },
      select: expect.any(Object),
    }));
  });

  it('rejects a malformed history cursor before querying the database', async () => {
    const findMany = jest.fn();
    const service = new PositionsService(
      { position: { findMany } } as unknown as PrismaService,
      {} as never,
      {} as never,
    );
    await expect(service.listUserPositionHistory({
      userId: 'user-1',
      cursor: 'not-a-valid-cursor',
    })).rejects.toThrow('Invalid position history cursor');
    expect(findMany).not.toHaveBeenCalled();
  });
});
