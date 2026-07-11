import { BadRequestException } from '@nestjs/common';
import {
  AssetType,
  Chain,
  CustodyAccountRole,
  CustodyAccountStatus,
  NetworkFamily,
  TokenStandard,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { AssetsService } from './assets.service';

describe('AssetsService transfer allowlist', () => {
  it('creates custom tokens disabled regardless of requested flags', async () => {
    const prisma = {
      $transaction: jest.fn(),
      network: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'network-1',
          legacyChain: Chain.ARBITRUM_SEPOLIA,
        }),
      },
      asset: {
        create: jest.fn(({ data }) => Promise.resolve(data)),
      },
      tokenContract: {
        create: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const service = new AssetsService(prisma as unknown as PrismaService, {} as RpcProvider);

    await service.create({
      symbol: 'TEST',
      name: 'Test Token',
      type: AssetType.CRYPTO,
      chain: Chain.ARBITRUM_SEPOLIA,
      tokenAddress: '0x1111111111111111111111111111111111111111',
      decimals: 18,
      depositEnabled: true,
      withdrawalEnabled: true,
    });

    expect(prisma.asset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        depositEnabled: false,
        withdrawalEnabled: false,
      }),
    });
    expect(prisma.tokenContract.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        depositEnabled: false,
        withdrawalEnabled: false,
      }),
    });
  });

  it('rejects enabling an unverified token', async () => {
    const prisma = {
      network: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'network-1',
          legacyChain: Chain.ARBITRUM_SEPOLIA,
          chainId: 421614,
          chainKey: 'arbitrum-sepolia',
        }),
      },
      asset: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asset-1',
          symbol: 'TEST',
          chain: Chain.ARBITRUM_SEPOLIA,
          tokenAddress: '0x1111111111111111111111111111111111111111',
          contractVerifiedAt: null,
          contractCodeHash: null,
          verifiedChainId: null,
        }),
      },
      tokenContract: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new AssetsService(prisma as unknown as PrismaService, {} as RpcProvider);

    await expect(
      service.updateTransfers('TEST', {
        depositEnabled: true,
        withdrawalEnabled: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('verifies bytecode, symbol, decimals and chain before recording a code hash', async () => {
    const prisma = {
      $transaction: jest.fn(),
      network: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'network-1',
          legacyChain: Chain.ARBITRUM_SEPOLIA,
          chainId: 421614,
          chainKey: 'arbitrum-sepolia',
        }),
      },
      asset: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'asset-1',
          symbol: 'USDC',
          chain: Chain.ARBITRUM_SEPOLIA,
          tokenAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
          decimals: 6,
        }),
        update: jest.fn(({ data }) => Promise.resolve(data)),
      },
      tokenContract: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const rpc = {
      getChainId: jest.fn().mockResolvedValue(421614),
      getCode: jest.fn().mockResolvedValue('0x6001600055'),
      getErc20Metadata: jest.fn().mockResolvedValue({ symbol: 'USDC', decimals: 6 }),
    };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      rpc as unknown as RpcProvider,
    );

    await service.verifyContract('USDC');

    expect(prisma.asset.update).toHaveBeenCalledWith({
      where: { id: 'asset-1' },
      data: expect.objectContaining({
        verifiedChainId: 421614,
        contractVerifiedAt: expect.any(Date),
        contractCodeHash: expect.stringMatching(/^0x[a-f0-9]{64}$/),
      }),
    });
  });
});

describe('AssetsService bulk testnet automation', () => {
  const testnetNetwork = {
    id: 'network-base-sepolia',
    chainKey: 'base-sepolia',
    displayName: 'Base Sepolia',
    family: NetworkFamily.EVM,
    legacyChain: Chain.BASE_SEPOLIA,
    chainId: 84532,
    mainnet: false,
    depositEnabled: false,
    withdrawalEnabled: false,
  };
  const nativeContract = {
    id: 'contract-eth-base-sepolia',
    assetId: 'asset-eth',
    networkId: testnetNetwork.id,
    standard: TokenStandard.NATIVE,
    address: null,
    decimals: 18,
    depositEnabled: false,
    withdrawalEnabled: false,
    contractVerifiedAt: null,
    contractCodeHash: null,
    verifiedChainId: null,
    metadata: null,
    asset: {
      id: 'asset-eth',
      symbol: 'ETH',
      decimals: 18,
    },
    network: testnetNetwork,
  };

  it('dry-runs native verification after checking the RPC chain id', async () => {
    const prisma = {
      network: {
        findMany: jest.fn().mockResolvedValue([testnetNetwork]),
      },
      tokenContract: {
        findMany: jest.fn().mockResolvedValue([nativeContract]),
      },
    };
    const rpc = {
      getChainId: jest.fn().mockResolvedValue(84532),
    };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      rpc as unknown as RpcProvider,
    );

    const result = await service.bulkVerify({
      scope: 'testnet',
      networks: ['base-sepolia'],
      standards: [TokenStandard.NATIVE],
      dryRun: true,
    });

    expect(result.summary).toEqual({ would_verify: 1 });
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        assetSymbol: 'ETH',
        network: 'base-sepolia',
        standard: TokenStandard.NATIVE,
        status: 'would_verify',
        verifiedChainId: 84532,
      }),
    );
    expect(rpc.getChainId).toHaveBeenCalledWith('base-sepolia');
  });

  it('enables verified native testnet deposits and withdrawals when a hot wallet exists', async () => {
    const verifiedNativeContract = {
      ...nativeContract,
      contractVerifiedAt: new Date(),
      verifiedChainId: 84532,
    };
    const prisma = {
      $transaction: jest.fn(),
      network: {
        findMany: jest.fn().mockResolvedValue([testnetNetwork]),
        update: jest.fn(),
      },
      tokenContract: {
        findMany: jest.fn().mockResolvedValue([verifiedNativeContract]),
        update: jest.fn(),
      },
      custodyAccount: {
        findFirst: jest.fn().mockResolvedValue({
          role: CustodyAccountRole.WITHDRAWAL_HOT,
          status: CustodyAccountStatus.ACTIVE,
          address: '0x1111111111111111111111111111111111111111',
          providerWalletRef: 'privy-wallet-1',
        }),
      },
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => unknown) => callback(prisma),
    );
    const service = new AssetsService(prisma as unknown as PrismaService, {} as RpcProvider);

    const result = await service.bulkEnableTransfers({
      scope: 'testnet',
      networks: ['base-sepolia'],
      assetSymbols: ['ETH'],
      standards: [TokenStandard.NATIVE],
      deposits: true,
      withdrawals: true,
    });

    expect(result.summary).toEqual({ enabled: 1 });
    expect(prisma.network.update).toHaveBeenCalledWith({
      where: { id: testnetNetwork.id },
      data: { depositEnabled: true, withdrawalEnabled: true },
    });
    expect(prisma.tokenContract.update).toHaveBeenCalledWith({
      where: { id: nativeContract.id },
      data: { depositEnabled: true, withdrawalEnabled: true },
    });
  });

  it('rejects mainnet bulk operations', async () => {
    const prisma = {
      network: {
        findMany: jest.fn().mockResolvedValue([
          { ...testnetNetwork, chainKey: 'base', mainnet: true },
        ]),
      },
      tokenContract: {
        findMany: jest.fn(),
      },
    };
    const service = new AssetsService(prisma as unknown as PrismaService, {} as RpcProvider);

    await expect(
      service.bulkEnableTransfers({
        scope: 'testnet',
        networks: ['base'],
        deposits: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
