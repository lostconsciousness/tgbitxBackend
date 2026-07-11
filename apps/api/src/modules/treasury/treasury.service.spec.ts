import { ConfigService } from '@nestjs/config';
import {
  AssetType,
  Chain,
  CustodyAccountRole,
  CustodyAccountStatus,
  Prisma,
  TokenStandard,
  TreasuryTransferStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { AuditService } from '../audit/audit.service';
import { PrivyCustodyService } from './privy-custody.service';
import { TreasuryService } from './treasury.service';

const usdc = {
  id: 'asset-usdc',
  symbol: 'USDC',
  name: 'USD Coin',
  type: AssetType.STABLECOIN,
  chain: Chain.ARBITRUM_SEPOLIA,
  tokenAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  decimals: 6,
  depositEnabled: true,
  withdrawalEnabled: true,
  withdrawalFeeAmount: new Prisma.Decimal(0),
  minWithdrawalAmount: new Prisma.Decimal('0.000001'),
  contractVerifiedAt: new Date(),
  contractCodeHash: '0xabc',
  verifiedChainId: 421614,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const treasury = {
  id: 'treasury-account',
  role: CustodyAccountRole.DEPOSIT_TREASURY,
  network: Chain.ARBITRUM_SEPOLIA,
  provider: 'PRIVY',
  address: '0xafc991ba121e3e8a96c248b9d83de4d543c09631',
  providerWalletRef: 'treasury-wallet-id',
  status: CustodyAccountStatus.ACTIVE,
};

const hot = {
  id: 'hot-account',
  role: CustodyAccountRole.WITHDRAWAL_HOT,
  network: Chain.ARBITRUM_SEPOLIA,
  provider: 'PRIVY',
  address: '0xea0166f55ee7fbdbca3975c06af9abeb24c99603',
  providerWalletRef: 'hot-wallet-id',
  status: CustodyAccountStatus.ACTIVE,
};

const network = {
  id: 'network-arbitrum-sepolia',
  chainKey: 'arbitrum-sepolia',
  legacyChain: Chain.ARBITRUM_SEPOLIA,
  chainId: 421614,
};

const usdcContract = {
  id: 'contract-usdc',
  standard: TokenStandard.ERC20,
  address: usdc.tokenAddress,
  decimals: 6,
  contractVerifiedAt: new Date(),
  contractCodeHash: '0xabc',
  verifiedChainId: 421614,
};

describe('TreasuryService auto rebalance', () => {
  let service: TreasuryService;
  let prisma: {
    treasuryTransfer: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    asset: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    network: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    tokenContract: {
      findUnique: jest.Mock;
    };
    custodyAccount: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
    userDepositAddress: {
      groupBy: jest.Mock;
      findMany: jest.Mock;
    };
    depositSweep: {
      groupBy: jest.Mock;
    };
    custodyBalanceSnapshot: {
      create: jest.Mock;
    };
  };
  let custody: jest.Mocked<Pick<
    PrivyCustodyService,
    'isEnabled' | 'sendErc20FromWallet' | 'sendNativeFromSweepGas' | 'getTransaction'
  >>;
  let rpc: jest.Mocked<Pick<RpcProvider, 'getBalance' | 'getTransaction' | 'getLatestBlockNumber'>>;
  let audit: jest.Mocked<Pick<AuditService, 'record'>>;

  beforeEach(() => {
    prisma = {
      treasuryTransfer: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({
          id: 'transfer-1',
          sourceAccount: treasury,
          destinationAccount: hot,
          asset: usdc,
        }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      asset: {
        findUnique: jest.fn().mockResolvedValue(usdc),
        findMany: jest.fn().mockResolvedValue([usdc]),
      },
      network: {
        findFirst: jest.fn().mockResolvedValue(network),
        findUnique: jest.fn().mockResolvedValue(network),
        findMany: jest.fn().mockResolvedValue([network]),
      },
      tokenContract: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(usdcContract),
      },
      custodyAccount: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { role: CustodyAccountRole } }) => {
          if (where.role === CustodyAccountRole.DEPOSIT_TREASURY) {
            return Promise.resolve(treasury);
          }
          if (where.role === CustodyAccountRole.WITHDRAWAL_HOT) {
            return Promise.resolve(hot);
          }
          return Promise.resolve(null);
        }),
        findMany: jest.fn().mockResolvedValue([treasury, hot]),
      },
      userDepositAddress: {
        groupBy: jest.fn(),
        findMany: jest.fn(),
      },
      depositSweep: {
        groupBy: jest.fn(),
      },
      custodyBalanceSnapshot: {
        create: jest.fn(),
      },
    };
    custody = {
      isEnabled: jest.fn().mockReturnValue(true),
      sendErc20FromWallet: jest.fn().mockResolvedValue({
        txHash: '0xabc',
        providerRequestId: 'provider-transfer-1',
      }),
      sendNativeFromSweepGas: jest.fn().mockResolvedValue({
        txHash: '0xgas',
        providerRequestId: 'provider-gas-1',
      }),
      getTransaction: jest.fn(),
    };
    rpc = {
      getBalance: jest
        .fn()
        .mockResolvedValueOnce({ address: hot.address, token: usdc.tokenAddress, value: '0' })
        .mockResolvedValueOnce({ address: treasury.address, token: usdc.tokenAddress, value: '20' }),
      getTransaction: jest.fn(),
      getLatestBlockNumber: jest.fn(),
    };
    audit = {
      record: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    };

    service = new TreasuryService(
      prisma as unknown as PrismaService,
      {
        get: jest.fn((key: string, fallback?: unknown) => {
          const values: Record<string, unknown> = {
            TREASURY_REBALANCE_ENABLED: true,
            MAINNET_ENABLED: false,
            TREASURY_REBALANCE_ASSET_SYMBOL: 'USDC',
            TREASURY_REBALANCE_HOT_MIN_AMOUNT: '5',
            TREASURY_REBALANCE_HOT_TARGET_AMOUNT: '10',
            TREASURY_REBALANCE_MAX_SINGLE_AMOUNT: '8',
            ONCHAIN_CHAIN_ID: 421614,
          };
          return values[key] ?? fallback;
        }),
      } as unknown as ConfigService,
      custody as unknown as PrivyCustodyService,
      audit as unknown as AuditService,
      rpc as unknown as RpcProvider,
    );
  });

  it('tops up the hot wallet from treasury when below minimum', async () => {
    await service.runAutoRebalance();

    expect(prisma.treasuryTransfer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceAccountId: treasury.id,
          destinationAccountId: hot.id,
          assetId: usdc.id,
          amount: expect.objectContaining({ toString: expect.any(Function) }),
          status: TreasuryTransferStatus.BROADCASTING,
        }),
      }),
    );
    const createdAmount = prisma.treasuryTransfer.create.mock.calls[0]![0].data.amount;
    expect(createdAmount.toString()).toBe('8');
    expect(custody.sendErc20FromWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: treasury.providerWalletRef,
        recipient: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
        rawAmount: 8_000_000n,
        referenceId: 'treasury-rebalance:transfer-1',
      }),
    );
    expect(prisma.treasuryTransfer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'transfer-1' },
        data: expect.objectContaining({
          status: TreasuryTransferStatus.BROADCASTED,
          txHash: '0xabc',
          providerRequestId: 'provider-transfer-1',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TREASURY_REBALANCE_STARTED' }),
    );
  });

  it('does not create a duplicate rebalance while another transfer is active', async () => {
    prisma.treasuryTransfer.findFirst.mockResolvedValueOnce({
      id: 'active-transfer',
      status: TreasuryTransferStatus.BROADCASTED,
    });

    await service.runAutoRebalance();

    expect(prisma.treasuryTransfer.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        sourceAccountId: treasury.id,
        destinationAccountId: hot.id,
        assetId: usdc.id,
      }),
    });
    expect(prisma.treasuryTransfer.create).not.toHaveBeenCalled();
    expect(custody.sendErc20FromWallet).not.toHaveBeenCalled();
  });

  it('delegates ensureHotWalletNativeGas to native balance funding', async () => {
    prisma.asset.findUnique.mockResolvedValue({
      id: 'asset-eth',
      symbol: 'ETH',
    });
    prisma.tokenContract.findUnique.mockReset().mockResolvedValue({
      id: 'contract-eth',
      standard: TokenStandard.NATIVE,
      address: null,
      decimals: 18,
      contractVerifiedAt: new Date(),
      verifiedChainId: 421614,
    });

    const ensure = jest
      .spyOn(
        service as unknown as {
          ensureHotWalletNativeBalance: TreasuryService['ensureHotWalletNativeBalance'];
        },
        'ensureHotWalletNativeBalance',
      )
      .mockResolvedValue(undefined);

    await service.ensureHotWalletNativeGas({ networkKey: 'arbitrum-sepolia' });

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]![1].toString()).toBe('0.00003');
  });

  it('tops up withdrawal hot wallet from SWEEP_GAS when treasury native gas is empty', async () => {
    prisma.asset.findUnique.mockResolvedValue({
      id: 'asset-eth',
      symbol: 'ETH',
    });
    prisma.tokenContract.findUnique.mockReset().mockResolvedValue({
      id: 'contract-eth',
      standard: TokenStandard.NATIVE,
      address: null,
      decimals: 18,
      contractVerifiedAt: new Date(),
      verifiedChainId: 421614,
    });
    const config = (service as unknown as { config: { get: jest.Mock } }).config;
    config.get.mockImplementation((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        TREASURY_REBALANCE_ENABLED: true,
        TREASURY_REBALANCE_HOT_MIN_AMOUNT: '0.00001',
        TREASURY_REBALANCE_HOT_TARGET_AMOUNT: '0.00003',
        TREASURY_REBALANCE_MAX_SINGLE_AMOUNT: '0.00003',
        TREASURY_REBALANCE_WAIT_MS: 4_000,
        TREASURY_REBALANCE_POLL_MS: 50,
        SWEEP_GAS_TOPUP_WEI: '100000000000000',
        SWEEP_GAS_MAX_TOPUP_WEI: '1000000000000000',
      };
      return values[key] ?? fallback;
    });
    let hotBalanceWei = 0n;
    rpc.getBalance.mockReset().mockImplementation((address: string) => {
      if (address === hot.address) {
        return Promise.resolve({ address, value: hotBalanceWei.toString() });
      }
      if (address === treasury.address) {
        return Promise.resolve({ address, value: '0' });
      }
      return Promise.resolve({ address, value: '0' });
    });
    custody.sendNativeFromSweepGas.mockImplementation(async () => {
      hotBalanceWei = 100_000_000_000_000n;
      return { txHash: '0xgas', providerRequestId: 'provider-gas-1' };
    });

    await service.ensureHotWalletNativeGas({ networkKey: 'arbitrum-sepolia', maxWaitMs: 4_000 });

    expect(custody.sendNativeFromSweepGas).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: expect.stringMatching(/^0x/i),
        chainId: 421614,
      }),
    );
  });

  it('funds treasury gas before broadcasting an ERC20 rebalance', async () => {
    const config = (service as unknown as { config: { get: jest.Mock } }).config;
    config.get.mockImplementation((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        TREASURY_REBALANCE_ENABLED: true,
        MAINNET_ENABLED: false,
        TREASURY_REBALANCE_ASSET_SYMBOL: 'USDC',
        TREASURY_REBALANCE_HOT_MIN_AMOUNT: '5',
        TREASURY_REBALANCE_HOT_TARGET_AMOUNT: '10',
        TREASURY_REBALANCE_MAX_SINGLE_AMOUNT: '8',
        ONCHAIN_CHAIN_ID: 421614,
        SWEEP_GAS_TOPUP_WEI: '100000000000000',
        SWEEP_GAS_MAX_TOPUP_WEI: '1000000000000000',
      };
      return values[key] ?? fallback;
    });
    rpc.getBalance
      .mockReset()
      .mockResolvedValueOnce({ address: hot.address, token: usdc.tokenAddress, value: '0' })
      .mockResolvedValueOnce({ address: treasury.address, token: usdc.tokenAddress, value: '20' })
      .mockResolvedValueOnce({ address: treasury.address, token: undefined, value: '0' })
      .mockResolvedValueOnce({
        address: treasury.address,
        token: undefined,
        value: '100000000000000',
      });

    await service.runAutoRebalance();

    expect(custody.sendNativeFromSweepGas).toHaveBeenCalledWith({
      recipient: expect.stringMatching(/^0x[a-fA-F0-9]{40}$/),
      value: 100000000000000n,
      referenceId: 'treasury-rebalance-gas:transfer-1',
      chainId: 421614,
    });
    expect(custody.sendNativeFromSweepGas.mock.invocationCallOrder[0]).toBeLessThan(
      custody.sendErc20FromWallet.mock.invocationCallOrder[0]!,
    );
  });

  it('moves only enough treasury funds to reach the configured hot-wallet percentage', async () => {
    const config = (service as unknown as { config: { get: jest.Mock } }).config;
    config.get.mockImplementation((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        TREASURY_REBALANCE_ENABLED: true,
        MAINNET_ENABLED: false,
        TREASURY_REBALANCE_ASSET_SYMBOL: 'USDC',
        TREASURY_REBALANCE_HOT_MIN_AMOUNT: '5',
        TREASURY_REBALANCE_HOT_TARGET_AMOUNT: '10',
        TREASURY_REBALANCE_MAX_SINGLE_AMOUNT: '0.2',
        TREASURY_REBALANCE_HOT_PERCENT: 50,
        ONCHAIN_CHAIN_ID: 421614,
      };
      return values[key] ?? fallback;
    });
    rpc.getBalance
      .mockReset()
      .mockResolvedValueOnce({ address: hot.address, token: usdc.tokenAddress, value: '10' })
      .mockResolvedValueOnce({ address: treasury.address, token: usdc.tokenAddress, value: '90' });

    await service.runAutoRebalance();

    const createdAmount = prisma.treasuryTransfer.create.mock.calls[0]![0].data.amount;
    expect(createdAmount.toString()).toBe('40');
    expect(custody.sendErc20FromWallet).toHaveBeenCalledWith(
      expect.objectContaining({ rawAmount: 40_000_000n }),
    );
  });

  it('confirms native treasury transfers on their own network', async () => {
    prisma.network.findFirst.mockResolvedValue(network);
    prisma.tokenContract.findUnique.mockReset().mockResolvedValue({
      id: 'contract-eth',
      standard: TokenStandard.NATIVE,
      address: null,
      decimals: 18,
    });
    rpc.getTransaction.mockResolvedValue({
      hash: '0xnative',
      blockNumber: 100,
      status: 1,
      to: hot.address,
      value: '1000000000000000000',
      logs: [],
    });
    rpc.getLatestBlockNumber.mockResolvedValue(120);

    await (service as unknown as {
      confirmTransfer(input: unknown): Promise<void>;
    }).confirmTransfer({
      id: 'native-transfer-1',
      txHash: '0xnative',
      amount: new Prisma.Decimal(1),
      assetId: 'asset-eth',
      sourceAccount: { address: treasury.address, network: Chain.ARBITRUM_SEPOLIA },
      destinationAccount: { address: hot.address },
      asset: { decimals: 18 },
    });

    expect(rpc.getTransaction).toHaveBeenCalledWith('0xnative', 'arbitrum-sepolia');
    expect(prisma.treasuryTransfer.update).toHaveBeenCalledWith({
      where: { id: 'native-transfer-1' },
      data: expect.objectContaining({ status: TreasuryTransferStatus.CONFIRMED }),
    });
  });

  it('releases a stale pre-broadcast transfer after an interrupted gas wait', async () => {
    prisma.treasuryTransfer.findMany.mockResolvedValueOnce([{ id: 'stale-transfer-1' }]);

    await (service as unknown as {
      failStalePreBroadcastTransfers(): Promise<void>;
    }).failStalePreBroadcastTransfers();

    expect(prisma.treasuryTransfer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'stale-transfer-1' }),
        data: expect.objectContaining({ status: TreasuryTransferStatus.FAILED }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TREASURY_REBALANCE_STALE_FAILED' }),
    );
  });
});
