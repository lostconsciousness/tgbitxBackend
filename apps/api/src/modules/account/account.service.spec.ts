import {
  AssetType,
  Chain,
  UserDepositAddressStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';

jest.mock('../hyperliquid/hyperliquid-order-format', () => ({
  formatHyperliquidPrice: (price: string) => price,
  formatHyperliquidSize: (size: string) => size,
}));

import { PrismaService } from '../../database/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { AccountService } from './account.service';
import { AssetValuationService } from './asset-valuation.service';

describe('AccountService', () => {
  it('returns current user and balances for all configured assets', async () => {
    const prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'user-1',
          email: 'trader@example.com',
          role: UserRole.USER,
          status: UserStatus.ACTIVE,
          createdAt: new Date('2026-06-11T00:00:00.000Z'),
        }),
      },
      asset: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'asset-usdc',
            symbol: 'USDC',
            name: 'USD Coin',
            type: AssetType.STABLECOIN,
            chain: Chain.ARBITRUM,
            tokenAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
            decimals: 6,
            depositEnabled: true,
            withdrawalEnabled: true,
            tokenContracts: [
              {
                standard: 'ERC20',
                address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
                decimals: 6,
                depositEnabled: true,
                withdrawalEnabled: true,
                withdrawalFeeAmount: '0',
                minWithdrawalAmount: '0.000001',
                contractVerifiedAt: new Date('2026-06-11T00:00:00.000Z'),
                contractCodeHash: '0xabc',
                verifiedChainId: 421614,
                network: {
                  family: 'EVM',
                  chainKey: 'arbitrum-sepolia',
                  displayName: 'Arbitrum Sepolia',
                  caip2: 'eip155:421614',
                  chainId: 421614,
                  depositEnabled: true,
                  withdrawalEnabled: true,
                  confirmations: 12,
                },
              },
            ],
          },
          {
            id: 'asset-eth',
            symbol: 'ETH',
            name: 'Ether',
            type: AssetType.CRYPTO,
            chain: Chain.ARBITRUM,
            tokenAddress: null,
            decimals: 18,
            depositEnabled: true,
            withdrawalEnabled: true,
            tokenContracts: [],
          },
        ]),
      },
      network: {
        findMany: jest.fn().mockResolvedValue([
          {
            chainKey: 'arbitrum-sepolia',
            displayName: 'Arbitrum Sepolia',
            family: 'EVM',
            legacyChain: Chain.ARBITRUM_SEPOLIA,
            caip2: 'eip155:421614',
            chainId: 421614,
          },
        ]),
      },
      wallet: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'wallet-1',
            type: 'EMBEDDED',
            provider: 'PRIVY',
            address: '0x37dac4b1db88bef0955fe777838a08eb3f5a1346',
            chain: Chain.ARBITRUM,
            label: null,
            status: 'ACTIVE',
            isPrimary: true,
            verifiedAt: new Date('2026-06-11T00:00:00.000Z'),
            createdAt: new Date('2026-06-11T00:00:00.000Z'),
          },
        ]),
      },
      userDepositAddress: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'deposit-address-1',
            network: Chain.ARBITRUM_SEPOLIA,
            address: '0xAfC991Ba121E3E8a96C248b9d83DE4d543c09631',
            status: UserDepositAddressStatus.ACTIVE,
            createdAt: new Date('2026-06-11T00:00:00.000Z'),
          },
        ]),
      },
      order: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      position: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      depositIntent: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      deposit: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
      market: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'market-eth-usdc',
            symbol: 'ETH-PERP',
            type: 'PERP',
            baseAssetId: 'asset-eth',
            quoteAssetId: 'asset-usdc',
            baseAsset: {
              id: 'asset-eth',
              symbol: 'ETH',
            },
            quoteAsset: {
              id: 'asset-usdc',
              symbol: 'USDC',
            },
          },
        ]),
      },
    } as unknown as PrismaService;
    const ledgerService = {
      getUserSpotBalance: jest.fn().mockImplementation(({ assetId }: { assetId: string }) =>
        Promise.resolve({ toString: () => (assetId === 'asset-eth' ? '2' : '42.5') }),
      ),
    } as unknown as LedgerService;
    const marketDataService = {
      getOrderBook: jest.fn().mockResolvedValue({
        bids: [{ price: '3000', size: '1' }],
        asks: [{ price: '3100', size: '1' }],
      }),
    };
    const rpcProvider = {
      getBalance: jest.fn().mockImplementation(
        (_address: string, token?: string, _networkKey?: string) =>
          Promise.resolve({
            address: _address,
            token,
            value: token ? '20' : '100000000000000000',
          }),
      ),
    } as unknown as RpcProvider;
    const assetValuation = new AssetValuationService(
      prisma,
      marketDataService as never,
    );
    const positionsService = {
      listUserPositions: jest.fn().mockResolvedValue([]),
    };
    const service = new AccountService(
      prisma,
      ledgerService,
      marketDataService as never,
      assetValuation,
      rpcProvider,
      { getBalance: jest.fn() } as never,
      { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      positionsService as never,
    );

    const overview = await service.getOverview('user-1');

    expect(overview.user.email).toBe('trader@example.com');
    expect(overview.balances).toEqual([
      expect.objectContaining({
        asset: expect.objectContaining({
          symbol: 'USDC',
          networks: [
            expect.objectContaining({
              network: 'arbitrum-sepolia',
              displayName: 'Arbitrum Sepolia',
              chainId: 421614,
              tokenAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
              depositEnabled: true,
              withdrawalEnabled: true,
              contractVerified: true,
            }),
          ],
        }),
        balance: '42.5',
        available: '42.5',
        total: '42.5',
        pendingDeposit: '0',
        priceUsdc: '1',
        valueUsdc: '42.5',
        balanceUsdc: '42.5',
      }),
      expect.objectContaining({
        asset: expect.objectContaining({ symbol: 'ETH' }),
        balance: '2',
        available: '2',
        total: '2',
        pendingDeposit: '0',
        priceUsdc: '3050',
        valueUsdc: '6100',
        balanceUsdc: '6100',
        balanceValueUsdc: '6100',
        availableValueUsdc: '6100',
        totalValueUsdc: '6100',
        priceStatus: 'AVAILABLE',
      }),
    ]);
    expect(overview.portfolio).toEqual(expect.objectContaining({
      currency: 'USDC',
      totalUsdc: '6142.5',
      priceStatus: 'AVAILABLE',
      assets: overview.balances,
    }));
    expect(overview.depositAddresses).toEqual([
      expect.objectContaining({
        id: 'deposit-address-1',
        address: '0xAfC991Ba121E3E8a96C248b9d83DE4d543c09631',
      }),
    ]);
    expect(overview.connectedWalletBalances).toEqual([]);
    expect(overview.onChainBalances).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'PERSONAL_DEPOSIT_ADDRESS',
        depositAddressId: 'deposit-address-1',
        address: '0xAfC991Ba121E3E8a96C248b9d83DE4d543c09631',
        network: expect.objectContaining({ network: 'arbitrum-sepolia' }),
      }),
    ]));
  });

  it('hides testnet-only credited assets from overview in mainnet mode', async () => {
    const mainnetNetwork = {
      chainKey: 'arbitrum',
      displayName: 'Arbitrum One',
      family: 'EVM',
      legacyChain: Chain.ARBITRUM,
      caip2: 'eip155:42161',
      chainId: 42161,
      depositEnabled: true,
      withdrawalEnabled: true,
      confirmations: 12,
      mainnet: true,
      iconUrl: null,
    };
    const testnetNetwork = {
      chainKey: 'arbitrum-sepolia',
      displayName: 'Arbitrum Sepolia',
      family: 'EVM',
      legacyChain: Chain.ARBITRUM_SEPOLIA,
      caip2: 'eip155:421614',
      chainId: 421614,
      depositEnabled: true,
      withdrawalEnabled: true,
      confirmations: 12,
      mainnet: false,
      iconUrl: null,
    };
    const usdcContract = {
      standard: 'ERC20',
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      decimals: 6,
      depositEnabled: true,
      withdrawalEnabled: true,
      withdrawalFeeAmount: { toString: () => '0' },
      minWithdrawalAmount: { toString: () => '1' },
      contractVerifiedAt: new Date('2026-06-11T00:00:00.000Z'),
      contractCodeHash: '0xabc',
      verifiedChainId: 42161,
      network: mainnetNetwork,
    };
    const testnetOnlyContract = {
      ...usdcContract,
      address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      verifiedChainId: 421614,
      network: testnetNetwork,
    };
    const prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'user-1',
          email: 'trader@example.com',
          role: UserRole.USER,
          status: UserStatus.ACTIVE,
          createdAt: new Date('2026-06-11T00:00:00.000Z'),
        }),
      },
      asset: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'asset-usdc',
            symbol: 'USDC',
            name: 'USD Coin',
            type: AssetType.STABLECOIN,
            chain: Chain.ARBITRUM,
            tokenAddress: usdcContract.address,
            decimals: 6,
            tokenContracts: [usdcContract],
          },
          {
            id: 'asset-test',
            symbol: 'TEST',
            name: 'Testnet Coin',
            type: AssetType.CRYPTO,
            chain: Chain.ARBITRUM_SEPOLIA,
            tokenAddress: testnetOnlyContract.address,
            decimals: 6,
            tokenContracts: [testnetOnlyContract],
          },
        ]),
      },
      network: {
        findMany: jest.fn().mockResolvedValue([mainnetNetwork, testnetNetwork]),
      },
      wallet: { findMany: jest.fn().mockResolvedValue([]) },
      userDepositAddress: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'testnet-deposit-address',
            network: Chain.ARBITRUM_SEPOLIA,
            address: '0xAfC991Ba121E3E8a96C248b9d83DE4d543c09631',
            status: UserDepositAddressStatus.ACTIVE,
            createdAt: new Date('2026-06-11T00:00:00.000Z'),
          },
        ]),
      },
      order: { findMany: jest.fn().mockResolvedValue([]) },
      position: { findMany: jest.fn().mockResolvedValue([]) },
      depositIntent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'testnet-intent',
            asset: {
              id: 'asset-test',
              symbol: 'TEST',
              name: 'Testnet Coin',
              iconUrl: null,
              type: AssetType.CRYPTO,
              decimals: 6,
            },
            tokenContract: {
              standard: 'ERC20',
              address: testnetOnlyContract.address,
              network: testnetNetwork,
            },
            network: Chain.ARBITRUM_SEPOLIA,
            fromAddress: '0x1111111111111111111111111111111111111111',
            treasuryAddress: '0x2222222222222222222222222222222222222222',
            amount: { toString: () => '25' },
            rawAmount: '25000000',
            txHash: null,
            status: 'PENDING',
            expiresAt: new Date('2026-06-11T01:00:00.000Z'),
            createdAt: new Date('2026-06-11T00:00:00.000Z'),
            updatedAt: new Date('2026-06-11T00:00:00.000Z'),
          },
        ]),
      },
      deposit: { groupBy: jest.fn().mockResolvedValue([]) },
      ledgerAccount: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      ledgerEntry: { findMany: jest.fn().mockResolvedValue([]) },
      market: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const ledgerService = {
      getUserSpotBalance: jest.fn().mockResolvedValue({ toString: () => '10' }),
      getUserMainnetSpotBalance: jest.fn().mockResolvedValue(new (require('@prisma/client').Prisma).Decimal('0')),
    } as unknown as LedgerService;
    const marketDataService = { getOrderBook: jest.fn() };
    const assetValuation = new AssetValuationService(
      prisma,
      marketDataService as never,
    );
    const positionsService = {
      listUserPositions: jest.fn().mockResolvedValue([]),
    };
    const service = new AccountService(
      prisma,
      ledgerService,
      marketDataService as never,
      assetValuation,
      {} as RpcProvider,
      { getBalance: jest.fn() } as never,
      { get: jest.fn((key: string, fallback?: unknown) => (key === 'MAINNET_ENABLED' ? true : fallback)) } as unknown as ConfigService,
      positionsService as never,
    );

    const overview = await service.getOverview('user-1');

    expect(overview.environment).toEqual({
      displayMode: 'MAINNET',
      mainnetOnly: true,
      hyperliquidTestnet: true,
    });
    expect(overview.balances).toEqual([]);
    expect(overview.portfolio.assets).toEqual([]);
    expect(overview.portfolio.totalUsdc).toBe('0');
    expect(overview.depositAddresses).toEqual([]);
    expect(overview.depositIntents).toEqual([]);
    expect(ledgerService.getUserMainnetSpotBalance).toHaveBeenCalled();
    expect(ledgerService.getUserSpotBalance).not.toHaveBeenCalled();
  });
});
