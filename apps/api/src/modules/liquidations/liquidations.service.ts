import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  LiquidationStatus,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSide,
  PositionStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { MarketDataService } from '../market-data/market-data.service';
import { OrdersService } from '../orders/orders.service';
import {
  midpointMarkFromBook,
  unrealizedPnlForPosition,
} from '../positions/position-live-mark';

@Injectable()
export class LiquidationsService {
  private readonly logger = new Logger(LiquidationsService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
    private readonly orders: OrdersService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async monitor(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const positions = await this.prisma.position.findMany({
        where: { status: PositionStatus.OPEN },
        include: { market: true },
        take: 100,
      });
      for (const position of positions) {
        await this.evaluate(position).catch((error) =>
          this.logger.warn(
            `Position ${position.id} risk check failed: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          ),
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async evaluate(
    position: Prisma.PositionGetPayload<{ include: { market: true } }>,
  ) {
    const book = await this.marketData.getOrderBook(position.market.symbol);
    const mark = midpointMarkFromBook(book);
    if (!mark) {
      return;
    }
    const size = new Prisma.Decimal(position.size.toString());
    const entryPrice = new Prisma.Decimal(position.entryPrice.toString());
    const unrealizedPnl = unrealizedPnlForPosition({
      side: position.side,
      size,
      entryPrice,
      markPrice: mark,
    });
    await this.prisma.position.update({
      where: { id: position.id },
      data: { markPrice: mark, unrealizedPnl },
    });
    const bookAgeMs = Math.max(0, Date.now() - book.time);
    const maxMarkAgeMs = this.config.get<number>('POSITION_LIQUIDATION_MAX_MARK_AGE_MS', 30_000);
    if (bookAgeMs > maxMarkAgeMs) {
      return;
    }
    if (new Prisma.Decimal(position.margin).plus(unrealizedPnl).greaterThan(position.maintenanceMargin)) {
      return;
    }
    if (
      await this.prisma.liquidationEvent.findFirst({
        where: {
          positionId: position.id,
          status: { in: [LiquidationStatus.TRIGGERED, LiquidationStatus.CLOSING] },
        },
      })
    ) {
      return;
    }
    await this.liquidate(position, mark, unrealizedPnl);
  }

  private async liquidate(
    position: Prisma.PositionGetPayload<{ include: { market: true } }>,
    mark: Prisma.Decimal,
    unrealizedPnl: Prisma.Decimal,
  ) {
    const feeConfig = await this.prisma.feeConfig.upsert({
      where: { marketId: position.marketId },
      update: {},
      create: { marketId: position.marketId },
    });
    const maxFeeBase = Prisma.Decimal.max(
      0,
      new Prisma.Decimal(position.margin).plus(unrealizedPnl),
    );
    const tradeFee = new Prisma.Decimal(position.size)
      .mul(mark)
      .mul(feeConfig.takerFeeBps)
      .div(10_000);
    const liquidationFee = Prisma.Decimal.min(
      new Prisma.Decimal(position.size)
        .mul(mark)
        .mul(feeConfig.liquidationFeeBps)
        .div(10_000),
      Prisma.Decimal.max(0, maxFeeBase.minus(tradeFee)),
    );
    const platformFee = liquidationFee
      .mul(feeConfig.liquidationPlatformShareBps)
      .div(10_000);
    const insuranceFee = liquidationFee.minus(platformFee);
    const event = await this.prisma.liquidationEvent.create({
      data: {
        positionId: position.id,
        marketId: position.marketId,
        status: LiquidationStatus.CLOSING,
        markPrice: mark,
        positionSize: position.size,
        collateralBefore: position.margin,
        realizedPnl: unrealizedPnl,
        liquidationFee,
        platformFee,
        insuranceFee,
      },
    });
    try {
      const order = await this.orders.createOrder(
        position.userId,
        {
          symbol: position.market.symbol,
          clientOrderId: `liquidation-${randomUUID()}`,
          side:
            position.side === PositionSide.LONG ? OrderSide.SELL : OrderSide.BUY,
          type: OrderType.MARKET,
          size: position.size.toString(),
          leverage: position.leverage,
          reduceOnly: true,
        },
        {
          liquidationEventId: event.id,
          liquidationFee,
          liquidationPlatformFee: platformFee,
          liquidationInsuranceFee: insuranceFee,
        },
      );
      if (order.status !== OrderStatus.FILLED) {
        return;
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.position.update({
          where: { id: position.id },
          data: { status: PositionStatus.LIQUIDATED },
        });
      });
      return order;
    } catch (error) {
      await this.prisma.liquidationEvent.update({
        where: { id: event.id },
        data: {
          status: LiquidationStatus.FAILED,
          failureReason: error instanceof Error ? error.message : 'Unknown error',
        },
      });
      throw error;
    }
  }
}
