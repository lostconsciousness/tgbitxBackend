import { BadRequestException } from '@nestjs/common';
import { LedgerEntryDirection, Prisma } from '@prisma/client';

export type LedgerBalanceEntry = {
  assetId: string;
  direction: LedgerEntryDirection;
  amount: Prisma.Decimal | string | number;
};

export function toDecimal(amount: Prisma.Decimal | string | number): Prisma.Decimal {
  return amount instanceof Prisma.Decimal ? amount : new Prisma.Decimal(amount);
}

export function assertBalancedLedgerEntries(entries: LedgerBalanceEntry[]): void {
  if (entries.length < 2) {
    throw new BadRequestException('Ledger transaction must have at least two entries');
  }

  const totals = new Map<string, { debit: Prisma.Decimal; credit: Prisma.Decimal }>();

  for (const entry of entries) {
    const amount = toDecimal(entry.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Ledger entry amount must be positive');
    }

    const current = totals.get(entry.assetId) ?? {
      debit: new Prisma.Decimal(0),
      credit: new Prisma.Decimal(0),
    };

    if (entry.direction === LedgerEntryDirection.DEBIT) {
      current.debit = current.debit.plus(amount);
    } else {
      current.credit = current.credit.plus(amount);
    }

    totals.set(entry.assetId, current);
  }

  for (const [assetId, total] of totals.entries()) {
    if (!total.debit.equals(total.credit)) {
      throw new BadRequestException(`Ledger transaction is not balanced for asset ${assetId}`);
    }
  }
}

export function calculateAccountBalance(entries: LedgerBalanceEntry[]): Prisma.Decimal {
  return entries.reduce((balance, entry) => {
    const amount = toDecimal(entry.amount);
    return entry.direction === LedgerEntryDirection.CREDIT
      ? balance.plus(amount)
      : balance.minus(amount);
  }, new Prisma.Decimal(0));
}
