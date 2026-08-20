import { MarketStatus, MarketType, PrismaClient } from '@prisma/client';
import {
  hyperliquidTradingViewSymbolFor,
  syncHyperliquidPerpMarkets,
} from './hyperliquid-perp-market.sync';

describe('hyperliquidTradingViewSymbolFor', () => {
  it('uses the Hyperliquid perpetual ticker instead of the spot ticker', () => {
    expect(hyperliquidTradingViewSymbolFor('BTC')).toBe('HYPERLIQUID:BTCUSDC.P');
  });

  it('preserves scaled provider contracts', () => {
    expect(hyperliquidTradingViewSymbolFor('kPEPE')).toBe('HYPERLIQUID:KPEPEUSDC.P');
    expect(hyperliquidTradingViewSymbolFor('kSHIB')).toBe('HYPERLIQUID:KSHIBUSDC.P');
    expect(hyperliquidTradingViewSymbolFor('kFLOKI')).toBe('HYPERLIQUID:KFLOKIUSDC.P');
  });
});

describe('syncHyperliquidPerpMarkets', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deactivates an existing provider market when Hyperliquid delists it', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        universe: [{ name: 'IP', szDecimals: 1, maxLeverage: 3, isDelisted: true }],
      }),
    } as Response);
    const prisma = {
      asset: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'usdc', symbol: 'USDC' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'usdc', symbol: 'USDC' }]),
      },
      market: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const result = await syncHyperliquidPerpMarkets(prisma as unknown as PrismaClient);

    expect(prisma.market.updateMany).toHaveBeenCalledWith({
      where: {
        type: MarketType.PERP,
        providerName: 'HYPERLIQUID',
        providerSymbol: 'IP',
        status: MarketStatus.ACTIVE,
      },
      data: {
        status: MarketStatus.DISABLED,
        orderbookEnabled: false,
      },
    });
    expect(result).toEqual({
      total: 1,
      marketsUpserted: 0,
      assetsCreated: 0,
      skippedDelisted: 1,
      marketsDeactivated: 1,
    });
  });
});
