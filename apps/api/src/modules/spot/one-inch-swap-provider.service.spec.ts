import { ConfigService } from '@nestjs/config';
import { OneInchSwapProviderService } from './one-inch-swap-provider.service';

describe('OneInchSwapProviderService', () => {
  const config = (values: Record<string, unknown>) => ({
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    getOrThrow: jest.fn((key: string) => {
      const value = values[key];
      if (value === undefined || value === '') {
        throw new Error(`${key} is required`);
      }
      return value;
    }),
  }) as unknown as ConfigService;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns disabled status when 1inch is not configured', async () => {
    const service = new OneInchSwapProviderService(config({
      ONEINCH_ENABLED: false,
      ONEINCH_CHAIN_ID: 42161,
    }));

    await expect(service.getQuote({
      fromTokenAddress: '0x0000000000000000000000000000000000000001',
      toTokenAddress: '0x0000000000000000000000000000000000000002',
      amount: '1000',
    })).resolves.toMatchObject({
      enabled: false,
      status: 'DISABLED',
    });
  });

  it('builds authenticated 1inch quote requests', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ dstAmount: '900' }),
    } as Response);
    const service = new OneInchSwapProviderService(config({
      ONEINCH_ENABLED: true,
      ONEINCH_API_KEY: 'test-api-key',
      ONEINCH_BASE_URL: 'https://api.1inch.com/swap/v6.1',
      ONEINCH_CHAIN_ID: 42161,
    }));

    await service.getQuote({
      fromTokenAddress: '0x0000000000000000000000000000000000000001',
      toTokenAddress: '0x0000000000000000000000000000000000000002',
      amount: '1000',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining('/42161/quote'),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer test-api-key',
        }),
      }),
    );
  });

  it('accepts the 1inch API root as base URL', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ dstAmount: '900' }),
    } as Response);
    const service = new OneInchSwapProviderService(config({
      ONEINCH_ENABLED: true,
      ONEINCH_API_KEY: 'test-api-key',
      ONEINCH_BASE_URL: 'https://api.1inch.dev',
      ONEINCH_CHAIN_ID: 42161,
    }));

    await service.getQuote({
      fromTokenAddress: '0x0000000000000000000000000000000000000001',
      toTokenAddress: '0x0000000000000000000000000000000000000002',
      amount: '1000',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining('/swap/v6.1/42161/quote'),
      }),
      expect.any(Object),
    );
  });

  it('loads bulk Spot prices from the price API with the same authentication', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': '1000000000000000000',
      }),
    } as Response);
    const service = new OneInchSwapProviderService(config({
      ONEINCH_ENABLED: true,
      ONEINCH_API_KEY: 'test-api-key',
      ONEINCH_BASE_URL: 'https://api.1inch.com/swap/v6.1',
      ONEINCH_CHAIN_ID: 42161,
      ONEINCH_MIN_REQUEST_INTERVAL_MS: 0,
    }));

    await expect(service.getSpotPrices(42161)).resolves.toHaveProperty(
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://api.1inch.com/price/v1.1/42161' }),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer test-api-key' }),
      }),
    );
  });

  it('deduplicates and caches bulk Spot prices per chain', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ '0xtoken': '1' }),
    } as Response);
    const service = new OneInchSwapProviderService(config({
      ONEINCH_ENABLED: true,
      ONEINCH_API_KEY: 'test-api-key',
      ONEINCH_BASE_URL: 'https://api.1inch.com/swap/v6.1',
      ONEINCH_CHAIN_ID: 42161,
      ONEINCH_MIN_REQUEST_INTERVAL_MS: 0,
      ONEINCH_PRICE_CACHE_MS: 5_000,
    }));

    const [first, second] = await Promise.all([
      service.getSpotPrices(42161),
      service.getSpotPrices(42161),
    ]);
    const third = await service.getSpotPrices(42161);

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requests exact approval calldata rather than unlimited allowance', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        to: '0x0000000000000000000000000000000000000001',
        data: '0x095ea7b3',
        value: '0',
      }),
    } as Response);
    const service = new OneInchSwapProviderService(config({
      ONEINCH_ENABLED: true,
      ONEINCH_API_KEY: 'test-api-key',
      ONEINCH_BASE_URL: 'https://api.1inch.com/swap/v6.1',
      ONEINCH_CHAIN_ID: 42161,
    }));

    await service.buildApproval({
      tokenAddress: '0x0000000000000000000000000000000000000001',
      amount: '123456',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      href: expect.stringContaining('amount=123456'),
    }));
  });

  it('retries a rate-limited request and then returns the quote', async () => {
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: jest.fn().mockReturnValue('0') },
        json: async () => ({}),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: jest.fn().mockReturnValue(null) },
        json: async () => ({ dstAmount: '900' }),
      } as unknown as Response);
    const service = new OneInchSwapProviderService(config({
      ONEINCH_ENABLED: true,
      ONEINCH_API_KEY: 'test-api-key',
      ONEINCH_BASE_URL: 'https://api.1inch.com/swap/v6.1',
      ONEINCH_CHAIN_ID: 42161,
      ONEINCH_MIN_REQUEST_INTERVAL_MS: 0,
      ONEINCH_MAX_RETRIES: 1,
    }));

    await expect(service.quoteExactInput({
      fromTokenAddress: '0x0000000000000000000000000000000000000001',
      toTokenAddress: '0x0000000000000000000000000000000000000002',
      amount: '1000',
    })).resolves.toEqual({ dstAmount: '900' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches the spender per chain', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ address: '0x0000000000000000000000000000000000000001' }),
    } as Response);
    const service = new OneInchSwapProviderService(config({
      ONEINCH_ENABLED: true,
      ONEINCH_API_KEY: 'test-api-key',
      ONEINCH_BASE_URL: 'https://api.1inch.com/swap/v6.1',
      ONEINCH_CHAIN_ID: 42161,
      ONEINCH_MIN_REQUEST_INTERVAL_MS: 0,
    }));

    await service.getSpender(42161);
    await service.getSpender(42161);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
