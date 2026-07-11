import { Injectable, NotFoundException } from '@nestjs/common';
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
  liquidations: true,
} as const;

@Injectable()
export class PositionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly marketData: MarketDataService,
  ) {}

  async listUserPositions(userId: string) {
    const positions = await this.prisma.position.findMany({
      where: { userId },
      include: positionMarketInclude,
      orderBy: { openedAt: 'desc' },
    });
    const openSymbols = [
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
