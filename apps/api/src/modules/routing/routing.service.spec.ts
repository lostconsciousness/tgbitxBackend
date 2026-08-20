import { ConfigService } from '@nestjs/config';
import { ExecutionRoute, OrderSide, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { OperationalSettingsService } from '../settings/operational-settings.service';
import { RoutingService } from './routing.service';

describe('RoutingService', () => {
  it('routes within configured capital and exposure limits to B-book', async () => {
    const service = createService({
      maxBbookOrderNotional: new Prisma.Decimal(1000),
      maxMarketExposure: new Prisma.Decimal(5000),
      maxTotalExposure: new Prisma.Decimal(10000),
    });

    await expect(
      service.decide({
        marketId: 'market-1',
        notional: new Prisma.Decimal(100),
        platformMarkAgeMs: 100,
        ...eligibleMarketInput(),
      }),
    ).resolves.toBe(ExecutionRoute.B_BOOK_INTERNAL);
  });

  it('falls back to A-book when an order exceeds a B-book limit', async () => {
    const service = createService({
      maxBbookOrderNotional: new Prisma.Decimal(100),
      maxMarketExposure: new Prisma.Decimal(5000),
      maxTotalExposure: new Prisma.Decimal(10000),
    });

    await expect(
      service.decide({
        marketId: 'market-1',
        notional: new Prisma.Decimal(500),
        platformMarkAgeMs: 100,
        ...eligibleMarketInput(),
      }),
    ).resolves.toBe(ExecutionRoute.A_BOOK_HYPERLIQUID);
  });

  function createService(limits: {
    maxBbookOrderNotional: Prisma.Decimal;
    maxMarketExposure: Prisma.Decimal;
    maxTotalExposure: Prisma.Decimal;
  }) {
    return new RoutingService(
      {
        riskConfig: {
          findUnique: jest.fn().mockResolvedValue({
            bbookEnabled: true,
            maxMarkAgeMs: 2000,
            maxPlatformUnrealizedLoss: new Prisma.Decimal(2000),
            ...limits,
          }),
        },
        bBookExposure: {
          findUnique: jest.fn().mockResolvedValue({
            netNotional: new Prisma.Decimal(0),
            unrealizedPlatformPnl: new Prisma.Decimal(0),
          }),
          findMany: jest.fn().mockResolvedValue([
            { netNotional: new Prisma.Decimal(0) },
          ]),
        },
      } as unknown as PrismaService,
      {
        get: jest.fn((key: string, fallback?: unknown) => {
          const values: Record<string, unknown> = {
            BBOOK_ENABLED: true,
            PLATFORM_CAPITAL_USDC: '10000',
            INSURANCE_CAPITAL_USDC: '2000',
          };
          return values[key] ?? fallback;
        }),
      } as unknown as ConfigService,
      {
        getBoolean: jest.fn().mockResolvedValue(false),
      } as unknown as OperationalSettingsService,
    );
  }

  function eligibleMarketInput() {
    return {
      side: OrderSide.BUY,
      notional24h: new Prisma.Decimal('5000000'),
      referenceMark: new Prisma.Decimal('100'),
      book: {
        symbol: 'BTC-PERP',
        provider: 'HYPERLIQUID',
        providerSymbol: 'BTC',
        time: Date.now(),
        bids: [{ price: '99.95', size: '100', orders: 1 }],
        asks: [{ price: '100.05', size: '100', orders: 1 }],
      },
    };
  }
});
