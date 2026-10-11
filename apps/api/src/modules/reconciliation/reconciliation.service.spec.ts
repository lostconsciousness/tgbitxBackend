import {
  PositionSide,
  Prisma,
  ReconciliationStatus,
  ReconciliationType,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { HyperliquidExecutionService } from '../hyperliquid/hyperliquid-execution.service';
import { TreasuryService } from '../treasury/treasury.service';
import { ReconciliationService } from './reconciliation.service';
import { OperationalSettingsService } from '../settings/operational-settings.service';
import { OrdersService } from '../orders/orders.service';

describe('ReconciliationService provider checks', () => {
  it('fails provider order reconciliation when Hyperliquid is disabled but internal provider orders exist', async () => {
    const prisma = {
      reconciliationRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        update: jest.fn().mockImplementation(({ data }: { data: unknown }) => data),
      },
      providerOrder: {
        findMany: jest.fn().mockResolvedValue([{ id: 'provider-order-1' }]),
      },
    };
    const service = new ReconciliationService(
      prisma as unknown as PrismaService,
      {} as TreasuryService,
      { isExecutionEnabled: jest.fn().mockReturnValue(false) } as unknown as HyperliquidExecutionService,
      { setBoolean: jest.fn() } as unknown as OperationalSettingsService,
      {} as OrdersService,
    );

    const result = await service.runProviderOrdersCheck();

    expect(prisma.reconciliationRun.create).toHaveBeenCalledWith({
      data: {
        type: ReconciliationType.PROVIDER_ORDERS,
        status: ReconciliationStatus.RUNNING,
      },
    });
    expect(result).toMatchObject({
      status: ReconciliationStatus.FAILED,
      details: {
        enabled: false,
        internalProviderOrders: 1,
      },
    });
  });

  it('fails provider position reconciliation when aggregate internal and provider positions differ', async () => {
    const prisma = {
      reconciliationRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-2' }),
        update: jest.fn().mockImplementation(({ data }: { data: unknown }) => data),
      },
      position: {
        findMany: jest.fn().mockResolvedValue([{
          side: PositionSide.LONG,
          size: new Prisma.Decimal('0.01'),
          market: { providerSymbol: 'BTC', sizePrecision: 5 },
        }]),
      },
    };
    const settings = {
      setBoolean: jest.fn(),
      getDecimalsByPrefix: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new ReconciliationService(
      prisma as unknown as PrismaService,
      {} as TreasuryService,
      {
        isExecutionEnabled: jest.fn().mockReturnValue(true),
        getAccountState: jest.fn().mockResolvedValue({
          assetPositions: [{ position: { coin: 'BTC', szi: '0.02' } }],
        }),
        getLiquidationFills: jest.fn().mockResolvedValue([]),
      } as unknown as HyperliquidExecutionService,
      settings as unknown as OperationalSettingsService,
      {} as OrdersService,
    );

    const now = jest.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000);
    const pending = await service.runProviderPositionsCheck();
    now.mockReturnValueOnce(7_000);
    const result = await service.runProviderPositionsCheck();

    expect(settings.setBoolean).toHaveBeenCalledWith(
      'abook:reconciliation-paused',
      true,
    );
    expect(pending).toMatchObject({
      status: ReconciliationStatus.PASSED,
      details: {
        mismatches: [],
        pendingMismatches: [expect.objectContaining({ symbol: 'BTC' })],
      },
    });
    expect(result).toMatchObject({
      status: ReconciliationStatus.FAILED,
      details: { mismatches: [expect.objectContaining({ symbol: 'BTC' })] },
    });
    now.mockRestore();
  });

  it('accounts for audited provider residual inventory without changing user positions', async () => {
    const prisma = {
      reconciliationRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-3' }),
        update: jest.fn().mockImplementation(({ data }: { data: unknown }) => data),
      },
      position: {
        findMany: jest.fn().mockResolvedValue([{
          side: PositionSide.SHORT,
          size: new Prisma.Decimal('0.00159'),
          market: { providerSymbol: 'BTC', sizePrecision: 5 },
        }]),
      },
    };
    const settings = {
      setBoolean: jest.fn(),
      getDecimalsByPrefix: jest.fn().mockResolvedValue(
        new Map([['BTC', new Prisma.Decimal('0.00003')]]),
      ),
    };
    const service = new ReconciliationService(
      prisma as unknown as PrismaService,
      {} as TreasuryService,
      {
        isExecutionEnabled: jest.fn().mockReturnValue(true),
        getAccountState: jest.fn().mockResolvedValue({
          assetPositions: [{ position: { coin: 'BTC', szi: '-0.00156' } }],
        }),
        getLiquidationFills: jest.fn().mockResolvedValue([]),
      } as unknown as HyperliquidExecutionService,
      settings as unknown as OperationalSettingsService,
      {} as OrdersService,
    );

    const result = await service.runProviderPositionsCheck();

    expect(settings.setBoolean).toHaveBeenCalledWith(
      'abook:reconciliation-paused',
      false,
    );
    expect(result).toMatchObject({
      status: ReconciliationStatus.PASSED,
      details: {
        providerPositionOffsets: [{ symbol: 'BTC', size: '0.00003' }],
        mismatches: [],
        pendingMismatches: [],
      },
    });
  });

  it('settles confirmed master liquidation fills before comparing provider positions', async () => {
    const prisma = {
      reconciliationRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-4' }),
        update: jest.fn().mockImplementation(({ data }: { data: unknown }) => data),
      },
      position: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const settings = {
      setBoolean: jest.fn(),
      getDecimalsByPrefix: jest.fn().mockResolvedValue(new Map()),
    };
    const orders = {
      settleExternalProviderLiquidation: jest.fn().mockResolvedValue({
        settled: true,
        positions: 2,
        userIds: ['user-1', 'user-2'],
      }),
    };
    const liquidationFill = {
      providerFillId: 'hyperliquid:11',
      providerOrderId: '21',
      providerSymbol: 'ETH',
      positionSide: 'LONG' as const,
      price: '2572',
      size: '0.2006',
      feeAmount: '0.232174',
      occurredAt: new Date('2026-10-07T10:07:40.259Z'),
    };
    const service = new ReconciliationService(
      prisma as unknown as PrismaService,
      {} as TreasuryService,
      {
        isExecutionEnabled: jest.fn().mockReturnValue(true),
        getLiquidationFills: jest.fn().mockResolvedValue([liquidationFill]),
        getAccountState: jest.fn().mockResolvedValue({ assetPositions: [] }),
      } as unknown as HyperliquidExecutionService,
      settings as unknown as OperationalSettingsService,
      orders as unknown as OrdersService,
    );

    const result = await service.runProviderPositionsCheck();

    expect(orders.settleExternalProviderLiquidation).toHaveBeenCalledWith({
      ...liquidationFill,
      positionSide: PositionSide.LONG,
    });
    expect(settings.setBoolean).toHaveBeenCalledWith(
      'abook:reconciliation-paused',
      false,
    );
    expect(result).toMatchObject({
      status: ReconciliationStatus.PASSED,
      details: {
        providerLiquidationRecovery: [{
          providerFillId: 'hyperliquid:11',
          providerSymbol: 'ETH',
          settled: true,
          positions: 2,
        }],
        mismatches: [],
      },
    });
  });
});
