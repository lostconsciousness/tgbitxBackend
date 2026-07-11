import { PositionSide, Prisma } from '@prisma/client';
import { OrderBookSnapshot } from '../market-data/types/orderbook.types';

export function midpointMarkFromBook(book: OrderBookSnapshot): Prisma.Decimal | null {
  const bid = book.bids[0];
  const ask = book.asks[0];
  if (!bid || !ask) {
    return null;
  }
  return new Prisma.Decimal(bid.price).plus(ask.price).div(2);
}

export function unrealizedPnlForPosition(input: {
  side: string;
  size: Prisma.Decimal;
  entryPrice: Prisma.Decimal;
  markPrice: Prisma.Decimal;
}): Prisma.Decimal {
  const pnlPerUnit =
    input.side === PositionSide.LONG
      ? input.markPrice.minus(input.entryPrice)
      : input.entryPrice.minus(input.markPrice);
  return pnlPerUnit.mul(input.size);
}
