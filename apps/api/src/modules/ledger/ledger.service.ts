import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Chain,
  DepositStatus,
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
  Prisma,
  WithdrawalStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { assertBalancedLedgerEntries, calculateAccountBalance, toDecimal } from './ledger.validator';

export type LedgerPostingEntry = {
  accountType: LedgerAccountType;
  userId?: string;
  assetId: string;
  direction: LedgerEntryDirection;
  amount: Prisma.Decimal | string | number;
};

export type PostLedgerTransactionInput = {
  type: LedgerTransactionType;
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
  entries: LedgerPostingEntry[];
};

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async postTransaction(
    input: PostLedgerTransactionInput,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const existing = await client.ledgerTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { entries: true },
    });

    if (existing) {
      return existing;
    }

    const entries = input.entries.map((entry) => ({
      ...entry,
      amount: toDecimal(entry.amount),
    }));

    assertBalancedLedgerEntries(entries);

    const accounts = await Promise.all(
      entries.map((entry) =>
        this.getOrCreateAccount({
          type: entry.accountType,
          userId: entry.userId,
          assetId: entry.assetId,
        }, client),
      ),
    );

    return client.ledgerTransaction.create({
      data: {
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        description: input.description,
        metadata: input.metadata,
        entries: {
          create: entries.map((entry, index) => {
            const account = accounts[index];
            if (!account) {
              throw new BadRequestException('Ledger account resolution failed');
            }

            return {
              accountId: account.id,
              assetId: entry.assetId,
              direction: entry.direction,
              amount: entry.amount,
            };
          }),
        },
      },
      include: { entries: true },
    });
  }

  getOrCreateAccount(
    input: { type: LedgerAccountType; userId?: string; assetId: string },
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const key = this.makeAccountKey(input);
    return client.ledgerAccount.upsert({
      where: { key },
      update: {},
      create: {
        key,
        type: input.type,
        userId: input.userId,
        assetId: input.assetId,
      },
    });
  }

  async getUserSpotBalance(
    input: { userId: string; assetId: string },
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<Prisma.Decimal> {
    const account = await client.ledgerAccount.findUnique({
      where: {
        key: this.makeAccountKey({
          type: LedgerAccountType.USER_SPOT,
          userId: input.userId,
          assetId: input.assetId,
        }),
      },
    });

    if (!account) {
      return new Prisma.Decimal(0);
    }

    const entries = await client.ledgerEntry.findMany({
      where: {
        accountId: account.id,
        transaction: { status: 'POSTED' },
      },
      select: {
        assetId: true,
        direction: true,
        amount: true,
      },
    });

    return calculateAccountBalance(entries);
  }

  async getUserMainnetSpotBalance(
    input: { userId: string; assetId: string },
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<Prisma.Decimal> {
    const full = await this.getUserSpotBalance(input, client);
    const [testnetCredits, testnetWithdrawals, mainnetConvertCredits, mainnetDepositCredits] =
      await Promise.all([
        this.sumCreditedDepositCredits(
          { userId: input.userId, assetId: input.assetId, mainnet: false },
          client,
        ),
        this.sumActiveWithdrawalSpotExposure(
          { userId: input.userId, assetId: input.assetId, mainnet: false },
          client,
        ),
        this.sumMainnetConversionTradeCredits(input, client),
        this.sumCreditedDepositCredits(
          { userId: input.userId, assetId: input.assetId, mainnet: true },
          client,
        ),
      ]);
    const testnetNet = testnetCredits.minus(testnetWithdrawals);
    const mainnetOnly = full.minus(testnetNet);
    if (mainnetOnly.greaterThanOrEqualTo(0)) {
      return mainnetOnly;
    }
    const mainnetAttributed = mainnetConvertCredits.plus(mainnetDepositCredits);
    const visible = mainnetAttributed.greaterThan(full) ? full : mainnetAttributed;
    return visible.lessThan(0) ? new Prisma.Decimal(0) : visible;
  }

  private async sumMainnetConversionTradeCredits(
    input: { userId: string; assetId: string },
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<Prisma.Decimal> {
    const account = await client.ledgerAccount.findUnique({
      where: {
        key: this.makeAccountKey({
          type: LedgerAccountType.USER_SPOT,
          userId: input.userId,
          assetId: input.assetId,
        }),
      },
      select: { id: true },
    });
    if (!account) {
      return new Prisma.Decimal(0);
    }

    const entries = await client.ledgerEntry.findMany({
      where: {
        accountId: account.id,
        direction: LedgerEntryDirection.CREDIT,
        transaction: {
          status: 'POSTED',
          type: LedgerTransactionType.CONVERT_TRADE,
          referenceType: 'Conversion',
        },
      },
      select: {
        amount: true,
        transaction: { select: { referenceId: true } },
      },
    });
    if (entries.length === 0) {
      return new Prisma.Decimal(0);
    }

    const conversionIds = [
      ...new Set(
        entries
          .map((entry) => entry.transaction.referenceId)
          .filter((referenceId): referenceId is string => Boolean(referenceId)),
      ),
    ];
    if (conversionIds.length === 0) {
      return new Prisma.Decimal(0);
    }

    const [conversions, mainnetNetworks] = await Promise.all([
      client.conversion.findMany({
        where: {
          id: { in: conversionIds },
          userId: input.userId,
          status: 'FILLED',
        },
        select: { id: true, networkKey: true },
      }),
      client.network.findMany({
        where: { mainnet: true },
        select: { chainKey: true },
      }),
    ]);
    const mainnetNetworkKeys = new Set(mainnetNetworks.map((network) => network.chainKey));
    const mainnetConversionIds = new Set(
      conversions
        .filter(
          (conversion) =>
            conversion.networkKey && mainnetNetworkKeys.has(conversion.networkKey),
        )
        .map((conversion) => conversion.id),
    );

    return entries.reduce((sum, entry) => {
      const referenceId = entry.transaction.referenceId;
      if (!referenceId || !mainnetConversionIds.has(referenceId)) {
        return sum;
      }
      return sum.plus(entry.amount);
    }, new Prisma.Decimal(0));
  }

  private async sumActiveWithdrawalSpotExposure(
    input: { userId: string; assetId: string; mainnet: boolean },
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<Prisma.Decimal> {
    const legacyChains = await this.getLegacyChainsForScope(input.mainnet, client);
    const withdrawals = await client.withdrawal.findMany({
      where: {
        userId: input.userId,
        assetId: input.assetId,
        status: {
          notIn: [
            WithdrawalStatus.FAILED,
            WithdrawalStatus.CANCELLED,
            WithdrawalStatus.REJECTED,
          ],
        },
        OR: [
          { tokenContract: { network: { mainnet: input.mainnet } } },
          {
            tokenContractId: null,
            network: { in: legacyChains },
          },
        ],
      },
      select: { amount: true, feeAmount: true },
    });

    return withdrawals.reduce(
      (sum, withdrawal) => sum.plus(withdrawal.amount).plus(withdrawal.feeAmount),
      new Prisma.Decimal(0),
    );
  }

  private async sumCreditedDepositCredits(
    input: { userId: string; assetId: string; mainnet: boolean },
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<Prisma.Decimal> {
    const account = await client.ledgerAccount.findUnique({
      where: {
        key: this.makeAccountKey({
          type: LedgerAccountType.USER_SPOT,
          userId: input.userId,
          assetId: input.assetId,
        }),
      },
      select: { id: true },
    });
    if (!account) {
      return new Prisma.Decimal(0);
    }
    const legacyChains = await this.getLegacyChainsForScope(input.mainnet, client);

    const entries = await client.ledgerEntry.findMany({
      where: {
        accountId: account.id,
        direction: LedgerEntryDirection.CREDIT,
        transaction: {
          status: 'POSTED',
          creditedDeposit: {
            userId: input.userId,
            assetId: input.assetId,
            status: DepositStatus.CREDITED,
            OR: [
              { tokenContract: { network: { mainnet: input.mainnet } } },
              {
                tokenContractId: null,
                network: { in: legacyChains },
              },
            ],
          },
        },
      },
      select: { amount: true },
    });

    return entries.reduce(
      (sum, entry) => sum.plus(entry.amount),
      new Prisma.Decimal(0),
    );
  }

  private async getLegacyChainsForScope(
    mainnet: boolean,
    client: PrismaService | Prisma.TransactionClient,
  ): Promise<Chain[]> {
    const networks = await client.network.findMany({
      where: { mainnet, legacyChain: { not: null } },
      select: { legacyChain: true },
    });
    return networks
      .map((network) => network.legacyChain)
      .filter((chain): chain is Chain => chain !== null);
  }

  async listUserSpotBalances(userId: string) {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: {
        userId,
        type: LedgerAccountType.USER_SPOT,
      },
      include: { asset: true },
      orderBy: { createdAt: 'asc' },
    });

    return Promise.all(
      accounts.map(async (account) => ({
        asset: account.asset,
        balance: await this.getUserSpotBalance({ userId, assetId: account.assetId }),
      })),
    );
  }

  async getTotalAccountTypeBalance(input: {
    assetId: string;
    accountType: LedgerAccountType;
  }, client: PrismaService | Prisma.TransactionClient = this.prisma): Promise<Prisma.Decimal> {
    const accounts = await client.ledgerAccount.findMany({
      where: { assetId: input.assetId, type: input.accountType },
      select: { id: true },
    });
    if (accounts.length === 0) {
      return new Prisma.Decimal(0);
    }
    const entries = await client.ledgerEntry.findMany({
      where: {
        accountId: { in: accounts.map((account) => account.id) },
        transaction: { status: 'POSTED' },
      },
      select: { assetId: true, direction: true, amount: true },
    });
    return calculateAccountBalance(entries);
  }

  async assertSufficientUserSpotBalance(input: {
    userId: string;
    assetId: string;
    amount: Prisma.Decimal | string | number;
    mainnetOnly?: boolean;
  }, client: PrismaService | Prisma.TransactionClient = this.prisma): Promise<void> {
    const required = toDecimal(input.amount);
    const balance = input.mainnetOnly
      ? await this.getUserMainnetSpotBalance(
          { userId: input.userId, assetId: input.assetId },
          client,
        )
      : await this.getUserSpotBalance(
          { userId: input.userId, assetId: input.assetId },
          client,
        );

    if (balance.lessThan(required)) {
      throw new BadRequestException('Insufficient available balance');
    }
  }

  private makeAccountKey(input: { type: LedgerAccountType; userId?: string; assetId: string }) {
    const owner = input.userId ?? 'platform';
    return `${input.type}:${input.assetId}:${owner}`;
  }
}
