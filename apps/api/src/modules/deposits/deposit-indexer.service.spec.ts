import { ConfigService } from '@nestjs/config';
import { Chain, NetworkFamily, TokenStandard } from '@prisma/client';
import { AssetsService } from '../assets/assets.service';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { OnchainReadinessService } from '../onchain/onchain-readiness.service';
import { NonEvmTestnetAdapterService } from '../onchain/non-evm-testnet-adapter.service';
import { PrismaService } from '../../database/prisma.service';
import { DepositsService } from './deposits.service';
import { DepositIndexerService } from './deposit-indexer.service';

describe('DepositIndexerService', () => {
  it('does not credit native sweep gas funding as a user deposit', async () => {
    const gasAddress = '0x1111111111111111111111111111111111111111';
    const depositAddress = '0x2222222222222222222222222222222222222222';
    const deposits = {
      reclassifySweepGasFundingDeposits: jest.fn().mockResolvedValue(0),
      shouldSkipInternalPersonalDepositTransfer: jest.fn().mockResolvedValue(false),
      recordDetectedDeposit: jest.fn(),
    };
    const prisma = {
      custodyAccount: {
        findMany: jest.fn().mockResolvedValue([{ address: gasAddress }]),
      },
      userDepositAddress: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'address-1', userId: 'user-1', address: depositAddress },
        ]),
      },
    };
    const rpc = {
      getLatestBlockNumber: jest.fn().mockResolvedValue(10),
      getBlockWithTransactions: jest.fn().mockResolvedValue({
        number: 10,
        transactions: [
          {
            from: gasAddress,
            to: depositAddress,
            value: '1000000000000000',
            hash: '0xgas',
          },
        ],
      }),
    };
    const service = new DepositIndexerService(
      {} as AssetsService,
      deposits as unknown as DepositsService,
      { get: jest.fn() } as unknown as ConfigService,
      rpc as unknown as RpcProvider,
      prisma as unknown as PrismaService,
      {} as OnchainReadinessService,
      {} as NonEvmTestnetAdapterService,
    );

    const result = await service.scanNativeDeposits(
      {
        assetSymbol: 'ETH',
        network: 'arbitrum-sepolia',
        fromBlock: 10,
        toBlock: 10,
      },
      {
        asset: { id: 'asset-eth', symbol: 'ETH' },
        tokenContract: {
          id: 'contract-eth',
          standard: 'NATIVE',
          decimals: 18,
        },
        network: {
          chainKey: 'arbitrum-sepolia',
          confirmations: 1,
        },
        legacyChain: Chain.ARBITRUM_SEPOLIA,
      } as never,
    );

    expect(deposits.reclassifySweepGasFundingDeposits).toHaveBeenCalledWith(
      Chain.ARBITRUM_SEPOLIA,
    );
    expect(deposits.recordDetectedDeposit).not.toHaveBeenCalled();
    expect(result.deposits).toEqual([]);
  });

  it('rescans non-EVM networks with the configured reorg overlap', async () => {
    const tokenContract = {
      id: 'tc-sol',
      networkId: 'net-solana-devnet',
      asset: { symbol: 'SOL' },
      network: {
        chainKey: 'solana-devnet',
        legacyChain: Chain.SOLANA_DEVNET,
        family: NetworkFamily.SVM,
        reorgOverlapBlocks: 150,
      },
    };
    const prisma = {
      deposit: { findMany: jest.fn().mockResolvedValue([]) },
      userDepositAddress: {
        findMany: jest.fn().mockResolvedValue([{ network: Chain.SOLANA_DEVNET }]),
      },
      tokenContract: { findMany: jest.fn().mockResolvedValue([tokenContract]) },
      depositIndexerCursor: {
        findUnique: jest.fn().mockResolvedValue({ lastBlock: BigInt(1000) }),
        upsert: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'DEPOSIT_INDEXER_ENABLED') {
          return true;
        }
        if (key === 'DEPOSIT_INDEXER_START_BLOCK') {
          return 0;
        }
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const nonEvm = {
      assertSupportedNetwork: jest.fn(),
      getLatestBlock: jest.fn().mockResolvedValue(1200),
    } as unknown as NonEvmTestnetAdapterService;
    const service = new DepositIndexerService(
      {} as AssetsService,
      {} as DepositsService,
      config,
      { getLatestBlockNumber: jest.fn() } as unknown as RpcProvider,
      prisma,
      {} as OnchainReadinessService,
      nonEvm,
    );
    const scanDeposits = jest.spyOn(service, 'scanDeposits').mockResolvedValue({
      asset: 'SOL',
      network: 'solana-devnet',
      fromBlock: 850,
      toBlock: 1200,
      latestBlock: 1200,
      scannedLogs: 0,
      deposits: [],
    });

    await service.scanConfiguredAssets();

    expect(scanDeposits).toHaveBeenCalledWith({
      assetSymbol: 'SOL',
      network: 'solana-devnet',
      fromBlock: 850,
      toBlock: 1200,
    });
    expect(prisma.depositIndexerCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { lastBlock: BigInt(1200) },
      }),
    );
  });

  it('starts a new non-EVM cursor from the latest block minus overlap', async () => {
    const tokenContract = {
      id: 'tc-btc',
      networkId: 'net-bitcoin-signet',
      asset: { symbol: 'BTC' },
      network: {
        chainKey: 'bitcoin-signet',
        legacyChain: Chain.BITCOIN_SIGNET,
        family: NetworkFamily.UTXO,
        reorgOverlapBlocks: 6,
      },
    };
    const prisma = {
      deposit: { findMany: jest.fn().mockResolvedValue([]) },
      userDepositAddress: {
        findMany: jest.fn().mockResolvedValue([{ network: Chain.BITCOIN_SIGNET }]),
      },
      tokenContract: { findMany: jest.fn().mockResolvedValue([tokenContract]) },
      depositIndexerCursor: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'DEPOSIT_INDEXER_ENABLED') {
          return true;
        }
        if (key === 'DEPOSIT_INDEXER_START_BLOCK') {
          return 0;
        }
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const nonEvm = {
      assertSupportedNetwork: jest.fn(),
      getLatestBlock: jest.fn().mockResolvedValue(5000),
    } as unknown as NonEvmTestnetAdapterService;
    const service = new DepositIndexerService(
      {} as AssetsService,
      {} as DepositsService,
      config,
      { getLatestBlockNumber: jest.fn() } as unknown as RpcProvider,
      prisma,
      {} as OnchainReadinessService,
      nonEvm,
    );
    const scanDeposits = jest.spyOn(service, 'scanDeposits').mockResolvedValue({
      asset: 'BTC',
      network: 'bitcoin-signet',
      fromBlock: 4994,
      toBlock: 5000,
      latestBlock: 5000,
      scannedLogs: 0,
      deposits: [],
    });

    await service.scanConfiguredAssets();

    expect(scanDeposits).toHaveBeenCalledWith({
      assetSymbol: 'BTC',
      network: 'bitcoin-signet',
      fromBlock: 4994,
      toBlock: 5000,
    });
  });

  it('bounds stale EVM catch-up while scanning the current chain tip', async () => {
    const tokenContract = {
      id: 'tc-usdc',
      networkId: 'net-arbitrum',
      standard: TokenStandard.ERC20,
      address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
      decimals: 6,
      contractVerifiedAt: new Date(),
      contractCodeHash: '0xverified',
      asset: { symbol: 'USDC' },
      network: {
        chainKey: 'arbitrum',
        legacyChain: Chain.ARBITRUM,
        family: NetworkFamily.EVM,
        reorgOverlapBlocks: 64,
      },
    };
    const prisma = {
      deposit: { findMany: jest.fn().mockResolvedValue([]) },
      userDepositAddress: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{ network: Chain.ARBITRUM }])
          .mockResolvedValue([{
            id: 'address-1',
            userId: 'user-1',
            address: '0x1111111111111111111111111111111111111111',
          }]),
      },
      tokenContract: { findMany: jest.fn().mockResolvedValue([tokenContract]) },
      depositIndexerCursor: {
        findUnique: jest.fn().mockResolvedValue({ lastBlock: BigInt(1000) }),
        upsert: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'DEPOSIT_INDEXER_ENABLED') return true;
        if (key === 'DEPOSIT_INDEXER_START_BLOCK') return 0;
        if (key === 'DEPOSIT_INDEXER_MAX_BLOCK_RANGE') return 1000;
        if (key === 'DEPOSIT_INDEXER_REORG_OVERLAP_BLOCKS') return 30;
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const rpc = {
      getLatestBlockNumber: jest.fn().mockResolvedValue(100_000),
      getLogs: jest.fn().mockResolvedValue([]),
    } as unknown as RpcProvider;
    const readiness = {
      assertWorkerReady: jest.fn().mockResolvedValue(undefined),
    } as unknown as OnchainReadinessService;
    const service = new DepositIndexerService(
      {} as AssetsService,
      { getActiveTreasuryAddress: jest.fn().mockResolvedValue(null) } as unknown as DepositsService,
      config,
      rpc,
      prisma,
      readiness,
      {} as NonEvmTestnetAdapterService,
    );
    await service.scanConfiguredAssets();

    expect(rpc.getLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({
      networkKey: 'arbitrum',
      address: tokenContract.address,
      fromBlock: 99_970,
      toBlock: 100_000,
    }));
    expect(rpc.getLogs).toHaveBeenNthCalledWith(2, expect.objectContaining({
      networkKey: 'arbitrum',
      address: tokenContract.address,
      fromBlock: 970,
      toBlock: 1969,
    }));
    expect(prisma.depositIndexerCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { lastBlock: BigInt(5969) } }),
    );
  });

  it('batches ERC20 contracts sharing a network and cursor into one eth_getLogs request', async () => {
    const network = {
      id: 'net-arbitrum',
      chainKey: 'arbitrum',
      legacyChain: Chain.ARBITRUM,
      family: NetworkFamily.EVM,
      reorgOverlapBlocks: 30,
    };
    const contracts = [
      {
        id: 'tc-usdc',
        networkId: network.id,
        standard: TokenStandard.ERC20,
        address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        decimals: 6,
        contractVerifiedAt: new Date(),
        contractCodeHash: '0x01',
        asset: { id: 'asset-usdc', symbol: 'USDC' },
        network,
      },
      {
        id: 'tc-usdt',
        networkId: network.id,
        standard: TokenStandard.ERC20,
        address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
        decimals: 6,
        contractVerifiedAt: new Date(),
        contractCodeHash: '0x02',
        asset: { id: 'asset-usdt', symbol: 'USDT' },
        network,
      },
    ];
    const userDepositAddress = {
      findMany: jest.fn()
        .mockResolvedValueOnce([{ network: Chain.ARBITRUM }])
        .mockResolvedValueOnce([{
          id: 'address-1',
          userId: 'user-1',
          address: '0x1111111111111111111111111111111111111111',
        }]),
    };
    const prisma = {
      deposit: { findMany: jest.fn().mockResolvedValue([]) },
      userDepositAddress,
      tokenContract: { findMany: jest.fn().mockResolvedValue(contracts) },
      depositIndexerCursor: {
        findUnique: jest.fn().mockResolvedValue({ lastBlock: BigInt(1000) }),
        upsert: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'DEPOSIT_INDEXER_ENABLED') return true;
        if (key === 'ALCHEMY_ADDRESS_ACTIVITY_ENABLED') return false;
        if (key === 'DEPOSIT_INDEXER_MAX_BLOCK_RANGE') return 1000;
        if (key === 'DEPOSIT_INDEXER_REORG_OVERLAP_BLOCKS') return 30;
        if (key === 'DEPOSIT_ADDRESS_SCAN_BATCH_SIZE') return 100;
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const rpc = {
      getLatestBlockNumber: jest.fn().mockResolvedValue(1030),
      getLogs: jest.fn().mockResolvedValue([]),
    } as unknown as RpcProvider;
    const deposits = {
      getActiveTreasuryAddress: jest.fn().mockResolvedValue(null),
    } as unknown as DepositsService;
    const readiness = {
      assertWorkerReady: jest.fn().mockResolvedValue(undefined),
    } as unknown as OnchainReadinessService;
    const service = new DepositIndexerService(
      {} as AssetsService,
      deposits,
      config,
      rpc,
      prisma,
      readiness,
      {} as NonEvmTestnetAdapterService,
    );

    await service.scanConfiguredAssets();

    expect(rpc.getLogs).toHaveBeenCalledTimes(1);
    expect(rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      networkKey: 'arbitrum',
      address: [contracts[0]!.address, contracts[1]!.address],
    }));
    expect(prisma.depositIndexerCursor.upsert).toHaveBeenCalledTimes(2);
  });

  it('uses frequent polling only as a five-minute fallback when Alchemy webhooks are enabled', () => {
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'ALCHEMY_ADDRESS_ACTIVITY_ENABLED') return true;
        if (key === 'DEPOSIT_EVM_FALLBACK_SCAN_MS') return 300_000;
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const service = new DepositIndexerService(
      {} as AssetsService,
      {} as DepositsService,
      config,
      {} as RpcProvider,
      {} as PrismaService,
      {} as OnchainReadinessService,
      {} as NonEvmTestnetAdapterService,
    );
    const shouldRun = (service as unknown as {
      shouldRunEvmFallbackScan(now: number): boolean;
    }).shouldRunEvmFallbackScan.bind(service);

    expect(shouldRun(1_000_000)).toBe(true);
    expect(shouldRun(1_030_000)).toBe(false);
    expect(shouldRun(1_300_000)).toBe(true);
  });
});
