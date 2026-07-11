import { ConfigService } from '@nestjs/config';
import { AssetType, Chain, PrismaClient, TokenStandard } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/database/prisma.service';
import { AssetsService } from '../src/modules/assets/assets.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { RpcProvider } from '../src/modules/rpc/rpc-provider.interface';
import { OperationalSettingsService } from '../src/modules/settings/operational-settings.service';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';
import { WithdrawalsService } from '../src/modules/withdrawals/withdrawals.service';

describe('Money flow PostgreSQL integration', () => {
  const prisma = new PrismaClient();
  let userId: string;
  let assetId: string;

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        email: `integration-money-${suffix}@example.com`,
        passwordHash: 'integration-only',
      },
    });
    const asset = await prisma.asset.create({
      data: {
        symbol: `I${suffix}`.toUpperCase(),
        name: 'Integration USD',
        type: AssetType.STABLECOIN,
        chain: Chain.ARBITRUM_SEPOLIA,
        tokenAddress: `0x${suffix.padEnd(40, '0')}`,
        decimals: 6,
        withdrawalEnabled: true,
        depositEnabled: true,
        withdrawalFeeAmount: 1,
        minWithdrawalAmount: 10,
      },
    });
    const network = await prisma.network.findUniqueOrThrow({
      where: { chainKey: 'arbitrum-sepolia' },
    });
    await prisma.tokenContract.create({
      data: {
        assetId: asset.id,
        networkId: network.id,
        standard: TokenStandard.ERC20,
        address: asset.tokenAddress,
        decimals: asset.decimals,
        depositEnabled: true,
        withdrawalEnabled: true,
        withdrawalFeeAmount: asset.withdrawalFeeAmount,
        minWithdrawalAmount: asset.minWithdrawalAmount,
      },
    });
    userId = user.id;
    assetId = asset.id;
  });

  afterEach(async () => {
    await prisma.withdrawal.deleteMany({ where: { userId } });
    await prisma.ledgerEntry.deleteMany({ where: { assetId } });
    await prisma.ledgerTransaction.deleteMany({
      where: { referenceId: { startsWith: 'integration-money-' } },
    });
    await prisma.ledgerAccount.deleteMany({ where: { assetId } });
    await prisma.asset.delete({ where: { id: assetId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rolls back withdrawal creation when its ledger reserve fails', async () => {
    const ledger = {
      assertSufficientUserSpotBalance: jest.fn().mockResolvedValue(undefined),
      postTransaction: jest.fn().mockRejectedValue(new Error('ledger unavailable')),
    } as unknown as LedgerService;
    const service = new WithdrawalsService(
      prisma as unknown as PrismaService,
      new AssetsService(prisma as unknown as PrismaService, {} as RpcProvider),
      ledger,
      config(),
      { isEnabled: jest.fn().mockReturnValue(false) } as unknown as PrivyCustodyService,
      {} as RpcProvider,
      { getBoolean: jest.fn().mockResolvedValue(false) } as unknown as OperationalSettingsService,
      { assertWorkerReady: jest.fn() } as never,
      { record: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });

    await expect(
      service.requestWithdrawal(userId, {
        assetSymbol: asset.symbol,
        toAddress: '0x1111111111111111111111111111111111111111',
        amount: '100',
      }),
    ).rejects.toThrow('ledger unavailable');

    await expect(prisma.withdrawal.count({ where: { userId } })).resolves.toBe(0);
  });

  it('keeps configured transfer assets on Arbitrum Sepolia without mainnet contracts', async () => {
    const assets = await prisma.asset.findMany({
      where: { symbol: { in: ['USDC', 'USDT', 'WETH', 'WBTC', 'ARB'] } },
    });
    const usdc = assets.find((asset) => asset.symbol === 'USDC');

    expect(usdc).toMatchObject({
      chain: Chain.ARBITRUM_SEPOLIA,
      tokenAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      depositEnabled: true,
      withdrawalEnabled: true,
    });
    expect(
      assets
        .filter((asset) => asset.symbol !== 'USDC')
        .every(
          (asset) =>
            asset.chain === Chain.ARBITRUM_SEPOLIA &&
            asset.depositEnabled === false &&
            asset.withdrawalEnabled === false &&
            asset.tokenAddress === null,
        ),
    ).toBe(true);
  });

  function config(): ConfigService {
    return {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          WITHDRAWAL_DAILY_LIMIT: '10000',
          WITHDRAWAL_NEW_ADDRESS_COOLDOWN_SECONDS: 0,
        };
        return values[key] ?? fallback;
      }),
    } as unknown as ConfigService;
  }
});
