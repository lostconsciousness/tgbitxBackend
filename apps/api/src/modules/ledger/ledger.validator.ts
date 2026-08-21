import { BadRequestException } from '@nestjs/common';
import { LedgerEntryDirection, Prisma } from '@prisma/client';

export type LedgerBalanceEntry = {
  assetId: string;
  direction: LedgerEntryDirection;
  amount: Prisma.Decimal | string | number;
};

const LEDGER_DECIMAL_SCALE = 18;
const LEDGER_SCALE_FACTOR = 10n ** BigInt(LEDGER_DECIMAL_SCALE);
const HighPrecisionDecimal = Prisma.Decimal.clone({
  // Ledger columns are Decimal(38, 18). Keep enough significant digits for
  // intermediate sums so decimal.js' default precision (20) cannot introduce
  // a one-wei imbalance before values reach Postgres.
  precision: 60,
  rounding: Prisma.Decimal.ROUND_HALF_UP,
});

export function toDecimal(amount: Prisma.Decimal | string | number): Prisma.Decimal {
  return amount instanceof Prisma.Decimal ? amount : new Prisma.Decimal(amount);
}

export function toLedgerDecimal(
  amount: Prisma.Decimal | string | number,
): Prisma.Decimal {
  const value = new HighPrecisionDecimal(
    amount instanceof Prisma.Decimal ? amount.toString() : String(amount),
  ).toDecimalPlaces(LEDGER_DECIMAL_SCALE, Prisma.Decimal.ROUND_HALF_UP);
  // Decimal.clone instances are recognised by Prisma.Decimal.isDecimal and
  // preserve their higher precision when Prisma serializes them.
  return value as Prisma.Decimal;
}

function toLedgerAtomicUnits(amount: Prisma.Decimal | string | number): bigint {
  const fixed = toLedgerDecimal(amount).toFixed(LEDGER_DECIMAL_SCALE);
  const negative = fixed.startsWith('-');
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const atomic = BigInt(whole) * LEDGER_SCALE_FACTOR +
    BigInt(fraction.padEnd(LEDGER_DECIMAL_SCALE, '0'));
  return negative ? -atomic : atomic;
}

function fromLedgerAtomicUnits(amount: bigint): Prisma.Decimal {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / LEDGER_SCALE_FACTOR;
  const fraction = (absolute % LEDGER_SCALE_FACTOR)
    .toString()
    .padStart(LEDGER_DECIMAL_SCALE, '0');
  return toLedgerDecimal(`${negative ? '-' : ''}${whole}.${fraction}`);
}

export function assertBalancedLedgerEntries(entries: LedgerBalanceEntry[]): void {
  if (entries.length < 2) {
    throw new BadRequestException('Ledger transaction must have at least two entries');
  }

  const totals = new Map<string, { debit: bigint; credit: bigint }>();

  for (const entry of entries) {
    const amount = toLedgerAtomicUnits(entry.amount);
    if (amount <= 0n) {
      throw new BadRequestException('Ledger entry amount must be positive');
    }

    const current = totals.get(entry.assetId) ?? {
      debit: 0n,
      credit: 0n,
    };

    if (entry.direction === LedgerEntryDirection.DEBIT) {
      current.debit += amount;
    } else {
      current.credit += amount;
    }

    totals.set(entry.assetId, current);
  }

  for (const [assetId, total] of totals.entries()) {
    if (total.debit !== total.credit) {
      throw new BadRequestException(`Ledger transaction is not balanced for asset ${assetId}`);
    }
  }
}

export function calculateAccountBalance(entries: LedgerBalanceEntry[]): Prisma.Decimal {
  const balance = entries.reduce((total, entry) => {
    const amount = toLedgerAtomicUnits(entry.amount);
    return entry.direction === LedgerEntryDirection.CREDIT
      ? total + amount
      : total - amount;
  }, 0n);
  return fromLedgerAtomicUnits(balance);
}
