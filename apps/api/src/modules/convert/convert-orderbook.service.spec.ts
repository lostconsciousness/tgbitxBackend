import { ConfigService } from '@nestjs/config';
import { ConversionProvider, Prisma } from '@prisma/client';
import { ConvertOrderbookService } from './convert-orderbook.service';

describe('ConvertOrderbookService', () => {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        CONVERT_ENABLED: true,
        CONVERT_EVM_ENABLED: true,
        CONVERT_ORDERBOOK_CACHE_MS: 30_000,
        CONVERT_ORDERBOOK_STREAM_MS: 5_000,
      };
      return values[key] ?? fallback;
    }),
  } as unknown as ConfigService;

  function createService() {
    const oneInch = {
      getStatus: jest.fn().mockReturnValue({ enabled: true }),
      quoteExactInput: jest.fn(),
    };
    const convert = {
      listSpotCatalog: jest.fn().mockResolvedValue({
        pairs: [{
          symbol: 'AAVE-USDC',
          baseAsset: 'AAVE',
          quoteAsset: 'USDC',
          provider: ConversionProvider.ONEINCH,
          preferredNetwork: 'arbitrum',
          ticker: { lastPrice: '100' },
        }],
      }),
    };
    const service = new ConvertOrderbookService(
      {} as any,
      config,
      oneInch as any,
      convert as any,
    );
    return { service, oneInch, convert };
  }

  it('returns a 24-level seed immediately while quoted depth refreshes in background', async () => {
    const { service, oneInch } = createService();
    jest.spyOn(service as any, 'buildQuoted').mockImplementation(
      () => new Promise(() => undefined),
    );

    const snapshot = await service.getOrderBook('AAVE-USDC');

    expect(snapshot).toEqual(expect.objectContaining({
      symbol: 'AAVE-USDC',
      indicative: true,
      quality: 'REFERENCE_SEED',
      network: 'arbitrum',
    }));
    expect(snapshot.bids).toHaveLength(24);
    expect(snapshot.asks).toHaveLength(24);
    expect(Number(snapshot.bids[0]!.price)).toBeGreaterThan(Number(snapshot.bids[23]!.price));
    expect(Number(snapshot.asks[0]!.price)).toBeLessThan(Number(snapshot.asks[23]!.price));
    expect(oneInch.quoteExactInput).not.toHaveBeenCalled();
  });

  it('expands three cumulative 1inch anchors into twenty-four incremental levels', () => {
    const { service } = createService();
    const asks = (service as any).expandCumulativeAnchors([
      { price: '100', size: '0.25', total: '25' },
      { price: '101.0101', size: '0.99', total: '100' },
      { price: '105.2632', size: '3.8', total: '400' },
    ], 'ask');
    const bids = (service as any).expandCumulativeAnchors([
      { price: '99', size: '0.25252525', total: '25' },
      { price: '98', size: '1.02040816', total: '100' },
      { price: '95', size: '4.21052632', total: '400' },
    ], 'bid');

    expect(asks).toHaveLength(24);
    expect(bids).toHaveLength(24);
    expect(asks.every((level: any, index: number) =>
      index === 0 || Number(level.price) >= Number(asks[index - 1]!.price))).toBe(true);
    expect(bids.every((level: any, index: number) =>
      index === 0 || Number(level.price) <= Number(bids[index - 1]!.price))).toBe(true);
    expect(Number(asks[23]!.total)).toBeGreaterThan(399);
    expect(Number(bids[23]!.total)).toBeGreaterThan(399);
  });

  it('rescales live prices without changing provider-backed sizes', () => {
    const { service } = createService();
    const scaled = (service as any).scaleLevels([
      { price: '100', size: '0.00004882', total: '0.01' },
      { price: '99', size: '0.00010000', total: '0.02' },
    ], new Prisma.Decimal('1.01'));

    expect(scaled.map((level: any) => level.size)).toEqual(['0.00004882', '0.00010000']);
  });
});
