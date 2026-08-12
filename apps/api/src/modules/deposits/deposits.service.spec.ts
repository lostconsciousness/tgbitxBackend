import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssetType,
  Chain,
  DepositChannel,
  DepositStatus,
  NetworkFamily,
  TokenStandard,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletsService } from '../wallets/wallets.service';
import { DepositsService } from './deposits.service';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { DepositAddressService } from './deposit-address.service';
import { AssetValuationService } from '../account/asset-valuation.service';

const assetValuationMock = {} as AssetValuationService;
const nonEvmMock = {} as never;

describe('DepositsService', () => {
  it('reverses and hides a previously credited internal sweep gas transfer', async () => {
    const gasAddress = '0x1111111111111111111111111111111111111111';
    const creditedDeposit = {
      id: 'deposit-gas-1',
      userId: 'user-1',
      assetId: 'asset-eth',
      fromAddress: gasAddress,
      txHash: '0xgas',
      amount: '0.001',
      status: DepositStatus.CREDITED,
      creditedLedgerTransactionId: 'ledger-credit-1',
      asset: { symbol: 'ETH' },
    };
    const prisma = {
      custodyAccount: {
        findMany: jest.fn().mockResolvedValue([{ address: gasAddress }]),
      },
      deposit: {
        findMany: jest.fn().mockResolvedValue([{ id: creditedDeposit.id }]),
        findUnique: jest.fn().mockResolvedValue(creditedDeposit),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const ledgerService = {
      postTransaction: jest.fn().mockResolvedValue({ id: 'ledger-reversal-1' }),
    };
    const service = new DepositsService(
      prisma as unknown as PrismaService,
      {} as AssetsService,
      {} as WalletsService,
      ledgerService as unknown as LedgerService,
      {} as ConfigService,
      {} as RpcProvider,
      {} as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );

    await expect(
      service.reclassifySweepGasFundingDeposits(Chain.ARBITRUM_SEPOLIA),
    ).resolves.toBe(1);

    expect(ledgerService.postTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `sweep-gas-funding-reversal:${creditedDeposit.id}`,
        entries: expect.arrayContaining([
          expect.objectContaining({ userId: 'user-1', direction: 'DEBIT' }),
          expect.objectContaining({ direction: 'CREDIT' }),
        ]),
      }),
      prisma,
    );
    expect(prisma.deposit.update).toHaveBeenCalledWith({
      where: { id: creditedDeposit.id },
      data: expect.objectContaining({
        userId: null,
        channel: DepositChannel.UNMATCHED,
        status: DepositStatus.UNMATCHED,
      }),
    });
  });

  it('reverses and hides a previously credited internal deposit address transfer', async () => {
    const oldDepositAddress = 'FWTEZ2kW4nkmkEgveZEFsnfomLTMjuqzc2p3DugEynX6';
    const creditedDeposit = {
      id: 'deposit-internal-1',
      userId: 'user-1',
      assetId: 'asset-sol',
      fromAddress: oldDepositAddress,
      toAddress: 'DzoNUwGqqAX4f6BsX9afB3vCddowsfo1j1wzwGTGHvUm',
      txHash: 'migration-signature',
      amount: '0.06703512',
      status: DepositStatus.CREDITED,
      network: Chain.SOLANA,
      creditedLedgerTransactionId: 'ledger-credit-1',
      asset: { symbol: 'SOL' },
    };
    const prisma = {
      deposit: {
        findMany: jest.fn().mockResolvedValue([{ id: creditedDeposit.id }]),
        findUnique: jest.fn().mockResolvedValue(creditedDeposit),
        findFirst: jest.fn().mockResolvedValue({ id: 'deposit-original-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      userDepositAddress: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const ledgerService = {
      postTransaction: jest.fn().mockResolvedValue({ id: 'ledger-reversal-1' }),
    };
    const service = new DepositsService(
      prisma as unknown as PrismaService,
      {} as AssetsService,
      {} as WalletsService,
      ledgerService as unknown as LedgerService,
      {} as ConfigService,
      {} as RpcProvider,
      {} as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );

    await expect(
      service.reclassifyInternalDepositAddressTransferDeposits(Chain.SOLANA),
    ).resolves.toBe(1);

    expect(ledgerService.postTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `internal-deposit-transfer-reversal:${creditedDeposit.id}`,
      }),
      prisma,
    );
    expect(prisma.deposit.update).toHaveBeenCalledWith({
      where: { id: creditedDeposit.id },
      data: expect.objectContaining({
        userId: null,
        channel: DepositChannel.UNMATCHED,
        status: DepositStatus.UNMATCHED,
      }),
    });
  });

  const network = {
    id: 'network-arbitrum-sepolia',
    chainKey: 'arbitrum-sepolia',
    caip2: 'eip155:421614',
    chainId: 421614,
    family: NetworkFamily.EVM,
    legacyChain: Chain.ARBITRUM_SEPOLIA,
    confirmations: 12,
    depositEnabled: true,
  };
  const tokenContract = {
    id: 'contract-usdc-sepolia',
    networkId: 'network-arbitrum-sepolia',
    address: '0x3333333333333333333333333333333333333333',
    standard: TokenStandard.ERC20,
    decimals: 6,
    depositEnabled: true,
    contractVerifiedAt: new Date(),
    contractCodeHash: '0xverified',
    network,
  };
  const nativeTokenContract = {
    id: 'contract-eth-sepolia',
    networkId: 'network-arbitrum-sepolia',
    address: null,
    standard: TokenStandard.NATIVE,
    decimals: 18,
    depositEnabled: true,
    withdrawalEnabled: false,
    withdrawalFeeAmount: { toString: () => '0' },
    minWithdrawalAmount: { toString: () => '0' },
    contractVerifiedAt: null,
    contractCodeHash: null,
    verifiedChainId: null,
    network,
  };

  it('creates a testnet ERC20 intent with exact raw token amount', async () => {
    const prisma: {
      network: { findUnique: jest.Mock };
      tokenContract: { findUnique: jest.Mock };
      wallet: { findFirst: jest.Mock };
      custodyAccount: { findFirst: jest.Mock };
      depositIntent: { updateMany: jest.Mock; create: jest.Mock };
      $transaction: jest.Mock;
    } = {
      network: {
        findUnique: jest.fn().mockResolvedValue(network),
      },
      tokenContract: {
        findUnique: jest.fn().mockResolvedValue(tokenContract),
      },
      wallet: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'wallet-1',
          userId: 'user-1',
          address: '0x1111111111111111111111111111111111111111',
          chain: Chain.ARBITRUM_SEPOLIA,
          status: 'ACTIVE',
        }),
      },
      custodyAccount: {
        findFirst: jest.fn().mockResolvedValue({
          address: '0x2222222222222222222222222222222222222222',
        }),
      },
      depositIntent: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(({ data }) =>
          Promise.resolve({
            id: 'intent-1',
            status: 'PENDING',
            ...data,
          }),
        ),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const service = new DepositsService(
      prisma as unknown as PrismaService,
      {
        getBySymbol: jest.fn().mockResolvedValue({
          id: 'asset-usdc',
          symbol: 'USDC',
          tokenAddress: '0x3333333333333333333333333333333333333333',
          decimals: 6,
          depositEnabled: true,
          contractVerifiedAt: new Date(),
          contractCodeHash: '0xverified',
        }),
      } as unknown as AssetsService,
      {} as WalletsService,
      {} as LedgerService,
      {
        get: jest.fn((key: string, fallback?: unknown) => {
          const values: Record<string, unknown> = {
            ONCHAIN_CHAIN_ID: 421614,
            DEPOSIT_INTENT_TTL_SECONDS: 900,
          };
          return values[key] ?? fallback;
        }),
      } as unknown as ConfigService,
      {} as RpcProvider,
      {
        provision: jest.fn().mockResolvedValue({
          address: '0x2222222222222222222222222222222222222222',
        }),
      } as unknown as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );

    const intent = await service.createIntent({
      userId: 'user-1',
      walletId: 'wallet-1',
      assetSymbol: 'USDC',
      amount: '100.25',
    });

    expect(intent.transfer).toMatchObject({
      chainId: 421614,
      network: 'arbitrum-sepolia',
      tokenStandard: TokenStandard.ERC20,
      rawAmount: '100250000',
      amount: '100.25',
    });
    expect(prisma.depositIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
  });

  it('creates a native testnet intent without a token contract address', async () => {
    const prisma: {
      network: { findUnique: jest.Mock };
      tokenContract: { findUnique: jest.Mock };
      wallet: { findFirst: jest.Mock };
      depositIntent: { updateMany: jest.Mock; create: jest.Mock };
      $transaction: jest.Mock;
    } = {
      network: {
        findUnique: jest.fn().mockResolvedValue(network),
      },
      tokenContract: {
        findUnique: jest.fn()
          .mockResolvedValueOnce(nativeTokenContract)
          .mockResolvedValue(nativeTokenContract),
      },
      wallet: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'wallet-1',
          userId: 'user-1',
          address: '0x1111111111111111111111111111111111111111',
          chain: Chain.ARBITRUM_SEPOLIA,
          status: 'ACTIVE',
        }),
      },
      depositIntent: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(({ data }) =>
          Promise.resolve({
            id: 'intent-1',
            status: 'PENDING',
            ...data,
          }),
        ),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const service = new DepositsService(
      prisma as unknown as PrismaService,
      {
        getBySymbol: jest.fn().mockResolvedValue({
          id: 'asset-eth',
          symbol: 'ETH',
          decimals: 18,
          depositEnabled: true,
        }),
      } as unknown as AssetsService,
      {} as WalletsService,
      {} as LedgerService,
      {
        get: jest.fn((key: string, fallback?: unknown) => {
          const values: Record<string, unknown> = {
            ONCHAIN_CHAIN_ID: 421614,
            DEPOSIT_INTENT_TTL_SECONDS: 900,
          };
          return values[key] ?? fallback;
        }),
      } as unknown as ConfigService,
      {} as RpcProvider,
      {
        provision: jest.fn().mockResolvedValue({
          address: '0x2222222222222222222222222222222222222222',
        }),
      } as unknown as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );

    const intent = await service.createIntent({
      userId: 'user-1',
      walletId: 'wallet-1',
      assetSymbol: 'ETH',
      amount: '0.01',
    });

    expect(intent.transfer).toMatchObject({
      network: 'arbitrum-sepolia',
      tokenStandard: TokenStandard.NATIVE,
      tokenAddress: null,
      rawAmount: '10000000000000000',
      amount: '0.01',
    });
  });

  it('accepts an active EVM wallet connected on another chain for a network-specific intent', async () => {
    const polygonNetwork = {
      ...network,
      id: 'network-polygon-amoy',
      chainKey: 'polygon-amoy',
      caip2: 'eip155:80002',
      chainId: 80002,
      legacyChain: Chain.POLYGON_AMOY,
    };
    const polContract = {
      ...nativeTokenContract,
      id: 'contract-pol-amoy',
      networkId: polygonNetwork.id,
      network: polygonNetwork,
    };
    const prisma: {
      network: { findUnique: jest.Mock };
      tokenContract: { findUnique: jest.Mock };
      wallet: { findFirst: jest.Mock };
      depositIntent: { updateMany: jest.Mock; create: jest.Mock };
      $transaction: jest.Mock;
    } = {
      network: {
        findUnique: jest.fn().mockResolvedValue(polygonNetwork),
      },
      tokenContract: {
        findUnique: jest.fn().mockResolvedValue(polContract),
      },
      wallet: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'wallet-1',
          userId: 'user-1',
          address: '0x1111111111111111111111111111111111111111',
          chain: Chain.ARBITRUM_SEPOLIA,
          status: 'ACTIVE',
        }),
      },
      depositIntent: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(({ data }) =>
          Promise.resolve({
            id: 'intent-1',
            status: 'PENDING',
            ...data,
          }),
        ),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const service = new DepositsService(
      prisma as unknown as PrismaService,
      {
        getBySymbol: jest.fn().mockResolvedValue({
          id: 'asset-pol',
          symbol: 'POL',
          decimals: 18,
          depositEnabled: true,
        }),
      } as unknown as AssetsService,
      {} as WalletsService,
      {} as LedgerService,
      {
        get: jest.fn((key: string, fallback?: unknown) => {
          const values: Record<string, unknown> = {
            DEPOSIT_INTENT_TTL_SECONDS: 900,
          };
          return values[key] ?? fallback;
        }),
      } as unknown as ConfigService,
      {} as RpcProvider,
      {
        provision: jest.fn().mockResolvedValue({
          address: '0x2222222222222222222222222222222222222222',
        }),
      } as unknown as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );

    const intent = await service.createIntent({
      userId: 'user-1',
      walletId: 'wallet-1',
      assetSymbol: 'POL',
      amount: '0.5',
      network: 'polygon-amoy',
    });

    expect(prisma.wallet.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'wallet-1',
        userId: 'user-1',
        status: 'ACTIVE',
      },
    });
    expect(intent.transfer).toMatchObject({
      network: 'polygon-amoy',
      chainId: 80002,
      tokenStandard: TokenStandard.NATIVE,
      fromAddress: '0x1111111111111111111111111111111111111111',
    });
  });

  it('rejects a Tron intent created with an EVM wallet', async () => {
    const tronNetwork = {
      ...network,
      id: 'network-tron',
      chainKey: 'tron',
      caip2: 'tron:mainnet',
      chainId: null,
      family: NetworkFamily.TVM,
      legacyChain: Chain.TRON,
      mainnet: true,
    };
    const tronContract = {
      ...tokenContract,
      id: 'contract-usdt-tron',
      address: 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj',
      standard: TokenStandard.TRC20,
      network: tronNetwork,
    };
    const provision = jest.fn();
    const prisma = {
      network: { findUnique: jest.fn().mockResolvedValue(tronNetwork) },
      tokenContract: { findUnique: jest.fn().mockResolvedValue(tronContract) },
      wallet: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'wallet-evm',
          userId: 'user-1',
          address: '0x1111111111111111111111111111111111111111',
          chain: Chain.ETHEREUM,
          status: 'ACTIVE',
        }),
      },
      $transaction: jest.fn(),
    };
    const service = new DepositsService(
      prisma as unknown as PrismaService,
      {
        getBySymbol: jest.fn().mockResolvedValue({
          id: 'asset-usdt',
          symbol: 'USDT',
          decimals: 6,
          depositEnabled: true,
        }),
      } as unknown as AssetsService,
      {} as WalletsService,
      {} as LedgerService,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'MAINNET_ENABLED' ? true : fallback,
        ),
      } as unknown as ConfigService,
      {} as RpcProvider,
      { provision } as unknown as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );

    await expect(service.createIntent({
      userId: 'user-1',
      walletId: 'wallet-evm',
      assetSymbol: 'USDT',
      amount: '10',
      network: 'tron',
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DEPOSIT_WALLET_NETWORK_MISMATCH' }),
    });
    expect(provision).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lists enabled native deposit options without contract verification', async () => {
    const assetValuation = {
      enrichAndSortByBalanceUsdc: jest.fn(
        async (
          assets: Array<{ id: string; symbol: string; availableBalance: string; networks: unknown[] }>,
          getBalance: (asset: { availableBalance: string }) => string,
        ) =>
          assets.map((asset) => ({
          ...asset,
          priceUsdc: null,
          balanceValueUsdc: getBalance(asset),
        })),
      ),
    };
    const service = new DepositsService(
      {
        tokenContract: {
          findMany: jest.fn().mockResolvedValue([
            {
              ...nativeTokenContract,
              asset: {
                id: 'asset-eth',
                symbol: 'ETH',
                name: 'Ether',
                iconUrl: null,
                type: AssetType.CRYPTO,
                decimals: 18,
              },
            },
          ]),
        },
      } as unknown as PrismaService,
      {} as AssetsService,
      {} as WalletsService,
      {
        getUserSpotBalance: jest.fn().mockResolvedValue({ toString: () => '0' }),
      } as unknown as LedgerService,
      { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      {} as RpcProvider,
      {} as DepositAddressService,
      assetValuation as unknown as AssetValuationService,
      nonEvmMock,
    );

    const options = await service.listDepositOptions({ userId: 'user-1' });

    expect(options.assets[0]).toMatchObject({
      symbol: 'ETH',
      networks: [
        expect.objectContaining({
          network: 'arbitrum-sepolia',
          tokenStandard: TokenStandard.NATIVE,
          tokenAddress: null,
          depositEnabled: true,
          disabledReason: null,
        }),
      ],
    });
  });

  it('hides testnet deposit options when mainnet display mode is enabled', async () => {
    const mainnetNetwork = {
      ...network,
      id: 'network-arbitrum',
      chainKey: 'arbitrum',
      displayName: 'Arbitrum One',
      caip2: 'eip155:42161',
      chainId: 42161,
      legacyChain: Chain.ARBITRUM,
      mainnet: true,
      withdrawalEnabled: true,
    };
    const sepoliaNetwork = {
      ...network,
      mainnet: false,
      withdrawalEnabled: true,
    };
    const contracts = [
      {
        ...tokenContract,
        id: 'contract-usdc-mainnet',
        network: mainnetNetwork,
        asset: {
          id: 'asset-usdc',
          symbol: 'USDC',
          name: 'USD Coin',
          iconUrl: null,
          type: AssetType.STABLECOIN,
          decimals: 6,
        },
        withdrawalEnabled: true,
        withdrawalFeeAmount: { toString: () => '0' },
        minWithdrawalAmount: { toString: () => '1' },
        verifiedChainId: 42161,
      },
      {
        ...tokenContract,
        id: 'contract-usdc-sepolia',
        network: sepoliaNetwork,
        asset: {
          id: 'asset-usdc',
          symbol: 'USDC',
          name: 'USD Coin',
          iconUrl: null,
          type: AssetType.STABLECOIN,
          decimals: 6,
        },
        withdrawalEnabled: true,
        withdrawalFeeAmount: { toString: () => '0' },
        minWithdrawalAmount: { toString: () => '1' },
        verifiedChainId: 421614,
      },
    ];
    const service = new DepositsService(
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
      {} as AssetsService,
      {} as WalletsService,
      {
        getUserSpotBalance: jest.fn().mockResolvedValue({ toString: () => '0' }),
      } as unknown as LedgerService,
      { get: jest.fn((key: string, fallback?: unknown) => (key === 'MAINNET_ENABLED' ? true : fallback)) } as unknown as ConfigService,
      {} as RpcProvider,
      {} as DepositAddressService,
      {
        enrichAndSortByBalanceUsdc: jest.fn(async (assets) => assets),
      } as unknown as AssetValuationService,
      nonEvmMock,
    );

    const options = await service.listDepositOptions({ userId: 'user-1' });

    expect(options.assets).toHaveLength(1);
    const [asset] = options.assets;
    expect(asset).toBeDefined();
    expect(asset!.networks).toEqual([
      expect.objectContaining({
        network: 'arbitrum',
        chainId: 42161,
      }),
    ]);
  });

  it('rejects a submitted transaction from a different sender', async () => {
    const txHash = `0x${'a'.repeat(64)}`;
    const intent = {
      id: 'intent-1',
      userId: 'user-1',
      walletId: 'wallet-1',
      assetId: 'asset-usdc',
      fromAddress: '0x1111111111111111111111111111111111111111',
      treasuryAddress: '0x2222222222222222222222222222222222222222',
      rawAmount: '1000000',
      amount: { toString: () => '1' },
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
      txHash: null,
      submittedAt: null,
      asset: {
        tokenAddress: '0x3333333333333333333333333333333333333333',
      },
      tokenContract: {
        ...tokenContract,
        network,
      },
      wallet: {},
      deposit: null,
    };
    const service = new DepositsService(
      {
        depositIntent: {
          findFirst: jest.fn().mockResolvedValue(intent),
        },
      } as unknown as PrismaService,
      {} as AssetsService,
      {} as WalletsService,
      {} as LedgerService,
      { get: jest.fn() } as unknown as ConfigService,
      {
        getTransaction: jest.fn().mockResolvedValue({
          hash: txHash,
          from: '0x4444444444444444444444444444444444444444',
          to: '0x5555555555555555555555555555555555555555',
          blockNumber: 1,
          status: 1,
          logs: [],
        }),
      } as unknown as RpcProvider,
      {} as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );

    await expect(
      service.submitIntent({
        userId: 'user-1',
        intentId: intent.id,
        txHash,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts ERC20 deposits routed through smart-wallet batch transactions', async () => {
    const txHash = `0x${'b'.repeat(64)}`;
    const intent = {
      id: 'intent-1',
      userId: 'user-1',
      walletId: 'wallet-1',
      assetId: 'asset-usdc',
      network: Chain.ARBITRUM_SEPOLIA,
      fromAddress: '0x1111111111111111111111111111111111111111',
      treasuryAddress: '0x2222222222222222222222222222222222222222',
      rawAmount: '1000000',
      amount: { toString: () => '1' },
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
      txHash: null,
      submittedAt: null,
      asset: {
        tokenAddress: '0x3333333333333333333333333333333333333333',
      },
      tokenContract: {
        ...tokenContract,
        network,
      },
      wallet: {},
      deposit: null,
    };
    const prisma = {
      depositIntent: {
        findFirst: jest.fn().mockResolvedValue(intent),
        update: jest.fn().mockResolvedValue({ ...intent, status: 'SUBMITTED', txHash }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...intent, status: 'DETECTED', txHash }),
      },
      deposit: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'deposit-1',
          status: DepositStatus.DETECTED,
        }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const service = new DepositsService(
      prisma as unknown as PrismaService,
      {} as AssetsService,
      {} as WalletsService,
      {
        postTransaction: jest.fn(),
      } as unknown as LedgerService,
      { get: jest.fn() } as unknown as ConfigService,
      {
        getTransaction: jest.fn().mockResolvedValue({
          hash: txHash,
          from: '0x4444444444444444444444444444444444444444',
          to: '0x5555555555555555555555555555555555555555',
          blockNumber: 1,
          status: 1,
          logs: [
            {
              address: tokenContract.address!,
              blockNumber: 1,
              transactionHash: txHash,
              logIndex: 2,
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                '0x0000000000000000000000001111111111111111111111111111111111111111',
                '0x0000000000000000000000002222222222222222222222222222222222222222',
              ],
              data: '0x00000000000000000000000000000000000000000000000000000000000f4240',
            },
          ],
        }),
        getLatestBlockNumber: jest.fn().mockResolvedValue(1),
      } as unknown as RpcProvider,
      {} as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );
    jest.spyOn(service, 'recordDetectedDeposit').mockResolvedValue({
      id: 'deposit-1',
      status: DepositStatus.PENDING_CONFIRMATION,
    } as never);

    await expect(
      service.submitIntent({
        userId: 'user-1',
        intentId: intent.id,
        txHash,
      }),
    ).resolves.toEqual(expect.objectContaining({ txHash }));
  });

  it('returns the personal deposit address and accepts any sender', async () => {
    const depositAddressService = {
      getExisting: jest.fn().mockResolvedValue({
        address: '0x2222222222222222222222222222222222222222',
      }),
    };
    const service = new DepositsService(
      {
        network: {
          findUnique: jest.fn().mockResolvedValue(network),
        },
        tokenContract: {
          findUnique: jest.fn().mockResolvedValue(tokenContract),
        },
        custodyAccount: {
          findFirst: jest.fn().mockResolvedValue({
            address: '0x2222222222222222222222222222222222222222',
          }),
        },
      } as unknown as PrismaService,
      {
        getBySymbol: jest.fn().mockResolvedValue({
          id: 'asset-usdc',
          symbol: 'USDC',
          tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
          decimals: 6,
          depositEnabled: true,
        }),
      } as unknown as AssetsService,
      {} as WalletsService,
      {} as LedgerService,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'DEPOSIT_CONFIRMATIONS' ? 12 : fallback,
        ),
        getOrThrow: jest
          .fn()
          .mockReturnValue('0x2222222222222222222222222222222222222222'),
      } as unknown as ConfigService,
      {} as RpcProvider,
      depositAddressService as unknown as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );

    const instructions = await service.getDepositInstructions({
      userId: 'user-1',
      assetSymbol: 'USDC',
    });

    expect(depositAddressService.getExisting).toHaveBeenCalledWith(
      'user-1',
      'USDC',
      'arbitrum-sepolia',
    );
    expect(instructions).toMatchObject({
      network: 'arbitrum-sepolia',
      depositAddress: '0x2222222222222222222222222222222222222222',
      acceptsFromAnyAddress: true,
    });
  });

  it('does not credit duplicate detected deposits twice', async () => {
    const existingDeposit = {
      id: 'deposit-1',
      idempotencyKey: 'arbitrum:0xtx:1',
      status: DepositStatus.CREDITED,
      asset: {
        id: 'asset-usdc',
        symbol: 'USDC',
        name: 'USD Coin',
        type: AssetType.STABLECOIN,
        chain: Chain.ARBITRUM,
        tokenAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        decimals: 6,
        depositEnabled: true,
        withdrawalEnabled: true,
        withdrawalFeeAmount: '0',
        minWithdrawalAmount: '0',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };

    const prisma = {
      deposit: {
        findUnique: jest.fn().mockResolvedValue(existingDeposit),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const ledgerService = {
      postTransaction: jest.fn(),
    } as unknown as LedgerService;
    const service = new DepositsService(
      prisma as unknown as PrismaService,
      {} as AssetsService,
      {} as WalletsService,
      ledgerService,
      { get: jest.fn(), getOrThrow: jest.fn() } as unknown as ConfigService,
      {} as RpcProvider,
      {} as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );

    const result = await service.recordDetectedDeposit({
      assetId: 'asset-usdc',
      fromAddress: '0x0000000000000000000000000000000000000000',
      toAddress: '0x0000000000000000000000000000000000000000',
      txHash: '0xtx',
      logIndex: 1,
      amount: '10',
      confirmations: 12,
    });

    expect(result).toBe(existingDeposit);
    expect(ledgerService.postTransaction).not.toHaveBeenCalled();
  });

  it('matches an unlinked sender by the personal destination address', async () => {
    const created = {
      id: 'deposit-1',
      userId: 'user-1',
      depositAddressId: 'address-1',
      status: DepositStatus.PENDING_CONFIRMATION,
      channel: DepositChannel.PERSONAL_ADDRESS,
      asset: { symbol: 'USDC' },
    };
    const prisma = {
      deposit: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(created),
      },
      depositIntent: { findUnique: jest.fn().mockResolvedValue(null) },
      userDepositAddress: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'address-1',
          userId: 'user-1',
          status: 'ACTIVE',
        }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const service = new DepositsService(
      prisma as unknown as PrismaService,
      {} as AssetsService,
      {} as WalletsService,
      {} as LedgerService,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'DEPOSIT_CONFIRMATIONS' ? 12 : fallback,
        ),
      } as unknown as ConfigService,
      {} as RpcProvider,
      {} as DepositAddressService,
      assetValuationMock,
      nonEvmMock,
    );

    const result = await service.recordDetectedDeposit({
      depositAddressId: 'address-1',
      userId: 'user-1',
      channel: DepositChannel.PERSONAL_ADDRESS,
      assetId: 'asset-usdc',
      fromAddress: '0x9999999999999999999999999999999999999999',
      toAddress: '0x2222222222222222222222222222222222222222',
      txHash: '0xdirect',
      logIndex: 2,
      blockNumber: 10,
      amount: '20',
      rawAmount: '20000000',
      confirmations: 1,
    });

    expect(result).toBe(created);
    expect(prisma.deposit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        depositAddressId: 'address-1',
        channel: DepositChannel.PERSONAL_ADDRESS,
        rawAmount: '20000000',
      }),
      include: { asset: true },
    });
  });
});
