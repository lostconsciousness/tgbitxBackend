import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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

class PendingProviderTransactionError extends Error {}
class ManualReconciliationRequiredError extends Error {}

@Injectable()
export class ConvertService {
  private readonly logger = new Logger(ConvertService.name);
  private workerRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ledger: LedgerService,
    private readonly marketData: MarketDataService,
    private readonly oneInch: OneInchSwapProviderService,
    private readonly custody: PrivyCustodyService,
    @Inject(RPC_PROVIDER) private readonly rpc: RpcProvider,
  ) {}

  async listAssets() {
    const supportedNetworkKeys = this.evmNetworkPreference();
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
      const enabled = sol
        ? this.config.get<boolean>('CONVERT_SOL_ENABLED', false) && this.custody.isSolanaEnabled()
        : tron
          ? this.config.get<boolean>('CONVERT_TRON_ENABLED', false) && this.custody.isTronEnabled()
          : this.config.get<boolean>('CONVERT_EVM_ENABLED', false) && this.oneInch.getStatus().enabled;
      const networks = asset.tokenContracts
        .map((contract) => contract.network.chainKey)
        .filter((key) => ONEINCH_EVM_NETWORKS.has(key));
      return {
        symbol: asset.symbol,
        name: asset.name,
        iconUrl: asset.iconUrl,
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

  async getReadiness() {
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
    const walletAddress = await this.custody.getWalletAddress();
    if (conversion.txHash) {
      const receipt = await this.waitForEvmTransaction(conversion.txHash, conversion.networkKey);
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
        });
        await this.prisma.conversion.update({
          where: { id: conversion.id },
          data: { approvalTxHash: sent.txHash },
        });
        await this.waitForEvmTransaction(sent.txHash, conversion.networkKey);
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
    await this.prisma.$transaction(async (tx) => {
      const conversion = await tx.conversion.findUniqueOrThrow({ where: { id } });
      if (conversion.status === ConversionStatus.FILLED) {
        return;
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async failConversion(id: string, reason: string, release: boolean) {
    await this.prisma.$transaction(async (tx) => {
      const conversion = await tx.conversion.findUnique({ where: { id } });
      if (
        !conversion ||
        conversion.status === ConversionStatus.FILLED ||
        conversion.status === ConversionStatus.CANCELLED
      ) {
        return;
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
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

    const wallet = await this.custody.getWalletAddress();
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
    const wallet = await this.custody.getWalletAddress();
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
        this.custody.getWalletAddress(),
      ]);
      const providerConfigured = this.oneInch.getStatus().enabled;
      return {
        ready: chainId === expectedChainId && Boolean(walletAddress) && providerConfigured,
        chainId,
        custodyWalletConfigured: Boolean(walletAddress),
        providerConfigured,
      };
    } catch (error) {
      return {
        ready: false,
        custodyWalletConfigured: this.custody.isEnabled(),
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
