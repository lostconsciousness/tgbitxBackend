import { ConfigService } from '@nestjs/config';
import { Chain, NetworkFamily, TokenStandard } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { AlchemyDepositWebhookService } from './alchemy-deposit-webhook.service';
import { DepositIndexerService } from './deposit-indexer.service';
import { DepositsService } from './deposits.service';

describe('AlchemyDepositWebhookService', () => {
  const signingKey = 'alchemy-signing-key';
  const depositAddress = '0x1111111111111111111111111111111111111111';
  const tokenAddress = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  const payload = {
    webhookId: 'wh_arbitrum',
    id: 'whevt_1',
    createdAt: '2026-07-19T00:00:00.000Z',
    type: 'ADDRESS_ACTIVITY',
    event: {
      network: 'ARB_MAINNET',
      activity: [
        {
          blockNum: '0x64',
          hash: `0x${'2'.repeat(64)}`,
          fromAddress: '0x2222222222222222222222222222222222222222',
          toAddress: depositAddress,
          category: 'token',
          rawContract: { address: tokenAddress, rawValue: '0x01', decimals: 6 },
          log: { address: tokenAddress, removed: false },
        },
      ],
    },
  };

  function setup(existing: { processedAt: Date | null } | null = null) {
    const config = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'ALCHEMY_ADDRESS_ACTIVITY_ENABLED') return true;
        if (key === 'ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON') {
          return JSON.stringify({ wh_arbitrum: signingKey });
        }
        return defaultValue;
      }),
    } as unknown as ConfigService;
    const prisma = {
      network: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'network-arbitrum',
          chainKey: 'arbitrum',
          legacyChain: Chain.ARBITRUM,
          family: NetworkFamily.EVM,
        }),
      },
      providerWebhookEvent: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      userDepositAddress: {
        findMany: jest.fn().mockResolvedValue([{ address: depositAddress }]),
      },
      tokenContract: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'contract-usdc',
            standard: TokenStandard.ERC20,
            address: tokenAddress,
            asset: { symbol: 'USDC' },
          },
        ]),
      },
    } as unknown as PrismaService;
    const indexer = {
      scanDeposits: jest.fn().mockResolvedValue({ deposits: [] }),
    } as unknown as DepositIndexerService;
    const deposits = {
      creditReadyDeposits: jest.fn().mockResolvedValue(0),
    } as unknown as DepositsService;
    return {
      service: new AlchemyDepositWebhookService(config, prisma, indexer, deposits),
      prisma,
      indexer,
      deposits,
    };
  }

  it('verifies and converts an incoming activity into a one-block deposit scan', async () => {
    const { service, prisma, indexer, deposits } = setup();
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', signingKey).update(raw).digest('hex');

    await expect(service.handle(raw, signature)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      scans: 1,
    });
    expect(indexer.scanDeposits).toHaveBeenCalledWith({
      assetSymbol: 'USDC',
      network: 'arbitrum',
      fromBlock: 100,
      toBlock: 100,
      latestBlock: 100,
    });
    expect(deposits.creditReadyDeposits).toHaveBeenCalled();
    expect(prisma.providerWebhookEvent.update).toHaveBeenCalledWith({
      where: { id: 'whevt_1' },
      data: { processedAt: expect.any(Date) },
    });
  });

  it('rejects a payload with an invalid signature before scanning', async () => {
    const { service, indexer } = setup();
    const raw = Buffer.from(JSON.stringify(payload));

    await expect(service.handle(raw, '0'.repeat(64))).rejects.toThrow(
      'Invalid Alchemy webhook signature',
    );
    expect(indexer.scanDeposits).not.toHaveBeenCalled();
  });

  it('acknowledges an already processed event without rescanning', async () => {
    const { service, indexer } = setup({ processedAt: new Date() });
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', signingKey).update(raw).digest('hex');

    await expect(service.handle(raw, signature)).resolves.toEqual({
      accepted: true,
      duplicate: true,
      scans: 0,
    });
    expect(indexer.scanDeposits).not.toHaveBeenCalled();
  });
});
