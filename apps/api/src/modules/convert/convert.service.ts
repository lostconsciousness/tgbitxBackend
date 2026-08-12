import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  ConversionProvider,
  ConversionQuoteStatus,
  ConversionStatus,
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
  NetworkFamily,
  Prisma,
  TokenStandard,
} from '@prisma/client';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { PrismaService } from '../../database/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { MarketDataService } from '../market-data/market-data.service';
import { RPC_PROVIDER } from '../rpc/rpc.module';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { OneInchSwapProviderService } from '../spot/one-inch-swap-provider.service';
import { PrivyCustodyService } from '../treasury/privy-custody.service';
import { UserUpdatesService } from '../user-updates/user-updates.service';
import { CreateConversionQuoteDto } from './dto/create-conversion-quote.dto';
import { ExecuteConversionDto } from './dto/execute-conversion.dto';

const APPROVE_SELECTOR = '0x095ea7b3';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ONEINCH_EVM_NETWORKS = new Map<string, number>([
  ['arbitrum', 42161],
  ['base', 8453],
  ['optimism', 10],
  ['polygon', 137],
  ['bnb', 56],
  ['avalanche', 43114],
  ['ethereum', 1],
  ['zksync', 324],
  ['linea', 59144],
]);
const SOLANA_NETWORK = 'solana';
const TRON_NETWORK = 'tron';

type QuoteProviderData = {
  chainId?: number;
  fromToken?: string;
  toToken?: string;
  fromRawAmount?: string;
  expectedToRawAmount?: string;
  fromDecimals: number;
  toDecimals: number;
  fromNative?: boolean;
  toNative?: boolean;
  networkKey?: string;
};

type EvmRoute = {
  networkKey: string;
  chainId: number;
  fromToken: string;
  toToken: string;
  fromDecimals: number;
  toDecimals: number;
  fromNative: boolean;
  toNative: boolean;
};

type SpotTicker = {
  symbol: string;
  provider: 'ONEINCH_SPOT_PRICE';
  network: string;
  lastPrice: string;
  markPrice: string;
  priceChange24h: string | null;
  priceChangePct24h: string | null;
  volume24h: string | null;
  notional24h: string | null;
  statsProvider: 'HYPERLIQUID_PERP_REFERENCE' | null;
  time: number;
};

class PendingProviderTransactionError extends Error {}
class ManualReconciliationRequiredError extends Error {}

@Injectable()
export class ConvertService implements OnModuleInit {
  private readonly logger = new Logger(ConvertService.name);
  private workerRunning = false;
  private spotLiquidityCache?: {
    key: string;
    expiresAt: number;
    value: Map<string, Set<string>>;
  };
  private spotLiquidityRefresh?: Promise<Map<string, Set<string>>>;
  private spotTickerCache?: { expiresAt: number; value: SpotTicker[] };
  private spotTickerRefresh?: Promise<SpotTicker[]>;
  private spotCatalogCache?: {
    expiresAt: number;
    value: Awaited<ReturnType<ConvertService['buildSpotCatalog']>>;
  };
  private spotCatalogRefresh?: Promise<
    Awaited<ReturnType<ConvertService['buildSpotCatalog']>>
  >;
  private readinessCache?: {
    expiresAt: number;
    value: Awaited<ReturnType<ConvertService['computeReadiness']>>;
  };
  private readinessRefresh?: Promise<Awaited<ReturnType<ConvertService['computeReadiness']>>>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ledger: LedgerService,
    private readonly marketData: MarketDataService,
    private readonly oneInch: OneInchSwapProviderService,
    private readonly custody: PrivyCustodyService,
    @Inject(RPC_PROVIDER) private readonly rpc: RpcProvider,
    @Optional() private readonly userUpdates?: UserUpdatesService,
  ) {}

  onModuleInit(): void {
    const timer = setTimeout(() => {
      void this.refreshSpotCatalog().catch((error) => {
        this.logger.warn(`Spot catalog warmup failed: ${this.safeError(error)}`);
      });
    }, 250);
    timer.unref();
  }

  async listAssets() {
    const supportedNetworkKeys = this.evmNetworkPreference();
    const convertEnabled = this.config.get<boolean>('CONVERT_ENABLED', false);
    const assets = await this.prisma.asset.findMany({
      where: {
        OR: [
          { symbol: { in: ['SOL', 'TRX'] } },
          {
            tokenContracts: {
              some: {
                standard: { in: [TokenStandard.ERC20, TokenStandard.NATIVE] },
                contractVerifiedAt: { not: null },
                network: { chainKey: { in: supportedNetworkKeys }, mainnet: true },
              },
            },
          },
        ],
      },
      include: {
        tokenContracts: {
          where: {
            contractVerifiedAt: { not: null },
            network: { mainnet: true },
          },
          include: { network: true },
        },
      },
      orderBy: { symbol: 'asc' },
    });

    return assets.map((asset) => {
      const sol = asset.symbol === 'SOL';
      const tron = asset.symbol === 'TRX';
      const enabled = convertEnabled && (sol
        ? this.config.get<boolean>('CONVERT_SOL_ENABLED', false) && this.custody.isSolanaEnabled()
        : tron
          ? this.config.get<boolean>('CONVERT_TRON_ENABLED', false) && this.custody.isTronEnabled()
          : this.config.get<boolean>('CONVERT_EVM_ENABLED', false) &&
            this.oneInch.getStatus().enabled &&
            Boolean(this.config.get<string>('PRIVY_SPOT_LIQUIDITY_WALLET_ID')));
      const networks = asset.tokenContracts
        .map((contract) => contract.network.chainKey)
        .filter((key) => ONEINCH_EVM_NETWORKS.has(key));
      return {
        symbol: asset.symbol,
        name: asset.name,
        iconUrl: asset.iconUrl,
        decimals: asset.decimals,
        enabled,
        provider: sol || tron ? ConversionProvider.INTERNAL_RESERVE : ConversionProvider.ONEINCH,
        networks: sol ? [SOLANA_NETWORK] : tron ? [TRON_NETWORK] : [...new Set(networks)],
        networkHidden: true,
        reason: enabled
          ? null
          : sol
            ? 'Privy Solana reserve is not configured'
            : tron
              ? 'Privy Tron reserve is not configured'
              : '1inch EVM execution is not configured',
      };
    });
  }

  async listSpotCatalog(): Promise<
    Awaited<ReturnType<ConvertService['buildSpotCatalog']>>
  > {
    const cached = this.spotCatalogCache;
    if (cached) {
      if (cached.expiresAt <= Date.now()) {
        void this.refreshSpotCatalog().catch((error) => {
          this.logger.warn(`Spot catalog background refresh failed: ${this.safeError(error)}`);
        });
      }
      return cached.value;
    }
    return this.refreshSpotCatalog();
  }

  private refreshSpotCatalog(): Promise<
    Awaited<ReturnType<ConvertService['buildSpotCatalog']>>
  > {
    if (this.spotCatalogRefresh) return this.spotCatalogRefresh;
    this.spotCatalogRefresh = this.buildSpotCatalog()
      .then((value) => {
        this.spotCatalogCache = {
          value,
          expiresAt:
            Date.now() + this.config.get<number>('CONVERT_SPOT_CATALOG_CACHE_MS', 60_000),
        };
        return value;
      })
      .finally(() => {
        this.spotCatalogRefresh = undefined;
      });
    return this.spotCatalogRefresh;
  }

  private async buildSpotCatalog() {
    const configuredAssets = await this.listAssets();
    const preference = this.spotCatalogNetworkPreference();
    const fundedQuotes = await this.getSpotCatalogFundedQuotes(preference);
    const quoteSymbols = ['USDC', 'USDT'];
    const executableAssets = configuredAssets.filter(
      (asset) => asset.enabled && asset.provider === ConversionProvider.ONEINCH,
    );
    const quoteAssets = new Map(
      executableAssets
        .filter((asset) => quoteSymbols.includes(asset.symbol))
        .map((asset) => [asset.symbol, asset]),
    );
    const pairs: Array<{
      pairKey: string;
      symbol: string;
      baseAsset: string;
      quoteAsset: string;
      provider: ConversionProvider;
      execution: 'CONVERT';
      preferredNetwork: string;
      networks: string[];
    }> = [];

    for (const base of executableAssets) {
      if (quoteSymbols.includes(base.symbol)) continue;
      for (const quoteSymbol of quoteSymbols) {
        const quote = quoteAssets.get(quoteSymbol);
        if (!quote) continue;
        const networks = preference.filter(
          (network) =>
            base.networks.includes(network) &&
            quote.networks.includes(network) &&
            fundedQuotes.get(network)?.has(quote.symbol),
        );
        if (networks.length === 0) continue;
        pairs.push({
          pairKey: `convert:${base.symbol}-${quote.symbol}`,
          symbol: `${base.symbol}-${quote.symbol}`,
          baseAsset: base.symbol,
          quoteAsset: quote.symbol,
          provider: ConversionProvider.ONEINCH,
          execution: 'CONVERT',
          preferredNetwork: networks[0]!,
          networks,
        });
      }
    }

    const usdc = quoteAssets.get('USDC');
    const usdt = quoteAssets.get('USDT');
    if (usdc && usdt) {
      const networks = preference.filter(
        (network) =>
          usdc.networks.includes(network) &&
          usdt.networks.includes(network) &&
          (fundedQuotes.get(network)?.has('USDC') || fundedQuotes.get(network)?.has('USDT')),
      );
      if (networks.length > 0) {
        pairs.push({
          pairKey: 'convert:USDT-USDC',
          symbol: 'USDT-USDC',
          baseAsset: 'USDT',
          quoteAsset: 'USDC',
          provider: ConversionProvider.ONEINCH,
          execution: 'CONVERT',
          preferredNetwork: networks[0]!,
          networks,
        });
      }
    }

    const tickers = await this.getSpotTickers(pairs).catch((error) => {
      this.logger.warn(`Spot ticker refresh failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return this.spotTickerCache?.value ?? [];
    });
    const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
    const executablePairs = pairs
      .filter((pair) => tickerBySymbol.has(pair.symbol))
      .map((pair) => ({ ...pair, ticker: tickerBySymbol.get(pair.symbol)! }))
      .sort((left, right) => {
        const volumeOrder = this.spotNotional(right.ticker.notional24h)
          .comparedTo(this.spotNotional(left.ticker.notional24h));
        return volumeOrder || left.symbol.localeCompare(right.symbol);
      });
    const tradableSymbols = new Set(
      executablePairs.flatMap((pair) => [pair.baseAsset, pair.quoteAsset]),
    );
    const tradableNetworks = new Map<string, Set<string>>();
    for (const pair of executablePairs) {
      for (const symbol of [pair.baseAsset, pair.quoteAsset]) {
        const networks = tradableNetworks.get(symbol) ?? new Set<string>();
        pair.networks.forEach((network) => networks.add(network));
        tradableNetworks.set(symbol, networks);
      }
    }
    const assetRank = new Map<string, number>();
    executablePairs.forEach((pair, index) => {
      if (!assetRank.has(pair.baseAsset)) assetRank.set(pair.baseAsset, index);
    });
    const rankedAssets = executableAssets
      .filter((asset) => tradableSymbols.has(asset.symbol))
      .sort((left, right) => {
        const leftRank = assetRank.get(left.symbol) ?? Number.MAX_SAFE_INTEGER;
        const rightRank = assetRank.get(right.symbol) ?? Number.MAX_SAFE_INTEGER;
        return leftRank - rightRank || left.symbol.localeCompare(right.symbol);
      });

    return {
      execution: 'CONVERT' as const,
      provider: ConversionProvider.ONEINCH,
      catalogVersion: 'spot-liquidity-v3',
      asOf: Date.now(),
      assets: rankedAssets
        .map(({ enabled: _enabled, reason: _reason, networkHidden: _hidden, ...asset }) => ({
          ...asset,
          networks: asset.networks.filter((network) => tradableNetworks.get(asset.symbol)?.has(network)),
          tradable: true,
        })),
      pairs: executablePairs,
      tickers: executablePairs.map((pair) => pair.ticker),
    };
  }

  async listSpotTickers() {
    const catalog = await this.listSpotCatalog();
    return { provider: 'ONEINCH_SPOT_PRICE' as const, tickers: catalog.tickers };
  }

  private async getSpotTickers(pairs: Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    preferredNetwork: string;
  }>): Promise<SpotTicker[]> {
    const cached = this.spotTickerCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (this.spotTickerRefresh) return this.spotTickerRefresh;
    this.spotTickerRefresh = this.loadSpotTickers(pairs)
      .then((value) => {
        this.spotTickerCache = {
          value,
          expiresAt: Date.now() + this.config.get<number>('CONVERT_SPOT_TICKER_CACHE_MS', 15_000),
        };
        return value;
      })
      .finally(() => {
        this.spotTickerRefresh = undefined;
      });
    return this.spotTickerRefresh;
  }

  private async loadSpotTickers(pairs: Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    preferredNetwork: string;
  }>): Promise<SpotTicker[]> {
    if (pairs.length === 0) return [];
    const symbols = [...new Set(pairs.flatMap((pair) => [pair.baseAsset, pair.quoteAsset]))];
    const assets = await this.prisma.asset.findMany({
      where: { symbol: { in: symbols } },
      include: {
        tokenContracts: {
          where: { contractVerifiedAt: { not: null }, network: { mainnet: true } },
          include: { network: true },
        },
      },
    });
    const assetBySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
    const referenceTickers = await this.marketData.getTickers().catch((error) => {
      this.logger.warn(
        `Spot reference statistics unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return [];
    });
    const referenceByBase = new Map(
      referenceTickers.flatMap((ticker) => {
        const symbol = String(ticker.symbol ?? '').toUpperCase();
        if (!symbol.endsWith('-PERP')) return [];
        return [[symbol.slice(0, -'-PERP'.length), ticker] as const];
      }),
    );
    const networkKeys = [...new Set(pairs.map((pair) => pair.preferredNetwork))];
    const pricesByNetwork = new Map<string, Record<string, string>>();
    for (const networkKey of networkKeys) {
      const chainId = ONEINCH_EVM_NETWORKS.get(networkKey);
      if (!chainId) continue;
      try {
        const prices = await this.oneInch.getSpotPrices(chainId);
        pricesByNetwork.set(
          networkKey,
          Object.fromEntries(Object.entries(prices).map(([address, price]) => [address.toLowerCase(), price])),
        );
      } catch (error) {
        this.logger.warn(`1inch Spot prices unavailable on ${networkKey}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }

    const time = Date.now();
    const tickers: SpotTicker[] = [];
    for (const pair of pairs) {
      const prices = pricesByNetwork.get(pair.preferredNetwork);
      const base = assetBySymbol.get(pair.baseAsset);
      const quote = assetBySymbol.get(pair.quoteAsset);
      if (!prices || !base || !quote) continue;
      const baseContract = base.tokenContracts.find((item) => item.network.chainKey === pair.preferredNetwork);
      const quoteContract = quote.tokenContracts.find((item) => item.network.chainKey === pair.preferredNetwork);
      if (!baseContract || !quoteContract) continue;
      const baseAddress = (baseContract.standard === TokenStandard.NATIVE
        ? NATIVE_TOKEN_ADDRESS
        : baseContract.address ?? '').toLowerCase();
      const quoteAddress = (quoteContract.standard === TokenStandard.NATIVE
        ? NATIVE_TOKEN_ADDRESS
        : quoteContract.address ?? '').toLowerCase();
      const basePrice = prices[baseAddress];
      const quotePrice = prices[quoteAddress];
      if (!basePrice || !quotePrice || new Prisma.Decimal(quotePrice).isZero()) continue;
      const price = new Prisma.Decimal(basePrice).div(quotePrice);
      if (!price.isPositive()) continue;
      const lastPrice = this.formatSpotTickerPrice(price);
      const referenceSymbol =
        pair.baseAsset === 'WBTC' ? 'BTC' :
        pair.baseAsset === 'WETH' ? 'ETH' :
        pair.baseAsset;
      const reference = referenceByBase.get(referenceSymbol);
      const priceChangePct24h = this.optionalDecimalString(reference?.priceChangePct24h);
      const volume24h = this.optionalNonNegativeDecimalString(reference?.volume24h);
      const notional24h = this.optionalNonNegativeDecimalString(reference?.notional24h);
      const priceChange24h = priceChangePct24h === null
        ? null
        : price.mul(priceChangePct24h).div(100).toDecimalPlaces(10).toString();
      tickers.push({
        symbol: pair.symbol,
        provider: 'ONEINCH_SPOT_PRICE',
        network: pair.preferredNetwork,
        lastPrice,
        markPrice: lastPrice,
        priceChange24h,
        priceChangePct24h,
        volume24h,
        notional24h,
        statsProvider: reference ? 'HYPERLIQUID_PERP_REFERENCE' : null,
        time,
      });
    }
    return tickers;
  }

  private optionalDecimalString(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    try {
      const parsed = new Prisma.Decimal(String(value));
      return parsed.isFinite() ? parsed.toString() : null;
    } catch (_error) {
      return null;
    }
  }

  private optionalNonNegativeDecimalString(value: unknown): string | null {
    const parsed = this.optionalDecimalString(value);
    return parsed !== null && new Prisma.Decimal(parsed).greaterThanOrEqualTo(0) ? parsed : null;
  }

  private spotNotional(value: string | null): Prisma.Decimal {
    const parsed = this.optionalNonNegativeDecimalString(value);
    return new Prisma.Decimal(parsed ?? 0);
  }

  private formatSpotTickerPrice(price: Prisma.Decimal): string {
    if (price.greaterThanOrEqualTo(1000)) return price.toDecimalPlaces(2).toString();
    if (price.greaterThanOrEqualTo(1)) return price.toDecimalPlaces(6).toString();
    return price.toDecimalPlaces(10).toString();
  }

  async getReadiness() {
    const now = Date.now();
    if (this.readinessCache && this.readinessCache.expiresAt > now) {
      return this.readinessCache.value;
    }
    if (this.readinessRefresh) return this.readinessRefresh;

    this.readinessRefresh = this.computeReadiness()
      .then((value) => {
        this.readinessCache = {
          value,
          expiresAt:
            Date.now() + this.config.get<number>('CONVERT_READINESS_CACHE_MS', 120_000),
        };
        return value;
      })
      .finally(() => {
        this.readinessRefresh = undefined;
      });
    return this.readinessRefresh;
  }

  private async computeReadiness() {
    const enabledEvmNetworks = this.evmNetworkPreference();
    const networks = await this.prisma.network.findMany({
      where: {
        mainnet: true,
        family: NetworkFamily.EVM,
        chainKey: { in: enabledEvmNetworks },
      },
      include: {
        _count: {
          select: {
            tokenContracts: {
              where: {
                standard: { in: [TokenStandard.ERC20, TokenStandard.NATIVE] },
                contractVerifiedAt: { not: null },
              },
            },
          },
        },
      },
      orderBy: { chainKey: 'asc' },
    });
    const [evmChecks, solanaCheck, tronCheck] = await Promise.all([
      Promise.all(networks.map(async (network) => ({
        network: network.chainKey,
        verifiedAssets: network._count.tokenContracts,
        ...(await this.checkEvmReadiness(network.chainKey, network.chainId ?? 0)),
      }))),
      this.checkSolanaReadiness(),
      this.checkTronReadiness(),
    ]);
    return {
      enabled: this.config.get<boolean>('CONVERT_ENABLED', false),
      feeBps: this.config.get<number>('CONVERT_FEE_BPS', 20),
      maxSlippageBps: this.config.get<number>('CONVERT_MAX_SLIPPAGE_BPS', 100),
      evm: {
        enabled: this.config.get<boolean>('CONVERT_EVM_ENABLED', false),
        networks: evmChecks,
      },
      solana: {
        enabled: this.config.get<boolean>('CONVERT_SOL_ENABLED', false),
        network: SOLANA_NETWORK,
        ...solanaCheck,
      },
      tron: {
        enabled: this.config.get<boolean>('CONVERT_TRON_ENABLED', false),
        network: TRON_NETWORK,
        ...tronCheck,
      },
    };
  }

  async createQuote(userId: string, dto: CreateConversionQuoteDto) {
    this.assertConvertEnabled();
    if (dto.fromAsset === dto.toAsset) {
      throw new BadRequestException('Conversion assets must differ');
    }
    const amount = new Prisma.Decimal(dto.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Conversion amount must be positive');
    }
    const maxSlippage = this.config.get<number>('CONVERT_MAX_SLIPPAGE_BPS', 100);
    const slippageBps = dto.slippageBps ?? this.config.get<number>('CONVERT_DEFAULT_SLIPPAGE_BPS', 50);
    if (slippageBps > maxSlippage) {
      throw new BadRequestException(`Maximum conversion slippage is ${maxSlippage} bps`);
    }

    const [fromAsset, toAsset] = await Promise.all([
      this.loadAsset(dto.fromAsset),
      this.loadAsset(dto.toAsset),
    ]);
    const reserveSymbol = ['SOL', 'TRX'].find((symbol) =>
      fromAsset.symbol === symbol || toAsset.symbol === symbol,
    );
    const quote = reserveSymbol
      ? await this.quoteNativeReserve(reserveSymbol, fromAsset, toAsset, amount, slippageBps)
      : await this.quoteOneInch(fromAsset, toAsset, amount, slippageBps);

    await this.assertOrderLimits(userId, fromAsset, toAsset, amount, quote.expectedToAmount);
    const ttlSeconds = this.config.get<number>('CONVERT_QUOTE_TTL_SECONDS', 20);
    const created = await this.prisma.conversionQuote.create({
      data: {
        userId,
        fromAssetId: fromAsset.id,
        toAssetId: toAsset.id,
        provider: quote.provider,
        networkKey: quote.networkKey,
        fromAmount: amount,
        expectedToAmount: quote.expectedToAmount,
        minToAmount: quote.minToAmount,
        feeAmount: quote.feeAmount,
        slippageBps,
        expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
        providerData: quote.providerData as Prisma.InputJsonValue,
      },
      include: { fromAsset: true, toAsset: true },
    });
    return this.presentQuote(created);
  }

  async execute(userId: string, dto: ExecuteConversionDto) {
    this.assertConvertEnabled();
    const existing = await this.prisma.conversion.findUnique({
      where: { userId_clientConversionId: { userId, clientConversionId: dto.clientConversionId } },
      include: { fromAsset: true, toAsset: true },
    });
    if (existing) {
      return this.presentConversion(existing);
    }

    const conversion = await this.prisma.$transaction(async (tx) => {
      const quote = await tx.conversionQuote.findFirst({
        where: { id: dto.quoteId, userId },
        include: { fromAsset: true, toAsset: true },
      });
      if (!quote) {
        throw new NotFoundException('Conversion quote not found');
      }
      if (quote.status !== ConversionQuoteStatus.ACTIVE || quote.expiresAt <= new Date()) {
        if (quote.status === ConversionQuoteStatus.ACTIVE) {
          await tx.conversionQuote.update({ where: { id: quote.id }, data: { status: ConversionQuoteStatus.EXPIRED } });
        }
        throw new BadRequestException('Conversion quote has expired');
      }
      await this.ledger.assertSufficientUserSpotBalance({
        userId,
        assetId: quote.fromAssetId,
        amount: quote.fromAmount,
        mainnetOnly: true,
      }, tx);
      if (quote.provider === ConversionProvider.INTERNAL_RESERVE) {
        await this.assertReserveCoverage(quote.toAsset, new Prisma.Decimal(quote.expectedToAmount));
      } else {
        await this.assertEvmSourceInventory(quote);
      }
      const created = await tx.conversion.create({
        data: {
          userId,
          quoteId: quote.id,
          clientConversionId: dto.clientConversionId,
          fromAssetId: quote.fromAssetId,
          toAssetId: quote.toAssetId,
          provider: quote.provider,
          networkKey: quote.networkKey,
          fromAmount: quote.fromAmount,
          expectedToAmount: quote.expectedToAmount,
          minToAmount: quote.minToAmount,
          feeAmount: quote.feeAmount,
        },
        include: { fromAsset: true, toAsset: true },
      });
      await this.ledger.postTransaction({
        type: LedgerTransactionType.CONVERT_RESERVE,
        idempotencyKey: `convert-reserve:${created.id}`,
        referenceType: 'Conversion',
        referenceId: created.id,
        description: 'Reserve exact-input conversion funds',
        entries: [
          {
            accountType: LedgerAccountType.USER_SPOT,
            userId,
            assetId: quote.fromAssetId,
            direction: LedgerEntryDirection.DEBIT,
            amount: quote.fromAmount,
          },
          {
            accountType: LedgerAccountType.PROVIDER_CLEARING,
            assetId: quote.fromAssetId,
            direction: LedgerEntryDirection.CREDIT,
            amount: quote.fromAmount,
          },
        ],
      }, tx);
      await tx.conversionQuote.update({
        where: { id: quote.id },
        data: { status: ConversionQuoteStatus.CONSUMED, consumedAt: new Date() },
      });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    this.publishBalanceUpdate(conversion.userId);
    return this.presentConversion(conversion);
  }

  async list(userId: string) {
    const conversions = await this.prisma.conversion.findMany({
      where: { userId },
      include: { fromAsset: true, toAsset: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return conversions.map((conversion) => this.presentConversion(conversion));
  }

  async get(userId: string, id: string) {
    const conversion = await this.prisma.conversion.findFirst({
      where: { id, userId },
      include: { fromAsset: true, toAsset: true },
    });
    if (!conversion) {
      throw new NotFoundException('Conversion not found');
    }
    return this.presentConversion(conversion);
  }

  @Interval(2_000)
  async runWorker(): Promise<void> {
    if (this.workerRunning || !this.config.get<boolean>('CONVERT_ENABLED', false)) {
      return;
    }
    this.workerRunning = true;
    try {
      const pending = await this.prisma.conversion.findFirst({
        where: { status: ConversionStatus.PENDING },
        orderBy: { createdAt: 'asc' },
      });
      if (!pending) {
        return;
      }
      const claimed = await this.prisma.conversion.updateMany({
        where: { id: pending.id, status: ConversionStatus.PENDING },
        data: { status: ConversionStatus.EXECUTING, attempts: { increment: 1 }, failureReason: null },
      });
      if (claimed.count !== 1) {
        return;
      }
      await this.processConversion(pending.id);
    } catch (error) {
      this.logger.error(`Conversion worker failed: ${this.safeError(error)}`);
    } finally {
      this.workerRunning = false;
    }
  }

  private async processConversion(id: string): Promise<void> {
    try {
      const conversion = await this.prisma.conversion.findUniqueOrThrow({
        where: { id },
        include: { quote: true, fromAsset: true, toAsset: true },
      });
      if (conversion.provider === ConversionProvider.INTERNAL_RESERVE) {
        await this.assertReserveCoverage(conversion.toAsset, new Prisma.Decimal(conversion.expectedToAmount));
        await this.settleConversion(conversion.id, new Prisma.Decimal(conversion.expectedToAmount));
        return;
      }
      await this.executeOneInch(conversion);
    } catch (error) {
      if (error instanceof PendingProviderTransactionError) {
        await this.prisma.conversion.update({
          where: { id },
          data: { status: ConversionStatus.PENDING, failureReason: error.message },
        });
        return;
      }
      const release = !(error instanceof ManualReconciliationRequiredError);
      await this.failConversion(id, this.safeError(error), release);
    }
  }

  private async executeOneInch(conversion: any): Promise<void> {
    const data = conversion.quote.providerData as QuoteProviderData;
    if (!data.fromToken || !data.toToken || !data.fromRawAmount || !data.chainId) {
      throw new Error('Stored 1inch quote metadata is incomplete');
    }
    if (
      !data.networkKey ||
      conversion.networkKey !== data.networkKey ||
      ONEINCH_EVM_NETWORKS.get(data.networkKey) !== data.chainId
    ) {
      throw new ServiceUnavailableException('Stored 1inch network metadata is invalid');
    }
    const spotWalletId = this.spotLiquidityWalletId();
    const walletAddress = await this.custody.getWalletAddress(spotWalletId);
    if (conversion.txHash) {
      const receipt = await this.waitForEvmTransaction(conversion.txHash, conversion.networkKey);
      this.assertEvmTransactionSender(receipt, walletAddress);
      await this.finalizeEvmOutput(conversion, walletAddress, data, receipt);
      return;
    }

    await this.assertEvmSourceInventory(conversion.quote);
    const spender = getAddress(await this.oneInch.getSpender(data.chainId));
    if (!data.fromNative) {
      const allowance = await this.oneInch.getAllowance({
        tokenAddress: data.fromToken,
        walletAddress,
        chainId: data.chainId,
      });
      if (allowance < BigInt(data.fromRawAmount)) {
        const approval = await this.oneInch.buildApproval({
          tokenAddress: data.fromToken,
          amount: data.fromRawAmount,
          chainId: data.chainId,
        });
        if (getAddress(approval.to) !== getAddress(data.fromToken) || !approval.data.startsWith(APPROVE_SELECTOR)) {
          throw new ServiceUnavailableException('1inch approval target or calldata is invalid');
        }
        const sent = await this.custody.sendEvmTransaction({
          recipient: getAddress(approval.to),
          value: BigInt(approval.value || '0'),
          data: approval.data,
          referenceId: `convert-approve:${conversion.id}`,
          chainId: data.chainId,
          walletId: spotWalletId,
        });
        await this.prisma.conversion.update({
          where: { id: conversion.id },
          data: { approvalTxHash: sent.txHash },
        });
        const approvalReceipt = await this.waitForEvmTransaction(sent.txHash, conversion.networkKey);
        this.assertEvmTransactionSender(approvalReceipt, walletAddress);
      }
    }

    const before = await this.getEvmBalance(
      walletAddress,
      data.toNative ? undefined : data.toToken,
      conversion.networkKey,
      data.toDecimals,
    );
    const swap = await this.oneInch.buildSwapTransaction({
      fromTokenAddress: data.fromToken,
      toTokenAddress: data.toToken,
      amount: data.fromRawAmount,
      walletAddress,
      slippageBps: conversion.quote.slippageBps,
      chainId: data.chainId,
    });
    if (getAddress(swap.tx.to) !== spender || !swap.tx.data.startsWith('0x')) {
      throw new ServiceUnavailableException('1inch swap target or calldata is invalid');
    }
    const sent = await this.custody.sendEvmTransaction({
      recipient: spender,
      value: BigInt(swap.tx.value || '0'),
      data: swap.tx.data,
      referenceId: `convert-swap:${conversion.id}`,
      chainId: data.chainId,
      walletId: spotWalletId,
    });
    await this.prisma.conversion.update({
      where: { id: conversion.id },
      data: {
        txHash: sent.txHash,
        providerRequestId: sent.providerRequestId,
        executionData: { destinationBalanceBefore: before.toString() },
      },
    });
    const receipt = await this.waitForEvmTransaction(sent.txHash, conversion.networkKey);
    this.assertEvmTransactionSender(receipt, walletAddress);
    await this.finalizeEvmOutput({
      ...conversion,
      txHash: sent.txHash,
      executionData: { destinationBalanceBefore: before.toString() },
    }, walletAddress, data, receipt);
  }

  private async finalizeEvmOutput(
    conversion: any,
    walletAddress: string,
    data: QuoteProviderData,
    receipt: {
      gasUsed?: bigint;
      effectiveGasPrice?: bigint;
      logs?: Array<{ address: string; data: string; topics: string[] }>;
    },
  ) {
    const balanceBefore = new Prisma.Decimal(
      (conversion.executionData as { destinationBalanceBefore?: string } | null)?.destinationBalanceBefore ?? '0',
    );
    const balanceAfter = await this.getEvmBalance(
      walletAddress,
      data.toNative ? undefined : data.toToken,
      conversion.networkKey,
      data.toDecimals,
    );
    const gasSpent = data.toNative && receipt.gasUsed && receipt.effectiveGasPrice
      ? new Prisma.Decimal(formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18))
      : new Prisma.Decimal(0);
    const gross = data.toNative
      ? balanceAfter.minus(balanceBefore).plus(gasSpent)
      : this.sumErc20TransfersToWallet(
          receipt.logs,
          data.toToken!,
          walletAddress,
          data.toDecimals,
        );
    if (gross.lessThanOrEqualTo(0)) {
      throw new ManualReconciliationRequiredError('Confirmed swap output could not be reconciled');
    }
    const fee = gross.mul(this.config.get<number>('CONVERT_FEE_BPS', 20)).div(10_000);
    const net = gross.minus(fee);
    if (net.lessThan(conversion.minToAmount)) {
      throw new ManualReconciliationRequiredError('Confirmed swap output is below quoted minimum');
    }
    await this.settleConversion(conversion.id, net, fee);
  }

  private async settleConversion(id: string, netAmount: Prisma.Decimal, feeOverride?: Prisma.Decimal) {
    const userId = await this.prisma.$transaction(async (tx) => {
      const conversion = await tx.conversion.findUniqueOrThrow({ where: { id } });
      if (conversion.status === ConversionStatus.FILLED) {
        return conversion.userId;
      }
      const fee = feeOverride ?? new Prisma.Decimal(conversion.feeAmount);
      const gross = netAmount.plus(fee);
      await this.ledger.postTransaction({
        type: LedgerTransactionType.CONVERT_TRADE,
        idempotencyKey: `convert-trade:${id}`,
        referenceType: 'Conversion',
        referenceId: id,
        description: 'Settle confirmed conversion output',
        entries: [
          {
            accountType: LedgerAccountType.PROVIDER_CLEARING,
            assetId: conversion.toAssetId,
            direction: LedgerEntryDirection.DEBIT,
            amount: gross,
          },
          {
            accountType: LedgerAccountType.USER_SPOT,
            userId: conversion.userId,
            assetId: conversion.toAssetId,
            direction: LedgerEntryDirection.CREDIT,
            amount: netAmount,
          },
          ...(fee.greaterThan(0) ? [{
            accountType: LedgerAccountType.PLATFORM_FEES,
            assetId: conversion.toAssetId,
            direction: LedgerEntryDirection.CREDIT,
            amount: fee,
          }] : []),
        ],
      }, tx);
      await tx.conversion.update({
        where: { id },
        data: {
          status: ConversionStatus.FILLED,
          actualToAmount: netAmount,
          feeAmount: fee,
          completedAt: new Date(),
          failureReason: null,
        },
      });
      return conversion.userId;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.publishBalanceUpdate(userId);
  }

  private async failConversion(id: string, reason: string, release: boolean) {
    const userId = await this.prisma.$transaction(async (tx) => {
      const conversion = await tx.conversion.findUnique({ where: { id } });
      if (
        !conversion ||
        conversion.status === ConversionStatus.FILLED ||
        conversion.status === ConversionStatus.CANCELLED
      ) {
        return conversion?.userId ?? null;
      }
      if (release) {
        await this.ledger.postTransaction({
          type: LedgerTransactionType.CONVERT_RELEASE,
          idempotencyKey: `convert-release:${id}`,
          referenceType: 'Conversion',
          referenceId: id,
          description: 'Release failed conversion reserve',
          entries: [
            {
              accountType: LedgerAccountType.PROVIDER_CLEARING,
              assetId: conversion.fromAssetId,
              direction: LedgerEntryDirection.DEBIT,
              amount: conversion.fromAmount,
            },
            {
              accountType: LedgerAccountType.USER_SPOT,
              userId: conversion.userId,
              assetId: conversion.fromAssetId,
              direction: LedgerEntryDirection.CREDIT,
              amount: conversion.fromAmount,
            },
          ],
        }, tx);
      }
      await tx.conversion.update({
        where: { id },
        data: { status: ConversionStatus.FAILED, failureReason: reason, completedAt: new Date() },
      });
      return conversion.userId;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (userId) this.publishBalanceUpdate(userId);
  }

  private publishBalanceUpdate(userId: string): void {
    this.userUpdates?.publish(userId, ['balances']);
  }

  private async quoteNativeReserve(
    nativeSymbol: string,
    fromAsset: any,
    toAsset: any,
    amount: Prisma.Decimal,
    slippageBps: number,
  ) {
    const isSolana = nativeSymbol === 'SOL';
    const enabled = isSolana
      ? this.config.get<boolean>('CONVERT_SOL_ENABLED', false) && this.custody.isSolanaEnabled()
      : this.config.get<boolean>('CONVERT_TRON_ENABLED', false) && this.custody.isTronEnabled();
    if (!enabled) {
      throw new ServiceUnavailableException(`${nativeSymbol} reserve conversion is not configured`);
    }
    const other = fromAsset.symbol === nativeSymbol ? toAsset : fromAsset;
    if (!['USDC', 'USDT'].includes(other.symbol)) {
      throw new BadRequestException(`${nativeSymbol} reserve conversions require USDC or USDT`);
    }
    const book = await this.marketData.getOrderBook(`${nativeSymbol}-PERP`);
    const bestBid = book.bids[0]?.price;
    const bestAsk = book.asks[0]?.price;
    if (!bestBid || !bestAsk || Date.now() - book.time > 5_000) {
      throw new ServiceUnavailableException('SOL price is unavailable or stale');
    }
    const gross = fromAsset.symbol === nativeSymbol
      ? amount.mul(bestBid)
      : amount.div(bestAsk);
    const fee = gross.mul(this.config.get<number>('CONVERT_FEE_BPS', 20)).div(10_000);
    const expected = gross.minus(fee);
    const min = gross.mul(new Prisma.Decimal(10_000 - slippageBps)).div(10_000).minus(fee);
    await this.assertReserveCoverage(toAsset, gross);
    return {
      provider: ConversionProvider.INTERNAL_RESERVE,
      networkKey: isSolana ? SOLANA_NETWORK : TRON_NETWORK,
      expectedToAmount: expected,
      minToAmount: min,
      feeAmount: fee,
      providerData: {
        fromDecimals: fromAsset.decimals,
        toDecimals: toAsset.decimals,
        referencePrice: fromAsset.symbol === nativeSymbol ? bestBid : bestAsk,
        priceTime: book.time,
      },
    };
  }

  private async quoteOneInch(fromAsset: any, toAsset: any, amount: Prisma.Decimal, slippageBps: number) {
    if (!this.config.get<boolean>('CONVERT_EVM_ENABLED', false)) {
      throw new ServiceUnavailableException('EVM conversion is disabled');
    }
    const routes = this.evmRoutes(fromAsset, toAsset);
    if (routes.length === 0) {
      throw new BadRequestException(
        `${fromAsset.symbol}/${toAsset.symbol} has no common verified 1inch network`,
      );
    }

    const wallet = await this.custody.getWalletAddress(this.spotLiquidityWalletId());
    const failures: string[] = [];
    for (const route of routes) {
      const fromRaw = parseUnits(amount.toFixed(route.fromDecimals), route.fromDecimals);
      try {
        await this.assertEvmRouteInventory(route, wallet, amount);
        const response = await this.oneInch.quoteExactInput({
          fromTokenAddress: route.fromToken,
          toTokenAddress: route.toToken,
          amount: fromRaw.toString(),
          chainId: route.chainId,
        });
        const gross = new Prisma.Decimal(formatUnits(BigInt(response.dstAmount), route.toDecimals));
        const fee = gross.mul(this.config.get<number>('CONVERT_FEE_BPS', 20)).div(10_000);
        const expected = gross.minus(fee);
        const min = gross.mul(new Prisma.Decimal(10_000 - slippageBps)).div(10_000).minus(fee);
        return {
          provider: ConversionProvider.ONEINCH,
          networkKey: route.networkKey,
          expectedToAmount: expected,
          minToAmount: min,
          feeAmount: fee,
          providerData: {
            chainId: route.chainId,
            networkKey: route.networkKey,
            fromToken: route.fromToken,
            toToken: route.toToken,
            fromRawAmount: fromRaw.toString(),
            expectedToRawAmount: response.dstAmount,
            fromDecimals: route.fromDecimals,
            toDecimals: route.toDecimals,
            fromNative: route.fromNative,
            toNative: route.toNative,
          },
        };
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() === 429) {
          throw error;
        }
        failures.push(`${route.networkKey}: ${this.safeError(error)}`);
      }
    }
    this.logger.warn(`No funded EVM conversion route: ${failures.join('; ').slice(0, 1_000)}`);
    throw new ServiceUnavailableException({
      code: 'CONVERT_EVM_ROUTE_UNFUNDED',
      message: 'No funded EVM conversion route is currently available',
      routes: failures.map((failure) => {
        const separator = failure.indexOf(':');
        return separator > 0
          ? { network: failure.slice(0, separator), reason: failure.slice(separator + 1).trim() }
          : { network: 'unknown', reason: failure };
      }),
    });
  }

  private evmRoutes(fromAsset: any, toAsset: any): EvmRoute[] {
    const preference = this.evmNetworkPreference();
    const toByNetwork = new Map(
      toAsset.tokenContracts
        .filter((item: any) => this.isVerifiedEvmContract(item))
        .map((item: any) => [item.network.chainKey, item]),
    );
    const routes: EvmRoute[] = fromAsset.tokenContracts
      .filter((item: any) => this.isVerifiedEvmContract(item))
      .flatMap((from: any) => {
        const to = toByNetwork.get(from.network.chainKey) as any;
        if (!to || from.standard === TokenStandard.NATIVE && to.standard === TokenStandard.NATIVE) {
          return [];
        }
        const chainId = ONEINCH_EVM_NETWORKS.get(from.network.chainKey);
        if (!chainId || from.network.chainId !== chainId || to.network.chainId !== chainId) {
          return [];
        }
        return [{
          networkKey: from.network.chainKey,
          chainId,
          fromToken: from.standard === TokenStandard.NATIVE
            ? NATIVE_TOKEN_ADDRESS
            : getAddress(from.address),
          toToken: to.standard === TokenStandard.NATIVE
            ? NATIVE_TOKEN_ADDRESS
            : getAddress(to.address),
          fromDecimals: from.decimals,
          toDecimals: to.decimals,
          fromNative: from.standard === TokenStandard.NATIVE,
          toNative: to.standard === TokenStandard.NATIVE,
        }];
      });
    return routes.sort((left: EvmRoute, right: EvmRoute) =>
      preference.indexOf(left.networkKey) - preference.indexOf(right.networkKey),
    );
  }

  private isVerifiedEvmContract(item: any): boolean {
    return Boolean(
      item.network?.mainnet &&
      this.evmNetworkPreference().includes(item.network.chainKey) &&
      item.contractVerifiedAt &&
      (item.standard === TokenStandard.NATIVE ||
        (item.standard === TokenStandard.ERC20 && item.address)),
    );
  }

  private spotLiquidityWalletId(): string {
    return this.config.getOrThrow<string>('PRIVY_SPOT_LIQUIDITY_WALLET_ID');
  }

  private spotGasReserve(networkKey: string): Prisma.Decimal {
    const defaults: Record<string, string> = {
      ethereum: '0.02',
      bnb: '0.02',
      arbitrum: '0.005',
      base: '0.005',
      optimism: '0.005',
    };
    return new Prisma.Decimal(
      this.config.get<string>(
        `CONVERT_SPOT_GAS_RESERVE_${networkKey.toUpperCase()}`,
        defaults[networkKey] ?? '0.005',
      ),
    );
  }

  private evmNetworkPreference(): string[] {
    const configured = this.config.get<string>(
      'CONVERT_EVM_NETWORKS',
      [...ONEINCH_EVM_NETWORKS.keys()].join(','),
    ) ?? '';
    const selected = configured
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => ONEINCH_EVM_NETWORKS.has(value));
    return [...new Set(selected)];
  }

  private spotCatalogNetworkPreference(): string[] {
    const executable = new Set(this.evmNetworkPreference());
    const configured = this.config.get<string>(
      'CONVERT_SPOT_NETWORKS',
      this.evmNetworkPreference().join(','),
    ) ?? '';
    return [...new Set(
      configured
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => executable.has(value)),
    )];
  }

  private async getSpotCatalogFundedQuotes(
    preference: string[],
  ): Promise<Map<string, Set<string>>> {
    const key = preference.join(',');
    if (
      this.spotLiquidityCache &&
      this.spotLiquidityCache.key === key &&
      this.spotLiquidityCache.expiresAt > Date.now()
    ) {
      return this.spotLiquidityCache.value;
    }
    if (this.spotLiquidityRefresh) return this.spotLiquidityRefresh;

    this.spotLiquidityRefresh = this.loadSpotCatalogFundedQuotes(preference)
      .then((value) => {
        this.spotLiquidityCache = {
          key,
          expiresAt: Date.now() + this.config.get<number>('CONVERT_SPOT_CATALOG_CACHE_MS', 60_000),
          value,
        };
        return value;
      })
      .finally(() => {
        this.spotLiquidityRefresh = undefined;
      });
    return this.spotLiquidityRefresh;
  }

  private async loadSpotCatalogFundedQuotes(
    preference: string[],
  ): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (preference.length === 0) return result;
    let wallet: string;
    try {
      wallet = await this.custody.getWalletAddress(this.spotLiquidityWalletId());
    } catch (error) {
      this.logger.warn(`Spot catalog liquidity check skipped: ${this.safeError(error)}`);
      return result;
    }
    const stableAssets = await this.prisma.asset.findMany({
      where: { symbol: { in: ['USDC', 'USDT'] } },
      include: {
        tokenContracts: {
          where: {
            standard: TokenStandard.ERC20,
            contractVerifiedAt: { not: null },
            network: { mainnet: true, chainKey: { in: preference } },
          },
          include: { network: true },
        },
      },
    });
    const minimumStable = new Prisma.Decimal(
      this.config.get<string>('CONVERT_SPOT_CATALOG_MIN_STABLE_BALANCE', '100'),
    );

    await Promise.all(preference.map(async (networkKey) => {
      try {
        const expectedChainId = ONEINCH_EVM_NETWORKS.get(networkKey);
        if (!expectedChainId || await this.rpc.getChainId(networkKey) !== expectedChainId) return;
        const gas = await this.getEvmBalance(wallet, undefined, networkKey, 18);
        if (gas.lessThan(this.spotGasReserve(networkKey))) return;
        const funded = new Set<string>();
        for (const asset of stableAssets) {
          const contract = asset.tokenContracts.find(
            (item) => item.network.chainKey === networkKey && item.address,
          );
          if (!contract?.address) continue;
          const balance = await this.getEvmBalance(
            wallet,
            contract.address,
            networkKey,
            contract.decimals,
          );
          if (balance.greaterThanOrEqualTo(minimumStable)) funded.add(asset.symbol);
        }
        if (funded.size > 0) result.set(networkKey, funded);
      } catch (error) {
        this.logger.warn(
          `Spot catalog excluded ${networkKey}: ${this.safeError(error)}`,
        );
      }
    }));
    return result;
  }

  private async loadAsset(symbol: string) {
    const asset = await this.prisma.asset.findUnique({
      where: { symbol },
      include: { tokenContracts: { include: { network: true } } },
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${symbol} not found`);
    }
    return asset;
  }

  private async assertEvmSourceInventory(quote: any) {
    const data = quote.providerData as QuoteProviderData;
    if (!data.fromToken || data.fromDecimals === undefined || !data.chainId || !data.networkKey) {
      throw new ServiceUnavailableException('EVM quote inventory metadata is missing');
    }
    const wallet = await this.custody.getWalletAddress(this.spotLiquidityWalletId());
    await this.assertEvmRouteInventory({
      networkKey: data.networkKey,
      chainId: data.chainId,
      fromToken: data.fromToken,
      toToken: data.toToken ?? NATIVE_TOKEN_ADDRESS,
      fromDecimals: data.fromDecimals,
      toDecimals: data.toDecimals,
      fromNative: Boolean(data.fromNative),
      toNative: Boolean(data.toNative),
    }, wallet, new Prisma.Decimal(quote.fromAmount));
  }

  private async assertReserveCoverage(toAsset: any, additionalGross: Prisma.Decimal) {
    const liabilities = await this.ledger.getTotalAccountTypeBalance({
      assetId: toAsset.id,
      accountType: LedgerAccountType.USER_SPOT,
    });
    let custodyBalance: Prisma.Decimal;
    if (toAsset.symbol === 'SOL') {
      const { Connection, PublicKey } = await import('@solana/web3.js');
      const wallet = await this.custody.getWalletAddress(
        this.config.getOrThrow<string>('PRIVY_SOLANA_WALLET_ID'),
      );
      const rpcUrl = this.config.getOrThrow<string>('SOLANA_RPC_PRIMARY_URL');
      const lamports = await new Connection(rpcUrl, 'confirmed').getBalance(new PublicKey(wallet), 'confirmed');
      custodyBalance = new Prisma.Decimal(lamports).div(1_000_000_000);
    } else if (toAsset.symbol === 'TRX') {
      custodyBalance = await this.getTronBalance(toAsset);
    } else {
      custodyBalance = await this.getAggregateEvmBalance(toAsset);
    }
    const coverageBps = this.config.get<number>('CONVERT_RESERVE_COVERAGE_BPS', 11_000);
    const required = liabilities.plus(additionalGross).mul(coverageBps).div(10_000);
    if (custodyBalance.lessThan(required)) {
      throw new ServiceUnavailableException(`${toAsset.symbol} reserve coverage is insufficient`);
    }
  }

  private async assertEvmRouteInventory(
    route: EvmRoute,
    wallet: string,
    amount: Prisma.Decimal,
  ): Promise<void> {
    const actualChainId = await this.rpc.getChainId(route.networkKey);
    if (actualChainId !== route.chainId) {
      throw new ServiceUnavailableException(`${route.networkKey} RPC chain ID mismatch`);
    }
    const source = await this.getEvmBalance(
      wallet,
      route.fromNative ? undefined : route.fromToken,
      route.networkKey,
      route.fromDecimals,
    );
    const gasReserve = new Prisma.Decimal(
      this.config.get<string>('CONVERT_EVM_GAS_RESERVE', '0.00015'),
    );
    if (source.lessThan(amount.plus(route.fromNative ? gasReserve : 0))) {
      throw new ServiceUnavailableException(`${route.networkKey} source inventory is insufficient`);
    }
    if (!route.fromNative) {
      const gas = await this.getEvmBalance(wallet, undefined, route.networkKey, 18);
      if (gas.lessThan(gasReserve)) {
        throw new ServiceUnavailableException(`${route.networkKey} gas reserve is insufficient`);
      }
    }
  }

  private async getEvmBalance(
    wallet: string,
    token: string | undefined,
    networkKey: string,
    decimals: number,
  ): Promise<Prisma.Decimal> {
    const result = await this.rpc.getBalance(
      wallet,
      token,
      networkKey,
      decimals,
    );
    return token
      ? new Prisma.Decimal(result.value)
      : new Prisma.Decimal(formatUnits(BigInt(result.value), decimals));
  }

  private sumErc20TransfersToWallet(
    logs: Array<{ address: string; data: string; topics: string[] }> | undefined,
    tokenAddress: string,
    walletAddress: string,
    decimals: number,
  ): Prisma.Decimal {
    const token = tokenAddress.toLowerCase();
    const recipientTopic = `0x${walletAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
    const raw = (logs ?? []).reduce((sum, log) => {
      if (
        log.address.toLowerCase() !== token ||
        log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
        log.topics[2]?.toLowerCase() !== recipientTopic
      ) {
        return sum;
      }
      try {
        return sum + BigInt(log.data);
      } catch (_error) {
        return sum;
      }
    }, 0n);
    return new Prisma.Decimal(formatUnits(raw, decimals));
  }

  private assertEvmTransactionSender(
    transaction: { from?: string },
    expectedWalletAddress: string,
  ): void {
    if (
      !transaction.from ||
      getAddress(transaction.from) !== getAddress(expectedWalletAddress)
    ) {
      throw new ManualReconciliationRequiredError(
        'Confirmed conversion was signed by an unexpected custody wallet',
      );
    }
  }

  private async getAggregateEvmBalance(asset: any): Promise<Prisma.Decimal> {
    const wallet = await this.custody.getWalletAddress();
    const contracts = asset.tokenContracts.filter((item: any) => this.isVerifiedEvmContract(item));
    const requests: Array<Promise<Prisma.Decimal>> = contracts.map((contract: any) =>
      this.getEvmBalance(
        wallet,
        contract.standard === TokenStandard.NATIVE ? undefined : contract.address,
        contract.network.chainKey,
        contract.decimals,
      ));
    if (
      ['USDC', 'USDT'].includes(asset.symbol) &&
      this.custody.isTronEnabled() &&
      asset.tokenContracts.some((item: any) =>
        item.network.chainKey === TRON_NETWORK && item.standard === TokenStandard.TRC20 &&
        item.address && item.contractVerifiedAt,
      )
    ) {
      requests.push(this.getTronBalance(asset));
    }
    if (requests.length === 0) {
      throw new ServiceUnavailableException(`${asset.symbol} has no verified reserve contract`);
    }
    const balances = await Promise.allSettled(requests);
    const total = balances.reduce(
      (sum, result) => result.status === 'fulfilled' ? sum.plus(result.value) : sum,
      new Prisma.Decimal(0),
    );
    if (!balances.some((result) => result.status === 'fulfilled')) {
      throw new ServiceUnavailableException(`${asset.symbol} reserves are unavailable`);
    }
    return total;
  }

  private async getTronBalance(asset: any): Promise<Prisma.Decimal> {
    const walletId = this.config.getOrThrow<string>('PRIVY_TRON_WALLET_ID');
    const wallet = await this.custody.getWalletAddress(walletId);
    const fullHost = this.config.getOrThrow<string>('TRON_RPC_PRIMARY_URL');
    const tronModule = await import('tronweb');
    const TronWebCtor = (tronModule as any).TronWeb ?? (tronModule as any).default;
    const apiKey = this.config.get<string>('TRON_PRO_API_KEY', '').trim();
    const tronWeb = new TronWebCtor({
      fullHost,
      ...(apiKey ? { headers: { 'TRON-PRO-API-KEY': apiKey } } : {}),
    });
    if (asset.symbol === 'TRX') {
      const sun = await tronWeb.trx.getBalance(wallet);
      return new Prisma.Decimal(sun).div(1_000_000);
    }
    const contract = asset.tokenContracts.find((item: any) =>
      item.network.chainKey === TRON_NETWORK &&
      item.network.mainnet &&
      item.standard === TokenStandard.TRC20 &&
      item.address &&
      item.contractVerifiedAt,
    );
    if (!contract) {
      throw new ServiceUnavailableException(`${asset.symbol} Tron reserve contract is unavailable`);
    }
    const token = await tronWeb.contract().at(contract.address);
    const raw = await token.balanceOf(wallet).call();
    return new Prisma.Decimal(raw.toString()).div(new Prisma.Decimal(`1e${contract.decimals}`));
  }

  private async assertOrderLimits(userId: string, fromAsset: any, toAsset: any, from: Prisma.Decimal, expectedTo: Prisma.Decimal) {
    const value = ['USDC', 'USDT'].includes(fromAsset.symbol)
      ? from
      : ['USDC', 'USDT'].includes(toAsset.symbol)
        ? expectedTo
        : null;
    if (!value) {
      throw new BadRequestException('At least one conversion side must be USDC or USDT');
    }
    const max = new Prisma.Decimal(this.config.get<string>('CONVERT_MAX_ORDER_USDC', '100'));
    if (max.greaterThan(0) && value.greaterThan(max)) {
      throw new BadRequestException(`Maximum conversion value is ${max.toString()} USDC`);
    }
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const completed = await this.prisma.conversion.findMany({
      where: {
        userId,
        createdAt: { gte: since },
        status: { in: [ConversionStatus.PENDING, ConversionStatus.EXECUTING, ConversionStatus.FILLED] },
      },
      include: { fromAsset: true, toAsset: true },
    });
    const used = completed.reduce((sum, item) => {
      if (['USDC', 'USDT'].includes(item.fromAsset.symbol)) {
        return sum.plus(item.fromAmount);
      }
      if (['USDC', 'USDT'].includes(item.toAsset.symbol)) {
        return sum.plus(item.expectedToAmount);
      }
      return sum;
    }, new Prisma.Decimal(0));
    const daily = new Prisma.Decimal(this.config.get<string>('CONVERT_DAILY_LIMIT_USDC', '1000'));
    if (daily.greaterThan(0) && used.plus(value).greaterThan(daily)) {
      throw new BadRequestException('Daily conversion limit exceeded');
    }
  }

  private async waitForEvmTransaction(txHash: string, networkKey: string) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        const tx = await this.rpc.getTransaction(txHash, networkKey);
        if (tx.status === 1) {
          return tx;
        }
        if (tx.status === 0) {
          throw new ServiceUnavailableException('On-chain conversion transaction reverted');
        }
      } catch (error) {
        if (error instanceof ServiceUnavailableException && /reverted/i.test(error.message)) {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new PendingProviderTransactionError('Provider transaction is still pending');
  }

  private assertConvertEnabled() {
    if (!this.config.get<boolean>('CONVERT_ENABLED', false)) {
      throw new ServiceUnavailableException('Conversion is disabled');
    }
  }

  private async checkEvmReadiness(networkKey: string, expectedChainId: number) {
    try {
      const [chainId, walletAddress] = await Promise.all([
        this.rpc.getChainId(networkKey),
        this.custody.getWalletAddress(this.spotLiquidityWalletId()),
      ]);
      const providerConfigured = this.oneInch.getStatus().enabled;
      const gasBalance = await this.getEvmBalance(walletAddress, undefined, networkKey, 18);
      const usdc = await this.prisma.tokenContract.findFirst({
        where: {
          standard: TokenStandard.ERC20,
          address: { not: null },
          contractVerifiedAt: { not: null },
          asset: { symbol: 'USDC' },
          network: { chainKey: networkKey, mainnet: true },
        },
      });
      const usdcBalance = usdc?.address
        ? await this.getEvmBalance(walletAddress, usdc.address, networkKey, usdc.decimals)
        : new Prisma.Decimal(0);
      const minimumStable = new Prisma.Decimal(
        this.config.get<string>('CONVERT_SPOT_CATALOG_MIN_STABLE_BALANCE', '100'),
      );
      const gasRequired = this.spotGasReserve(networkKey);
      const liquidityReady = usdcBalance.greaterThanOrEqualTo(minimumStable) &&
        gasBalance.greaterThanOrEqualTo(gasRequired);
      return {
        ready: chainId === expectedChainId && Boolean(walletAddress) && providerConfigured && liquidityReady,
        chainId,
        custodyWalletConfigured: Boolean(walletAddress),
        providerConfigured,
        liquidityReady,
        usdcBalance: usdcBalance.toString(),
        minimumUsdcBalance: minimumStable.toString(),
        gasBalance: gasBalance.toString(),
        minimumGasBalance: gasRequired.toString(),
        reason: liquidityReady ? null : 'SPOT_LIQUIDITY_INSUFFICIENT',
      };
    } catch (error) {
      return {
        ready: false,
        custodyWalletConfigured: Boolean(
          this.config.get<string>('PRIVY_SPOT_LIQUIDITY_WALLET_ID'),
        ),
        providerConfigured: this.oneInch.getStatus().enabled,
        reason: this.safeError(error),
      };
    }
  }

  private async checkSolanaReadiness() {
    try {
      const { Connection } = await import('@solana/web3.js');
      const rpcUrl = this.config.getOrThrow<string>('SOLANA_RPC_PRIMARY_URL');
      const walletAddress = await this.custody.getWalletAddress(
        this.config.getOrThrow<string>('PRIVY_SOLANA_WALLET_ID'),
      );
      await new Connection(rpcUrl, 'confirmed').getLatestBlockhash('confirmed');
      return { ready: true, custodyWalletConfigured: Boolean(walletAddress), rpcConfigured: true };
    } catch (error) {
      return {
        ready: false,
        custodyWalletConfigured: this.custody.isSolanaEnabled(),
        rpcConfigured: Boolean(this.config.get<string>('SOLANA_RPC_PRIMARY_URL')),
        reason: this.safeError(error),
      };
    }
  }

  private async checkTronReadiness() {
    try {
      const fullHost = this.config.getOrThrow<string>('TRON_RPC_PRIMARY_URL');
      const walletAddress = await this.custody.getWalletAddress(
        this.config.getOrThrow<string>('PRIVY_TRON_WALLET_ID'),
      );
      const tronModule = await import('tronweb');
      const TronWebCtor = (tronModule as any).TronWeb ?? (tronModule as any).default;
      const apiKey = this.config.get<string>('TRON_PRO_API_KEY', '').trim();
      if (
        this.config.get<string>('NODE_ENV', 'development') === 'production' &&
        !apiKey
      ) {
        throw new ServiceUnavailableException('TRON_PRO_API_KEY is required in production');
      }
      const tronWeb = new TronWebCtor({
        fullHost,
        ...(apiKey ? { headers: { 'TRON-PRO-API-KEY': apiKey } } : {}),
      });
      await tronWeb.trx.getCurrentBlock();
      return { ready: true, custodyWalletConfigured: Boolean(walletAddress), rpcConfigured: true };
    } catch (error) {
      return {
        ready: false,
        custodyWalletConfigured: this.custody.isTronEnabled(),
        rpcConfigured: Boolean(this.config.get<string>('TRON_RPC_PRIMARY_URL')),
        reason: this.safeError(error),
      };
    }
  }

  private presentQuote(quote: any) {
    return {
      id: quote.id,
      fromAsset: quote.fromAsset.symbol,
      toAsset: quote.toAsset.symbol,
      fromAmount: quote.fromAmount.toString(),
      expectedToAmount: quote.expectedToAmount.toString(),
      minToAmount: quote.minToAmount.toString(),
      feeAmount: quote.feeAmount.toString(),
      feeBps: this.config.get<number>('CONVERT_FEE_BPS', 20),
      slippageBps: quote.slippageBps,
      provider: quote.provider,
      network: quote.networkKey,
      expiresAt: quote.expiresAt,
    };
  }

  private presentConversion(conversion: any) {
    return {
      id: conversion.id,
      clientConversionId: conversion.clientConversionId,
      status: conversion.status,
      fromAsset: conversion.fromAsset.symbol,
      toAsset: conversion.toAsset.symbol,
      fromAmount: conversion.fromAmount.toString(),
      expectedToAmount: conversion.expectedToAmount.toString(),
      actualToAmount: conversion.actualToAmount?.toString() ?? null,
      feeAmount: conversion.feeAmount.toString(),
      provider: conversion.provider,
      network: conversion.networkKey,
      txHash: conversion.txHash,
      failureReason: conversion.failureReason,
      createdAt: conversion.createdAt,
      completedAt: conversion.completedAt,
    };
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 500) : 'Unknown conversion error';
  }
}
