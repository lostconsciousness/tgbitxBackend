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
        CONVERT_FEE_BPS: 20,
        CONVERT_EVM_GAS_RESERVE: '0.00015',
      };
      return values[key] ?? fallback;
    }),
  } as unknown as ConfigService;

  function service() {
    const oneInch = {
      quoteExactInput: jest.fn().mockResolvedValue({
        dstAmount: '1000000000000000000',
      }),
    };
    const marketData = {
      getOrderBook: jest.fn().mockResolvedValue({
        bids: [{ price: '100', size: '1', orders: 1 }],
        asks: [{ price: '101', size: '1', orders: 1 }],
        time: Date.now(),
      }),
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
    const instance = new ConvertService(
      {} as any,
      config,
      {} as any,
      marketData as any,
      oneInch as any,
      custody as any,
      rpc as any,
    );
    jest.spyOn(instance as any, 'assertReserveCoverage').mockResolvedValue(undefined);
    return { instance, oneInch, marketData };
  }

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
});
