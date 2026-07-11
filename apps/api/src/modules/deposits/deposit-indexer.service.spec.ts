import { ConfigService } from '@nestjs/config';
import { Chain, NetworkFamily } from '@prisma/client';
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
});
