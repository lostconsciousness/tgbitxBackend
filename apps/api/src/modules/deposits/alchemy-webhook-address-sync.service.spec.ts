import { ConfigService } from '@nestjs/config';
import { Chain } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AlchemyWebhookAddressSyncService } from './alchemy-webhook-address-sync.service';

describe('AlchemyWebhookAddressSyncService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('adds only missing active addresses to the configured network webhook', async () => {
    const existing = '0x1111111111111111111111111111111111111111';
    const missing = '0x2222222222222222222222222222222222222222';
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({
          data: [existing],
          pagination: { cursors: {} },
        })),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue('{}'),
      });
    global.fetch = fetchMock as unknown as typeof fetch;
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          ALCHEMY_ADDRESS_ACTIVITY_ENABLED: true,
          ALCHEMY_WEBHOOK_AUTH_TOKEN: 'notify-token',
          ALCHEMY_WEBHOOK_IDS_JSON: JSON.stringify({ arbitrum: 'wh_arbitrum' }),
        };
        return values[key] ?? fallback;
      }),
    } as unknown as ConfigService;
    const prisma = {
      userDepositAddress: {
        findMany: jest.fn().mockResolvedValue([
          { address: existing },
          { address: missing },
        ]),
      },
    } as unknown as PrismaService;
    const service = new AlchemyWebhookAddressSyncService(config, prisma);

    await expect(service.reconcileAll()).resolves.toEqual({ webhooks: 1, added: 1 });

    expect(prisma.userDepositAddress.findMany).toHaveBeenCalledWith({
      where: { network: Chain.ARBITRUM, status: 'ACTIVE' },
      select: { address: true },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://dashboard.alchemy.com/api/update-webhook-addresses',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          webhook_id: 'wh_arbitrum',
          addresses_to_add: [missing],
          addresses_to_remove: [],
        }),
      }),
    );
  });

  it('does not call Alchemy while the event-driven gate is disabled', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = new AlchemyWebhookAddressSyncService(
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'ALCHEMY_ADDRESS_ACTIVITY_ENABLED' ? false : fallback),
      } as unknown as ConfigService,
      {} as PrismaService,
    );

    await expect(
      service.trackAddress('arbitrum', '0x1111111111111111111111111111111111111111'),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
