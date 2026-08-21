import { BadRequestException } from '@nestjs/common';
import { LedgerEntryDirection } from '@prisma/client';
import {
  assertBalancedLedgerEntries,
  calculateAccountBalance,
  toLedgerDecimal,
} from './ledger.validator';

describe('ledger validator', () => {
  it('accepts balanced debit and credit entries per asset', () => {
    expect(() =>
      assertBalancedLedgerEntries([
        { assetId: 'asset-usdc', direction: LedgerEntryDirection.DEBIT, amount: '10' },
        { assetId: 'asset-usdc', direction: LedgerEntryDirection.CREDIT, amount: '10' },
      ]),
    ).not.toThrow();
  });

  it('rejects unbalanced entries', () => {
    expect(() =>
      assertBalancedLedgerEntries([
        { assetId: 'asset-usdc', direction: LedgerEntryDirection.DEBIT, amount: '10' },
        { assetId: 'asset-usdc', direction: LedgerEntryDirection.CREDIT, amount: '9.99' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('calculates account balance as credits minus debits', () => {
    const balance = calculateAccountBalance([
      { assetId: 'asset-usdc', direction: LedgerEntryDirection.CREDIT, amount: '25' },
      { assetId: 'asset-usdc', direction: LedgerEntryDirection.DEBIT, amount: '4.5' },
    ]);

    expect(balance.toString()).toBe('20.5');
  });

  it('preserves all Decimal(38, 18) digits used by ledger postings', () => {
    const amount = toLedgerDecimal('105.903033967500000015');

    expect(amount.toFixed(18)).toBe('105.903033967500000015');
    expect(() => assertBalancedLedgerEntries([
      {
        assetId: 'asset-usdc',
        direction: LedgerEntryDirection.DEBIT,
        amount: '107.674838500000000000',
      },
      {
        assetId: 'asset-usdc',
        direction: LedgerEntryDirection.CREDIT,
        amount: '1.233849999999999985',
      },
      {
        assetId: 'asset-usdc',
        direction: LedgerEntryDirection.CREDIT,
        amount,
      },
      {
        assetId: 'asset-usdc',
        direction: LedgerEntryDirection.CREDIT,
        amount: '0.537954532500000000',
      },
    ])).not.toThrow();
  });
});
