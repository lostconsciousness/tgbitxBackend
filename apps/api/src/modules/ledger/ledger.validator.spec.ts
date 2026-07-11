import { BadRequestException } from '@nestjs/common';
import { LedgerEntryDirection } from '@prisma/client';
import { assertBalancedLedgerEntries, calculateAccountBalance } from './ledger.validator';

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
});
