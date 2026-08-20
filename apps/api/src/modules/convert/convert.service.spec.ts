import { ConfigService } from '@nestjs/config';
import { ConversionProvider, Prisma, TokenStandard } from '@prisma/client';
import { ConvertService } from './convert.service';

describe('ConvertService quotes', () => {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        CONVERT_SOL_ENABLED: true,
        CONVERT_TRON_ENABLED: true,
        CONVERT_EVM_ENABLED: true,
        CONVERT_ENABLED: true,
        CONVERT_FEE_BPS: 20,
        CONVERT_EVM_GAS_RESERVE: '0.00015',
        PRIVY_SPOT_LIQUIDITY_WALLET_ID: 'spot-wallet',
      };
      return values[key] ?? fallback;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'PRIVY_SPOT_LIQUIDITY_WALLET_ID') return 'spot-wallet';
      throw new Error(`Missing test config: ${key}`);
    }),
  } as unknown as ConfigService;

  function service() {
    const oneInch = {
      quoteExactInput: jest.fn().mockResolvedValue({
        dstAmount: '1000000000000000000',
      }),
      getSpotPrices: jest.fn().mockResolvedValue({}),
    };
    const marketData = {
      getOrderBook: jest.fn().mockResolvedValue({
        bids: [{ price: '100', size: '1', orders: 1 }],
        asks: [{ price: '101', size: '1', orders: 1 }],
        time: Date.now(),
      }),
      getTickers: jest.fn().mockResolvedValue([]),
    };
    const custody = {
      isSolanaEnabled: jest.fn().mockReturnValue(true),
      isTronEnabled: jest.fn().mockReturnValue(true),
      getWalletAddress: jest.fn().mockResolvedValue('0x0000000000000000000000000000000000000001'),
    };
    const rpc = {
      getChainId: jest.fn().mockResolvedValue(42161),
      getBalance: jest.fn().mockImplementation(async (_wallet, token) => ({
        value: token ? '1000000' : '1000000000000000000',
      })),
    };
    const updates = { publish: jest.fn() };
    const instance = new ConvertService(
      {} as any,
      config,
      {} as any,
      marketData as any,
      oneInch as any,
      custody as any,
      rpc as any,
      updates as any,
    );
    jest.spyOn(instance as any, 'assertReserveCoverage').mockResolvedValue(undefined);
    return { instance, oneInch, marketData, updates };
  }

  it('publishes a balance refresh after a committed conversion state change', () => {
    const { instance, updates } = service();

    (instance as any).publishBalanceUpdate('user-1');

    expect(updates.publish).toHaveBeenCalledWith('user-1', ['balances']);
  });

  it('caches conversion readiness to avoid repeated multi-network balance RPC calls', async () => {
    const { instance } = service();
    const compute = jest.spyOn(instance as any, 'computeReadiness').mockResolvedValue({
      enabled: true,
      evm: { enabled: true, networks: [] },
    });

    await instance.getReadiness();
    await instance.getReadiness();

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('returns only Spot assets that have a common executable stablecoin network', async () => {
    const { instance } = service();
    jest.spyOn(instance as any, 'getSpotCatalogFundedQuotes').mockResolvedValue(
      new Map([['arbitrum', new Set(['USDC'])]]),
    );
    jest.spyOn(instance, 'listAssets').mockResolvedValue([
      { symbol: 'BTC', name: 'Bitcoin', iconUrl: null, decimals: 8, enabled: false,
        provider: ConversionProvider.ONEINCH, networks: [], networkHidden: true, reason: 'unavailable' },
      { symbol: 'WBTC', name: 'Wrapped BTC', iconUrl: null, decimals: 8, enabled: true,
        provider: ConversionProvider.ONEINCH, networks: ['arbitrum'], networkHidden: true, reason: null },
      { symbol: 'USDC', name: 'USD Coin', iconUrl: null, decimals: 6, enabled: true,
        provider: ConversionProvider.ONEINCH, networks: ['arbitrum'], networkHidden: true, reason: null },
      { symbol: 'AVAX', name: 'Avalanche', iconUrl: null, decimals: 18, enabled: true,
        provider: ConversionProvider.ONEINCH, networks: ['avalanche'], networkHidden: true, reason: null },
    ]);
    jest.spyOn(instance as any, 'getSpotTickers').mockResolvedValue([
      { symbol: 'WBTC-USDC', price: '100', change24hPct: '0', volume24h: '1000', asOf: new Date().toISOString() },
    ]);

    const catalog = await instance.listSpotCatalog();

    expect(catalog.assets.map((asset) => asset.symbol)).toEqual(['WBTC', 'USDC']);
    expect(catalog.pairs).toEqual([
      expect.objectContaining({ symbol: 'WBTC-USDC', preferredNetwork: 'arbitrum' }),
    ]);
    expect(catalog.assets.some((asset) => asset.symbol === 'BTC')).toBe(false);
    expect(catalog.assets.some((asset) => asset.symbol === 'AVAX')).toBe(false);
  });

  it('enriches Spot prices with reference 24h statistics and sorts the catalog by notional', async () => {
    const { instance } = service();
    jest.spyOn(instance as any, 'getSpotCatalogFundedQuotes').mockResolvedValue(
      new Map([['arbitrum', new Set(['USDC'])]]),
    );
    jest.spyOn(instance, 'listAssets').mockResolvedValue([
      { symbol: 'AAVE', name: 'Aave', iconUrl: null, decimals: 18, enabled: true,
        provider: ConversionProvider.ONEINCH, networks: ['arbitrum'], networkHidden: true, reason: null },
      { symbol: 'ARB', name: 'Arbitrum', iconUrl: null, decimals: 18, enabled: true,
        provider: ConversionProvider.ONEINCH, networks: ['arbitrum'], networkHidden: true, reason: null },
      { symbol: 'USDC', name: 'USD Coin', iconUrl: null, decimals: 6, enabled: true,
        provider: ConversionProvider.ONEINCH, networks: ['arbitrum'], networkHidden: true, reason: null },
    ]);
    jest.spyOn(instance as any, 'getSpotTickers').mockResolvedValue([
      {
        symbol: 'AAVE-USDC',
        provider: 'ONEINCH_SPOT_PRICE',
        network: 'arbitrum',
        lastPrice: '100',
        markPrice: '100',
        priceChange24h: '1',
        priceChangePct24h: '1',
        volume24h: '100',
        notional24h: '10000',
        statsProvider: 'HYPERLIQUID_PERP_REFERENCE',
        time: 1,
      },
      {
        symbol: 'ARB-USDC',
        provider: 'ONEINCH_SPOT_PRICE',
        network: 'arbitrum',
        lastPrice: '1',
        markPrice: '1',
        priceChange24h: '-0.1',
        priceChangePct24h: '-10',
        volume24h: '200000',
        notional24h: '200000',
        statsProvider: 'HYPERLIQUID_PERP_REFERENCE',
        time: 1,
      },
    ]);

    const catalog = await instance.listSpotCatalog();

    expect(catalog.pairs.map((pair) => pair.symbol)).toEqual(['ARB-USDC', 'AAVE-USDC']);
    expect(catalog.assets.map((asset) => asset.symbol)).toEqual(['ARB', 'AAVE', 'USDC']);
    expect(catalog.tickers.map((ticker) => ticker.notional24h)).toEqual(['200000', '10000']);
  });

  it('keeps 1inch as the Spot price and adds Hyperliquid reference statistics', async () => {
    const network = { chainKey: 'arbitrum', mainnet: true };
    const contracts = [
      {
        standard: TokenStandard.ERC20,
        address: '0x0000000000000000000000000000000000000001',
        network,
      },
      {
        standard: TokenStandard.ERC20,
        address: '0x0000000000000000000000000000000000000002',
        network,
      },
    ];
    const prisma = {
      asset: {
        findMany: jest.fn().mockResolvedValue([
          { symbol: 'AAVE', tokenContracts: [contracts[0]] },
          { symbol: 'USDC', tokenContracts: [contracts[1]] },
        ]),
      },
    };
    const marketData = {
      getTickers: jest.fn().mockResolvedValue([{
        symbol: 'AAVE-PERP',
        priceChangePct24h: '5',
        volume24h: '1234',
        notional24h: '120000',
      }]),
    };
    const oneInch = {
      getSpotPrices: jest.fn().mockResolvedValue({
        '0x0000000000000000000000000000000000000001': '100',
        '0x0000000000000000000000000000000000000002': '1',
      }),
    };
    const instance = new ConvertService(
      prisma as any,
      config,
      {} as any,
      marketData as any,
      oneInch as any,
      {} as any,
      {} as any,
      undefined,
    );

    const tickers = await (instance as any).loadSpotTickers([{
      symbol: 'AAVE-USDC',
      baseAsset: 'AAVE',
      quoteAsset: 'USDC',
      preferredNetwork: 'arbitrum',
    }]);

    expect(tickers).toEqual([
      expect.objectContaining({
        symbol: 'AAVE-USDC',
        lastPrice: '100',
        priceChange24h: '5',
        priceChangePct24h: '5',
        volume24h: '1234',
        notional24h: '120000',
        statsProvider: 'HYPERLIQUID_PERP_REFERENCE',
      }),
    ]);
  });

  it('quotes an inventory-backed SOL buy and exposes the 20 bps fee', async () => {
    const { instance } = service();
    const quote = await (instance as any).quoteNativeReserve(
      'SOL',
      { id: 'usdt', symbol: 'USDT', decimals: 6 },
      { id: 'sol', symbol: 'SOL', decimals: 9 },
      new Prisma.Decimal('101'),
      50,
    );

    expect(quote.provider).toBe(ConversionProvider.INTERNAL_RESERVE);
    expect(quote.expectedToAmount.toString()).toBe('0.998');
    expect(quote.feeAmount.toString()).toBe('0.002');
    expect(quote.minToAmount.toString()).toBe('0.993');
  });

  it('quotes an inventory-backed TRX buy through the Tron reserve route', async () => {
    const { instance } = service();
    const quote = await (instance as any).quoteNativeReserve(
      'TRX',
      { id: 'usdt', symbol: 'USDT', decimals: 6 },
      { id: 'trx', symbol: 'TRX', decimals: 6 },
      new Prisma.Decimal('101'),
      50,
    );

    expect(quote.provider).toBe(ConversionProvider.INTERNAL_RESERVE);
    expect(quote.networkKey).toBe('tron');
  });

  it('quotes USDT/USDC against aggregate reserves without requiring EVM source inventory', async () => {
    const { instance, oneInch } = service();
    oneInch.quoteExactInput.mockResolvedValueOnce({ dstAmount: '51900000' });
    const network = { chainKey: 'arbitrum', chainId: 42161, mainnet: true };
    const contract = (address: string) => ({
      address,
      decimals: 6,
      standard: TokenStandard.ERC20,
      contractVerifiedAt: new Date(),
      network,
    });

    const quote = await (instance as any).quoteStableReserve(
      {
        id: 'usdt',
        symbol: 'USDT',
        decimals: 6,
        tokenContracts: [contract('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9')],
      },
      {
        id: 'usdc',
        symbol: 'USDC',
        decimals: 6,
        tokenContracts: [contract('0xaf88d065e77c8cc2239327c5edb3a432268e5831')],
      },
      new Prisma.Decimal('52'),
      50,
    );

    expect(quote.provider).toBe(ConversionProvider.INTERNAL_RESERVE);
    expect(quote.networkKey).toBe('arbitrum');
    expect(quote.expectedToAmount.toString()).toBe('51.7962');
    expect(oneInch.quoteExactInput).toHaveBeenCalledWith(expect.objectContaining({
      amount: '52000000',
      chainId: 42161,
    }));
  });

  it('aggregates unique active custody addresses for reserve coverage', async () => {
    const network = { chainKey: 'arbitrum', legacyChain: 'ARBITRUM', mainnet: true };
    const prisma = {
      custodyAccount: {
        findMany: jest.fn().mockResolvedValue([
          { address: '0x0000000000000000000000000000000000000001', network: 'ARBITRUM' },
          { address: '0x0000000000000000000000000000000000000002', network: 'ARBITRUM' },
          { address: '0x0000000000000000000000000000000000000002', network: 'ARBITRUM' },
        ]),
      },
    };
    const custody = {
      getWalletAddress: jest.fn().mockResolvedValue('0x0000000000000000000000000000000000000001'),
      isTronEnabled: jest.fn().mockReturnValue(false),
    };
    const rpc = {
      getBalance: jest.fn().mockImplementation(async (wallet: string) => ({
        value: wallet.endsWith('1') ? '10' : '20',
      })),
    };
    const instance = new ConvertService(
      prisma as any,
      config,
      {} as any,
      {} as any,
      {} as any,
      custody as any,
      rpc as any,
      undefined,
    );
    const total = await (instance as any).getAggregateEvmBalance({
      symbol: 'USDC',
      tokenContracts: [{
        address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
        decimals: 6,
        standard: TokenStandard.ERC20,
        contractVerifiedAt: new Date(),
        network,
      }],
    });

    expect(total.toString()).toBe('30');
    expect(rpc.getBalance).toHaveBeenCalledTimes(2);
  });

  it('uses verified Arbitrum contracts for exact-input 1inch quotes', async () => {
    const { instance, oneInch } = service();
    const network = { chainKey: 'arbitrum', chainId: 42161, mainnet: true };
    const fromAsset = {
      id: 'usdt',
      symbol: 'USDT',
      decimals: 6,
      tokenContracts: [{
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        decimals: 6,
        standard: TokenStandard.ERC20,
        contractVerifiedAt: new Date(),
        network,
      }],
    };
    const toAsset = {
      id: 'weth',
      symbol: 'WETH',
      decimals: 18,
      tokenContracts: [{
        address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        decimals: 18,
        standard: TokenStandard.ERC20,
        contractVerifiedAt: new Date(),
        network,
      }],
    };

    const quote = await (instance as any).quoteOneInch(
      fromAsset,
      toAsset,
      new Prisma.Decimal('100'),
      50,
    );

    expect(oneInch.quoteExactInput).toHaveBeenCalledWith(expect.objectContaining({
      amount: '100000000',
      chainId: 42161,
    }));
    expect(quote.expectedToAmount.toString()).toBe('0.998');
    expect(quote.feeAmount.toString()).toBe('0.002');
  });

  it('maps verified native EVM assets to the 1inch native sentinel', () => {
    const { instance } = service();
    const network = { chainKey: 'arbitrum', chainId: 42161, mainnet: true };
    const routes = (instance as any).evmRoutes(
      {
        symbol: 'ETH',
        tokenContracts: [{
          address: null,
          decimals: 18,
          standard: TokenStandard.NATIVE,
          contractVerifiedAt: new Date(),
          network,
        }],
      },
      {
        symbol: 'USDC',
        tokenContracts: [{
          address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
          decimals: 6,
          standard: TokenStandard.ERC20,
          contractVerifiedAt: new Date(),
          network,
        }],
      },
    );

    expect(routes).toEqual([expect.objectContaining({
      networkKey: 'arbitrum',
      fromNative: true,
      fromToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    })]);
  });

  it('reconciles ERC-20 output from receipt logs for the custody wallet only', () => {
    const { instance } = service();
    const wallet = '0x0000000000000000000000000000000000000001';
    const token = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
    const topic = `0x${wallet.slice(2).padStart(64, '0')}`;
    const amount = (instance as any).sumErc20TransfersToWallet([
      {
        address: token,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          `0x${'2'.padStart(64, '0')}`,
          topic,
        ],
        data: '0x0f4240',
      },
    ], token, wallet, 6);

    expect(amount.toString()).toBe('1');
  });

  it('rejects a confirmed transaction signed by a different custody wallet', () => {
    const { instance } = service();

    expect(() => (instance as any).assertEvmTransactionSender(
      { from: '0x0000000000000000000000000000000000000002' },
      '0x0000000000000000000000000000000000000001',
    )).toThrow('unexpected custody wallet');
  });

  it('accepts a confirmed transaction signed by the selected Spot wallet', () => {
    const { instance } = service();

    expect(() => (instance as any).assertEvmTransactionSender(
      { from: '0x0000000000000000000000000000000000000001' },
      '0x0000000000000000000000000000000000000001',
    )).not.toThrow();
  });
});
