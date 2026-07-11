import { BadRequestException } from '@nestjs/common';
import {
  AssetType,
  Chain,
  LedgerEntryDirection,
  NetworkFamily,
  TokenStandard,
  WithdrawalStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { LedgerService } from '../ledger/ledger.service';
import { WithdrawalsService } from './withdrawals.service';
import { ConfigService } from '@nestjs/config';
import { PrivyCustodyService } from '../treasury/privy-custody.service';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { OperationalSettingsService } from '../settings/operational-settings.service';

const asset = {
  id: 'asset-usdc',
  symbol: 'USDC',
  name: 'USD Coin',
  type: AssetType.STABLECOIN,
  chain: Chain.ARBITRUM,
  tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  decimals: 6,
  depositEnabled: true,
  withdrawalEnabled: true,
  withdrawalFeeAmount: '1',
  minWithdrawalAmount: '10',
  createdAt: new Date(),
  updatedAt: new Date(),
};
const network = {
  id: 'network-arbitrum',
  chainKey: 'arbitrum',
  family: NetworkFamily.EVM,
  legacyChain: Chain.ARBITRUM,
  chainId: 42161,
  withdrawalEnabled: true,
};
const tokenContract = {
  id: 'contract-usdc-arbitrum',
  address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  standard: TokenStandard.ERC20,
  decimals: 6,
  withdrawalEnabled: true,
  withdrawalFeeAmount: '1',
  minWithdrawalAmount: '10',
};

describe('WithdrawalsService', () => {
  let service: WithdrawalsService;
  let prisma: {
    withdrawal: {
      create: jest.Mock;
      update: jest.Mock;
      aggregate: jest.Mock;
      findFirst: jest.Mock;
    };
    network: {
      findUnique: jest.Mock;
    };
    tokenContract: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    userDepositAddress: {
      findFirst: jest.Mock;
    };
    withdrawalAddress: {
      upsert: jest.Mock;
    };
    deposit: {
      create: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let assetsService: jest.Mocked<Pick<AssetsService, 'getBySymbol'>>;
  let ledgerService: jest.Mocked<
    Pick<
      LedgerService,
      | 'assertSufficientUserSpotBalance'
      | 'postTransaction'
      | 'getUserSpotBalance'
      | 'getUserMainnetSpotBalance'
    >
  >;

  beforeEach(() => {
    prisma = {
      withdrawal: {
        create: jest.fn(),
        update: jest.fn(),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      network: {
        findUnique: jest.fn().mockResolvedValue(network),
      },
      tokenContract: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(
            where.assetId_networkId_standard.standard === TokenStandard.ERC20
              ? tokenContract
              : null,
          ),
        ),
        findMany: jest.fn().mockResolvedValue([
          {
            ...tokenContract,
            withdrawalFeeAmount: { toString: () => '1' },
            minWithdrawalAmount: { toString: () => '10' },
            contractVerifiedAt: new Date(),
            contractCodeHash: '0xabc',
            network: {
              chainKey: 'arbitrum',
              family: NetworkFamily.EVM,
              displayName: 'Arbitrum One',
              caip2: 'eip155:42161',
              chainId: 42161,
              withdrawalEnabled: true,
            },
          },
        ]),
      },
      userDepositAddress: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      withdrawalAddress: {
        upsert: jest.fn().mockResolvedValue({ firstSeenAt: new Date(0) }),
      },
      deposit: {
        create: jest.fn(),
      },
      $transaction: jest.fn(async (callback) => callback(prisma)),
    };
    assetsService = {
      getBySymbol: jest.fn().mockResolvedValue(asset),
    };
    ledgerService = {
      assertSufficientUserSpotBalance: jest.fn(),
      postTransaction: jest.fn().mockResolvedValue({ id: 'ledger-tx-1' }),
      getUserSpotBalance: jest.fn().mockResolvedValue({ toString: () => '42.5' }),
      getUserMainnetSpotBalance: jest.fn().mockResolvedValue({ toString: () => '42.5' }),
    };

    service = new WithdrawalsService(
      prisma as unknown as PrismaService,
      assetsService as unknown as AssetsService,
      ledgerService as unknown as LedgerService,
      {
        get: jest.fn((key: string, fallback?: unknown) => fallback),
      } as unknown as ConfigService,
      { isEnabled: jest.fn().mockReturnValue(false) } as unknown as PrivyCustodyService,
      {} as RpcProvider,
      {
        getBoolean: jest.fn().mockResolvedValue(false),
      } as unknown as OperationalSettingsService,
      {
        assertWorkerReady: jest.fn(),
      } as never,
      {
        record: jest.fn(),
      } as never,
      {
        ensureHotWalletFunded: jest.fn().mockResolvedValue(undefined),
        ensureHotWalletNativeGas: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        enrichAndSortByBalanceUsdc: jest.fn(async (assets, getBalance) =>
          [...assets]
            .map((asset) => ({
              ...asset,
              priceUsdc: asset.symbol === 'USDC' ? '1' : '3050',
              balanceValueUsdc:
                asset.symbol === 'USDC'
                  ? getBalance(asset)
                  : (Number(getBalance(asset)) * 3050).toString(),
            }))
            .sort((left, right) => {
              const leftValue = Number(left.balanceValueUsdc ?? 0);
              const rightValue = Number(right.balanceValueUsdc ?? 0);
              return rightValue - leftValue || left.symbol.localeCompare(right.symbol);
            }),
        ),
        loadNativePricesUsd: jest.fn().mockResolvedValue({ ETH: '3050' }),
      } as never,
      {
        validateAddress: jest.fn().mockResolvedValue(undefined),
        sendWithdrawal: jest.fn(),
        confirmWithdrawal: jest.fn(),
      } as never,
    );
  });

  it('returns unified exchange balance with per-network withdrawal options', async () => {
    const result = await service.getWithdrawalNetworks('user-1', 'USDC');

    expect(result.availableBalance).toBe('42.5');
    expect(result.balanceScope).toBe('EXCHANGE_LEDGER');
    expect(result.networks).toEqual([
      expect.objectContaining({
        network: 'arbitrum',
        withdrawalEnabled: true,
        withdrawalFeeAmount: '0.75',
        minWithdrawalAmount: '10',
        nativeGasSymbol: 'ETH',
        gasPaidByExchange: false,
      }),
    ]);
  });

  it('lists all assets with balances for the withdrawal picker', async () => {
    prisma.tokenContract.findMany.mockResolvedValue([
      {
        standard: TokenStandard.NATIVE,
        address: null,
        decimals: 18,
        withdrawalEnabled: true,
        withdrawalFeeAmount: { toString: () => '0' },
        minWithdrawalAmount: { toString: () => '0' },
        contractVerifiedAt: new Date(),
        contractCodeHash: null,
        asset: {
          id: 'asset-eth',
          symbol: 'ETH',
          name: 'Ether',
          iconUrl: null,
          type: 'CRYPTO',
          decimals: 18,
        },
        network: {
          chainKey: 'arbitrum-sepolia',
          family: NetworkFamily.EVM,
          displayName: 'Arbitrum Sepolia',
          iconUrl: null,
          caip2: 'eip155:421614',
          chainId: 421614,
          withdrawalEnabled: true,
        },
      },
      {
        standard: TokenStandard.ERC20,
        address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
        decimals: 6,
        withdrawalEnabled: true,
        withdrawalFeeAmount: { toString: () => '0' },
        minWithdrawalAmount: { toString: () => '0.000001' },
        contractVerifiedAt: new Date(),
        contractCodeHash: '0xabc',
        asset: {
          id: 'asset-usdc',
          symbol: 'USDC',
          name: 'USD Coin',
          iconUrl: null,
          type: 'STABLECOIN',
          decimals: 6,
        },
        network: {
          chainKey: 'arbitrum-sepolia',
          family: NetworkFamily.EVM,
          displayName: 'Arbitrum Sepolia',
          iconUrl: null,
          caip2: 'eip155:421614',
          chainId: 421614,
          withdrawalEnabled: true,
        },
      },
    ]);

    const result = await service.listWithdrawalOptions('user-1');

    expect(result.balanceScope).toBe('EXCHANGE_LEDGER');
    expect(result.assets).toHaveLength(2);
    expect(result.assets[0]).toEqual(
      expect.objectContaining({
        symbol: 'ETH',
        availableBalance: '42.5',
        networks: [expect.objectContaining({ network: 'arbitrum-sepolia', withdrawalEnabled: true })],
      }),
    );
  });

  it('returns native withdrawal options when a native token contract is configured', async () => {
    prisma.tokenContract.findMany.mockResolvedValue([
      {
        id: 'contract-eth-base-sepolia',
        address: null,
        standard: TokenStandard.NATIVE,
        decimals: 18,
        withdrawalEnabled: true,
        withdrawalFeeAmount: { toString: () => '0.001' },
        minWithdrawalAmount: { toString: () => '0.01' },
        contractVerifiedAt: new Date(),
        contractCodeHash: null,
        network: {
          chainKey: 'base-sepolia',
          family: NetworkFamily.EVM,
          displayName: 'Base Sepolia',
          caip2: 'eip155:84532',
          chainId: 84532,
          withdrawalEnabled: true,
        },
      },
    ]);

    const result = await service.getWithdrawalNetworks('user-1', 'ETH');

    expect(result.networks).toEqual([
      expect.objectContaining({
        network: 'base-sepolia',
        tokenStandard: TokenStandard.NATIVE,
        tokenAddress: null,
        withdrawalEnabled: true,
      }),
    ]);
  });

  it('returns enabled non-EVM testnet withdrawal options when configured', async () => {
    (service as unknown as { config: { get: jest.Mock } }).config.get.mockImplementation(
      (key: string, fallback?: unknown) =>
        key === 'SOLANA_DEVNET_WITHDRAWAL_PRIVATE_KEY' ? 'test-secret' : fallback,
    );
    prisma.tokenContract.findMany.mockResolvedValue([
      {
        standard: TokenStandard.SPL,
        address: 'So11111111111111111111111111111111111111112',
        decimals: 9,
        withdrawalEnabled: true,
        withdrawalFeeAmount: { toString: () => '0' },
        minWithdrawalAmount: { toString: () => '0' },
        contractVerifiedAt: new Date(),
        contractCodeHash: null,
        network: {
          chainKey: 'solana-devnet',
          family: NetworkFamily.SVM,
          mainnet: false,
          displayName: 'Solana Devnet',
          caip2: 'solana:devnet',
          chainId: null,
          withdrawalEnabled: true,
        },
      },
    ]);

    const result = await service.getWithdrawalNetworks('user-1', 'SOL');

    expect(result.networks).toEqual([
      expect.objectContaining({
        family: NetworkFamily.SVM,
        network: 'solana-devnet',
        tokenStandard: TokenStandard.SPL,
        withdrawalEnabled: true,
        disabledReason: null,
      }),
    ]);
  });

  it('does not create a withdrawal when available balance is insufficient', async () => {
    ledgerService.assertSufficientUserSpotBalance.mockRejectedValue(
      new BadRequestException('Insufficient available balance'),
    );

    await expect(
      service.requestWithdrawal('user-1', {
        assetSymbol: 'USDC',
        toAddress: '0x0000000000000000000000000000000000000000',
        amount: '100',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.withdrawal.create).not.toHaveBeenCalled();
    expect(ledgerService.postTransaction).not.toHaveBeenCalled();
  });

  it('reserves withdrawal amount and fee with balanced ledger entries', async () => {
    prisma.withdrawal.create.mockResolvedValue({
      id: 'withdrawal-1',
      userId: 'user-1',
      assetId: asset.id,
      asset,
      toAddress: '0x0000000000000000000000000000000000000000',
      amount: '100',
      feeAmount: '1',
      status: WithdrawalStatus.REQUESTED,
    });
    prisma.withdrawal.update.mockResolvedValue({
      id: 'withdrawal-1',
      status: WithdrawalStatus.PENDING_APPROVAL,
      asset,
    });

    await service.requestWithdrawal('user-1', {
      assetSymbol: 'USDC',
      toAddress: '0x0000000000000000000000000000000000000000',
      amount: '100',
    });

    expect(ledgerService.postTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'withdrawal-reserve:withdrawal-1',
        entries: expect.arrayContaining([
          expect.objectContaining({
            direction: LedgerEntryDirection.DEBIT,
            amount: expect.objectContaining({ toString: expect.any(Function) }),
          }),
          expect.objectContaining({
            direction: LedgerEntryDirection.CREDIT,
            amount: expect.objectContaining({ toString: expect.any(Function) }),
          }),
        ]),
      }),
      expect.anything(),
    );

    const firstCall = ledgerService.postTransaction.mock.calls[0];
    expect(firstCall).toBeDefined();
    const posting = firstCall![0];
    const debit = posting.entries
      .filter((entry) => entry.direction === LedgerEntryDirection.DEBIT)
      .reduce((sum, entry) => sum + Number(entry.amount.toString()), 0);
    const credit = posting.entries
      .filter((entry) => entry.direction === LedgerEntryDirection.CREDIT)
      .reduce((sum, entry) => sum + Number(entry.amount.toString()), 0);

    expect(debit).toBe(100.75);
    expect(credit).toBe(100.75);
    expect(prisma.withdrawal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminApprovalRequired: false,
        }),
      }),
    );
    expect(prisma.withdrawal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WithdrawalStatus.APPROVED,
          approvalReason: 'Auto-approved by withdrawal policy',
        }),
      }),
    );
  });

  it('keeps large withdrawals pending for manual approval', async () => {
    prisma.withdrawal.create.mockResolvedValue({
      id: 'withdrawal-1',
      userId: 'user-1',
      assetId: asset.id,
      asset,
      toAddress: '0x0000000000000000000000000000000000000000',
      amount: '1500',
      feeAmount: '1',
      status: WithdrawalStatus.REQUESTED,
    });
    prisma.withdrawal.update.mockResolvedValue({
      id: 'withdrawal-1',
      status: WithdrawalStatus.PENDING_APPROVAL,
      asset,
    });

    await service.requestWithdrawal('user-1', {
      assetSymbol: 'USDC',
      toAddress: '0x0000000000000000000000000000000000000000',
      amount: '1500',
    });

    expect(prisma.withdrawal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          adminApprovalRequired: true,
        }),
      }),
    );
    expect(prisma.withdrawal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WithdrawalStatus.PENDING_APPROVAL,
        }),
      }),
    );
  });

  it('settles withdrawal to another user deposit address internally', async () => {
    prisma.userDepositAddress.findFirst.mockResolvedValue({
      id: 'deposit-address-1',
      userId: 'recipient-1',
      address: '0x0000000000000000000000000000000000000000',
      network: Chain.ARBITRUM,
      status: 'ACTIVE',
    });
    prisma.withdrawal.create.mockResolvedValue({
      id: 'withdrawal-1',
      userId: 'user-1',
      assetId: asset.id,
      asset,
      toAddress: '0x0000000000000000000000000000000000000000',
      amount: '10',
      feeAmount: '0',
      status: WithdrawalStatus.CONFIRMED,
    });
    prisma.withdrawal.update.mockResolvedValue({
      id: 'withdrawal-1',
      status: WithdrawalStatus.CONFIRMED,
      asset,
    });

    await service.requestWithdrawal('user-1', {
      assetSymbol: 'USDC',
      toAddress: '0x0000000000000000000000000000000000000000',
      amount: '10',
    });

    expect(prisma.withdrawalAddress.upsert).not.toHaveBeenCalled();
    expect(ledgerService.assertSufficientUserSpotBalance).toHaveBeenCalledWith(
      expect.objectContaining({ mainnetOnly: false }),
      expect.anything(),
    );
    expect(ledgerService.postTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'internal-transfer:withdrawal-1',
        entries: expect.arrayContaining([
          expect.objectContaining({
            userId: 'user-1',
            direction: LedgerEntryDirection.DEBIT,
          }),
          expect.objectContaining({
            userId: 'recipient-1',
            direction: LedgerEntryDirection.CREDIT,
          }),
        ]),
      }),
      expect.anything(),
    );
    expect(prisma.deposit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'recipient-1',
          depositAddressId: 'deposit-address-1',
          status: 'CREDITED',
          txHash: 'internal:withdrawal-1',
        }),
      }),
    );
  });

  it('requires mainnet-only funds for an internal transfer in mainnet mode', async () => {
    (service as unknown as { config: { get: jest.Mock } }).config.get.mockImplementation(
      (key: string, fallback?: unknown) => key === 'MAINNET_ENABLED' ? true : fallback,
    );
    prisma.network.findUnique.mockResolvedValue({ ...network, mainnet: true });
    prisma.userDepositAddress.findFirst.mockResolvedValue({
      id: 'deposit-address-1',
      userId: 'recipient-1',
      address: '0x0000000000000000000000000000000000000000',
      network: Chain.ARBITRUM,
      status: 'ACTIVE',
    });
    prisma.withdrawal.create.mockResolvedValue({
      id: 'withdrawal-1',
      userId: 'user-1',
      assetId: asset.id,
      asset,
      toAddress: '0x0000000000000000000000000000000000000000',
      amount: '10',
      feeAmount: '0',
      status: WithdrawalStatus.CONFIRMED,
    });
    prisma.withdrawal.update.mockResolvedValue({
      id: 'withdrawal-1',
      status: WithdrawalStatus.CONFIRMED,
      asset,
    });

    await service.requestWithdrawal('user-1', {
      assetSymbol: 'USDC',
      network: 'arbitrum',
      toAddress: '0x0000000000000000000000000000000000000000',
      amount: '10',
    });

    expect(ledgerService.assertSufficientUserSpotBalance).toHaveBeenCalledWith(
      expect.objectContaining({ mainnetOnly: true }),
      expect.anything(),
    );
  });

  it('hides testnet withdrawal options when mainnet display mode is enabled', async () => {
    const mainnetNetwork = {
      ...network,
      mainnet: true,
    };
    const sepoliaNetwork = {
      id: 'network-arbitrum-sepolia',
      chainKey: 'arbitrum-sepolia',
      family: NetworkFamily.EVM,
      legacyChain: Chain.ARBITRUM_SEPOLIA,
      chainId: 421614,
      mainnet: false,
      withdrawalEnabled: true,
    };
    const contracts = [
      {
        ...tokenContract,
        network: mainnetNetwork,
        asset,
        contractVerifiedAt: new Date(),
        contractCodeHash: '0xabc',
        withdrawalFeeAmount: { toString: () => '1' },
        minWithdrawalAmount: { toString: () => '0' },
      },
      {
        ...tokenContract,
        id: 'contract-usdc-sepolia',
        network: sepoliaNetwork,
        asset,
        contractVerifiedAt: new Date(),
        contractCodeHash: '0xabc',
        withdrawalFeeAmount: { toString: () => '1' },
        minWithdrawalAmount: { toString: () => '0' },
      },
    ];
    const mainnetService = new WithdrawalsService(
      {
        tokenContract: {
          findMany: jest.fn(({ where }) =>
            Promise.resolve(
              where?.network?.mainnet === true
                ? contracts.filter((contract) => contract.network.mainnet)
                : contracts,
            ),
          ),
        },
      } as unknown as PrismaService,
      assetsService as unknown as AssetsService,
      ledgerService as unknown as LedgerService,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'MAINNET_ENABLED' ? true : fallback,
        ),
      } as unknown as ConfigService,
      { isEnabled: jest.fn().mockReturnValue(false) } as unknown as PrivyCustodyService,
      {} as RpcProvider,
      { getBoolean: jest.fn().mockResolvedValue(false) } as unknown as OperationalSettingsService,
      { assertWorkerReady: jest.fn() } as never,
      { record: jest.fn() } as never,
      {
        ensureHotWalletFunded: jest.fn(),
        ensureHotWalletNativeGas: jest.fn(),
      } as never,
      {
        enrichAndSortByBalanceUsdc: jest.fn(async (assets) => assets),
        loadNativePricesUsd: jest.fn().mockResolvedValue({ ETH: '3050' }),
      } as never,
      { validateAddress: jest.fn(), sendWithdrawal: jest.fn(), confirmWithdrawal: jest.fn() } as never,
    );

    const result = await mainnetService.listWithdrawalOptions('user-1');

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.networks).toEqual([
      expect.objectContaining({ network: 'arbitrum', chainId: 42161 }),
    ]);
    expect(ledgerService.getUserMainnetSpotBalance).toHaveBeenCalled();
  });

  it('hides assets with only testnet ledger balance in mainnet mode', async () => {
    prisma.tokenContract.findMany.mockResolvedValue([
      {
        standard: TokenStandard.ERC20,
        address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
        decimals: 6,
        withdrawalEnabled: true,
        withdrawalFeeAmount: { toString: () => '0' },
        minWithdrawalAmount: { toString: () => '0' },
        contractVerifiedAt: new Date(),
        contractCodeHash: '0xabc',
        asset: {
          id: 'asset-sol',
          symbol: 'SOL',
          name: 'Solana',
          iconUrl: null,
          type: 'CRYPTO',
          decimals: 9,
        },
        network: {
          chainKey: 'solana',
          family: NetworkFamily.SVM,
          displayName: 'Solana',
          iconUrl: null,
          caip2: 'solana:mainnet',
          chainId: null,
          mainnet: true,
          withdrawalEnabled: true,
        },
      },
    ]);
    ledgerService.getUserMainnetSpotBalance.mockResolvedValue({ toString: () => '0' } as never);

    const mainnetService = new WithdrawalsService(
      prisma as unknown as PrismaService,
      assetsService as unknown as AssetsService,
      ledgerService as unknown as LedgerService,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'MAINNET_ENABLED' ? true : fallback,
        ),
      } as unknown as ConfigService,
      { isEnabled: jest.fn().mockReturnValue(false) } as unknown as PrivyCustodyService,
      {} as RpcProvider,
      { getBoolean: jest.fn().mockResolvedValue(false) } as unknown as OperationalSettingsService,
      { assertWorkerReady: jest.fn() } as never,
      { record: jest.fn() } as never,
      {
        ensureHotWalletFunded: jest.fn(),
        ensureHotWalletNativeGas: jest.fn(),
      } as never,
      {
        enrichAndSortByBalanceUsdc: jest.fn(async (assets) => assets),
        loadNativePricesUsd: jest.fn().mockResolvedValue({ ETH: '3050' }),
      } as never,
      { validateAddress: jest.fn(), sendWithdrawal: jest.fn(), confirmWithdrawal: jest.fn() } as never,
    );

    const result = await mainnetService.listWithdrawalOptions('user-1');

    expect(result.assets).toEqual([]);
  });
});
