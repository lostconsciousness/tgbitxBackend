import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  OrderSide,
  OrderType,
  PositionSide,
  PositionStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { MarketDataService } from '../market-data/market-data.service';
import { OrdersService } from '../orders/orders.service';
import { midpointMarkFromBook, unrealizedPnlForPosition } from './position-live-mark';
import { presentPosition } from './position.presenter';

const positionMarketInclude = {
  market: {
    include: {
      baseAsset: { select: { symbol: true } },
      quoteAsset: { select: { symbol: true } },
    },
  },
} as const;

const positionHistoryStatuses = [PositionStatus.CLOSED, PositionStatus.LIQUIDATED] as const;

type PositionHistoryCursor = { updatedAt: Date; id: string };

function encodePositionHistoryCursor(cursor: PositionHistoryCursor): string {
  return Buffer.from(JSON.stringify({
    updatedAt: cursor.updatedAt.toISOString(),
    id: cursor.id,
  })).toString('base64url');
}

function decodePositionHistoryCursor(value: string): PositionHistoryCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      updatedAt?: unknown;
      id?: unknown;
    };
    const updatedAt = new Date(String(decoded.updatedAt));
    if (typeof decoded.id !== 'string' || !decoded.id || Number.isNaN(updatedAt.getTime())) {
      throw new Error('Invalid cursor fields');
    }
    return { updatedAt, id: decoded.id };
  } catch (_error) {
    throw new BadRequestException('Invalid position history cursor');
  }
}

@Injectable()
export class PositionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly marketData: MarketDataService,
  ) {}

  async listUserPositions(
    userId: string,
    options?: { includeLiveMarks?: boolean; status?: PositionStatus },
  ) {
    const positions = await this.prisma.position.findMany({
      where: { userId, ...(options?.status ? { status: options.status } : {}) },
      include: positionMarketInclude,
      orderBy: { openedAt: 'desc' },
    });
    const openSymbols = options?.includeLiveMarks === false ? [] : [
      ...new Set(
        positions
          .filter((position) => position.status === PositionStatus.OPEN)
          .map((position) => position.market.symbol),
      ),
    ];
    const liveMarks = await this.loadLiveMarks(openSymbols);

    return positions.map((position) => {
      if (position.status !== PositionStatus.OPEN) {
        return presentPosition(position);
      }
      const mark = liveMarks.get(position.market.symbol);
      if (!mark) {
        return presentPosition(position);
      }
      const size = new Prisma.Decimal(position.size.toString());
      const entryPrice = new Prisma.Decimal(position.entryPrice.toString());
      return presentPosition(position, {
        markPrice: mark,
        unrealizedPnl: unrealizedPnlForPosition({
          side: position.side,
          size,
          entryPrice,
          markPrice: mark,
        }),
      });
    });
  }

  async listUserPositionHistory(input: {
    userId: string;
    cursor?: string;
    limit?: number;
  }) {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
    const cursor = input.cursor ? decodePositionHistoryCursor(input.cursor) : null;
    const positions = await this.prisma.position.findMany({
      where: {
        userId: input.userId,
        status: { in: [...positionHistoryStatuses] },
        ...(cursor
          ? {
              OR: [
                { updatedAt: { lt: cursor.updatedAt } },
                { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: positionMarketInclude,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = positions.length > limit;
    const page = hasMore ? positions.slice(0, limit) : positions;
    return {
      items: page.map((position) => presentPosition(position)),
      nextCursor: hasMore && page.length > 0
        ? encodePositionHistoryCursor({
            updatedAt: page[page.length - 1]!.updatedAt,
            id: page[page.length - 1]!.id,
          })
        : null,
    };
  }

  async listPositionLiquidations(userId: string, positionId: string) {
    const position = await this.prisma.position.findFirst({
      where: { id: positionId, userId },
      select: { id: true },
    });
    if (!position) {
      throw new NotFoundException('Position not found');
    }
    return this.prisma.liquidationEvent.findMany({
      where: { positionId },
      select: {
        id: true,
        status: true,
        markPrice: true,
        positionSize: true,
        collateralBefore: true,
        realizedPnl: true,
        liquidationFee: true,
        platformFee: true,
        insuranceFee: true,
        failureReason: true,
        triggeredAt: true,
        completedAt: true,
      },
      orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }],
    });
  }

  async closePosition(userId: string, positionId: string) {
    const position = await this.prisma.position.findFirst({
      where: { id: positionId, userId, status: PositionStatus.OPEN },
      include: { market: true },
    });
    if (!position) {
      throw new NotFoundException('Open position not found');
    }
    return this.orders.createOrder(userId, {
      symbol: position.market.symbol,
      clientOrderId: `close-${randomUUID()}`,
      side:
        position.side === PositionSide.LONG ? OrderSide.SELL : OrderSide.BUY,
      type: OrderType.MARKET,
      size: position.size.toString(),
      leverage: position.leverage,
      reduceOnly: true,
    });
  }

  private async loadLiveMarks(symbols: string[]): Promise<Map<string, Prisma.Decimal>> {
    const marks = new Map<string, Prisma.Decimal>();
    if (symbols.length === 0) {
      return marks;
    }

    const results = await Promise.allSettled(
      symbols.map(async (symbol) => {
        const book = await this.marketData.getOrderBook(symbol);
        const mark = midpointMarkFromBook(book);
        return mark ? ([symbol, mark] as const) : null;
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        marks.set(result.value[0], result.value[1]);
      }
    }
    return marks;
  }
}
