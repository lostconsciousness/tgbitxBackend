import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LedgerService } from './ledger.service';

describe('LedgerService mainnet spot balance', () => {
  it('excludes legacy testnet internal-transfer credits from mainnet balance', async () => {
    const prisma = {
      ledgerAccount: {
        findUnique: jest.fn().mockResolvedValue({ id: 'spot-usdc' }),
      },
      ledgerEntry: {
        findMany: jest.fn(({ where, select }) => {
          if (select?.assetId) {
            return Promise.resolve([
              { assetId: 'usdc', direction: 'CREDIT', amount: new Prisma.Decimal('5') },
            ]);
          }
          if (where?.transaction?.type === 'CONVERT_TRADE') {
            return Promise.resolve([]);
          }
          const mainnet = where?.transaction?.creditedDeposit?.OR?.[0]
            ?.tokenContract?.network?.mainnet;
          return Promise.resolve(mainnet === false ? [{ amount: new Prisma.Decimal('5') }] : []);
        }),
      },
      withdrawal: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      conversion: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      network: {
        findMany: jest.fn(({ where }: { where: { mainnet: boolean } }) =>
          Promise.resolve([
            { legacyChain: where.mainnet ? 'ARBITRUM' : 'ARBITRUM_SEPOLIA' },
          ]),
        ),
      },
    };

    const service = new LedgerService(prisma as unknown as PrismaService);
    const balance = await service.getUserMainnetSpotBalance({
      userId: 'user-1',
      assetId: 'usdc',
    });

    expect(balance.toString()).toBe('0');
    const testnetCreditCall = prisma.ledgerEntry.findMany.mock.calls.find(
      ([query]) => query.where?.transaction?.creditedDeposit?.OR?.[0]
        ?.tokenContract?.network?.mainnet === false,
    );
    expect(testnetCreditCall?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          transaction: expect.objectContaining({
            creditedDeposit: expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  tokenContractId: null,
                  network: { in: ['ARBITRUM_SEPOLIA'] },
                }),
              ]),
            }),
          }),
        }),
      }),
    );
  });

  it('keeps mainnet deposits visible after testnet withdrawals reduce unified balance', async () => {
    const prisma = {
      ledgerAccount: {
        findUnique: jest.fn().mockResolvedValue({ id: 'spot-1' }),
      },
      ledgerEntry: {
        findMany: jest.fn(({ where, select }) => {
          if (select?.assetId) {
            return Promise.resolve([
              { assetId: 'sol', direction: 'CREDIT', amount: new Prisma.Decimal('4.267931') },
              { assetId: 'sol', direction: 'DEBIT', amount: new Prisma.Decimal('1') },
            ]);
          }
          if (where?.transaction?.type === 'CONVERT_TRADE') {
            return Promise.resolve([]);
          }
          const mainnet = where?.transaction?.creditedDeposit?.OR?.[0]
            ?.tokenContract?.network?.mainnet;
          return Promise.resolve(mainnet === false
            ? [{ amount: new Prisma.Decimal('4.2') }]
            : []);
        }),
      },
      withdrawal: {
        findMany: jest.fn().mockResolvedValue([
          { amount: new Prisma.Decimal('1'), feeAmount: new Prisma.Decimal('0') },
        ]),
      },
      conversion: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      network: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const service = new LedgerService(prisma as unknown as PrismaService);
    const balance = await service.getUserMainnetSpotBalance({
      userId: 'user-1',
      assetId: 'sol',
    });

    expect(balance.toString()).toBe('0.067931');
  });

  it('keeps mainnet convert output visible when legacy testnet deposits exceed unified balance', async () => {
    const prisma = {
      ledgerAccount: {
        findUnique: jest.fn().mockResolvedValue({ id: 'spot-usdc' }),
      },
      ledgerEntry: {
        findMany: jest.fn(({ where, select }) => {
          if (select?.assetId) {
            return Promise.resolve([
              { assetId: 'usdc', direction: 'CREDIT', amount: new Prisma.Decimal('10') },
              { assetId: 'usdc', direction: 'DEBIT', amount: new Prisma.Decimal('1.80548156944') },
              { assetId: 'usdc', direction: 'CREDIT', amount: new Prisma.Decimal('1.294518774') },
            ]);
          }
          if (where?.transaction?.type === 'CONVERT_TRADE') {
            return Promise.resolve([
              {
                amount: new Prisma.Decimal('1.294518774'),
                transaction: { referenceId: 'conversion-1' },
              },
            ]);
          }
          const mainnet = where?.transaction?.creditedDeposit?.OR?.[0]
            ?.tokenContract?.network?.mainnet;
          return Promise.resolve(mainnet === false
            ? [{ amount: new Prisma.Decimal('10') }]
            : [{ amount: new Prisma.Decimal('0') }]);
        }),
      },
      withdrawal: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      conversion: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'conversion-1', networkKey: 'arbitrum' },
        ]),
      },
      network: {
        findMany: jest.fn().mockResolvedValue([{ chainKey: 'arbitrum' }]),
      },
    };

    const service = new LedgerService(prisma as unknown as PrismaService);
    const balance = await service.getUserMainnetSpotBalance({
      userId: 'user-1',
      assetId: 'usdc',
    });

    expect(balance.toString()).toBe('1.294518774');
  });
});
