import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderSide, OrderType } from '@prisma/client';
import {
  PerpLiquidityProvider,
  ProviderFillResult,
  ProviderOrderInput,
  ProviderOrderResult,
  ProviderOrderSnapshot,
  ProviderReadiness,
} from './perp-liquidity-provider';
import { PrivyCustodyService } from '../treasury/privy-custody.service';
import { formatHyperliquidPrice, formatHyperliquidSize } from './hyperliquid-order-format';

@Injectable()
export class HyperliquidExecutionService implements PerpLiquidityProvider {
  private readonly logger = new Logger(HyperliquidExecutionService.name);
  private readinessCache?: { expiresAt: number; value: ProviderReadiness };
  private transientFailures = 0;
  private circuitOpenUntil = 0;
  constructor(
    private readonly config: ConfigService,
    private readonly custody: PrivyCustodyService,
  ) {}

  isExecutionEnabled(): boolean {
    return Boolean(
      this.config.get<boolean>('HYPERLIQUID_EXECUTION_ENABLED', false) &&
      this.config.get<string>('PRIVY_APP_ID') &&
      this.config.get<string>('PRIVY_APP_SECRET') &&
      this.config.get<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64') &&
      this.config.get<string>('PRIVY_HYPERLIQUID_MASTER_WALLET_ID') &&
      this.config.get<string>('PRIVY_HYPERLIQUID_AGENT_WALLET_ID') &&
      this.config.get<string>('PRIVY_HYPERLIQUID_AGENT_ADDRESS') &&
      this.config.get<string>('HYPERLIQUID_MASTER_ADDRESS') &&
      this.config.get<boolean>('MAINNET_ENABLED', false) &&
      this.config.get<boolean>('HYPERLIQUID_TESTNET', true) === false &&
      this.config.get<string>('MARKET_DATA_PROVIDER') === 'HYPERLIQUID' &&
      this.config.get<boolean>('MARKET_DATA_FALLBACK_TO_MOCK', true) === false,
    );
  }

  async getReadiness(): Promise<ProviderReadiness> {
    if (this.readinessCache && this.readinessCache.expiresAt > Date.now()) {
      return this.readinessCache.value;
    }
    const reasons: string[] = [];
    if (!this.isExecutionEnabled()) {
      reasons.push('CONFIG_INCOMPLETE');
      const value = {
        ready: false,
        reasons,
        masterAddressConfigured: Boolean(this.config.get<string>('HYPERLIQUID_MASTER_ADDRESS')),
        agentAddressConfigured: Boolean(this.config.get<string>('PRIVY_HYPERLIQUID_AGENT_ADDRESS')),
        agentRegistered: false,
      };
      this.readinessCache = { expiresAt: Date.now() + 5_000, value };
      return value;
    }
    let accountValue: string | undefined;
    let withdrawable: string | undefined;
    let agentRegistered = false;
    try {
      const masterWalletId = this.config.getOrThrow<string>('PRIVY_HYPERLIQUID_MASTER_WALLET_ID');
      const agentWalletId = this.config.getOrThrow<string>('PRIVY_HYPERLIQUID_AGENT_WALLET_ID');
      const expectedMaster = this.config.getOrThrow<string>('HYPERLIQUID_MASTER_ADDRESS').toLowerCase();
      const expectedAgent = this.config.getOrThrow<string>('PRIVY_HYPERLIQUID_AGENT_ADDRESS').toLowerCase();
      const [masterAddress, agentAddress, clients] = await Promise.all([
        this.custody.getWalletAddress(masterWalletId),
        this.custody.getWalletAddress(agentWalletId),
        this.createClients(),
      ]);
      if (masterAddress.toLowerCase() !== expectedMaster) reasons.push('MASTER_ADDRESS_MISMATCH');
      if (agentAddress.toLowerCase() !== expectedAgent) reasons.push('AGENT_ADDRESS_MISMATCH');
      const [agents, state] = await Promise.all([
        clients.info.extraAgents({ user: expectedMaster as `0x${string}` }),
        clients.info.clearinghouseState({ user: expectedMaster as `0x${string}` }),
      ]);
      agentRegistered = agents.some((agent) =>
        agent.address.toLowerCase() === expectedAgent &&
        (agent.validUntil === null || agent.validUntil > Date.now()),
      );
      if (!agentRegistered) reasons.push('AGENT_NOT_REGISTERED');
      accountValue = String((state as any)?.marginSummary?.accountValue ?? '0');
      withdrawable = String((state as any)?.withdrawable ?? '0');
      const minimum = Number(this.config.get<string>('HYPERLIQUID_MIN_ACCOUNT_VALUE_USDC', '25'));
      const minimumWithdrawable = Number(
        this.config.get<string>('HYPERLIQUID_MIN_WITHDRAWABLE_USDC', '5'),
      );
      if (
        !Number.isFinite(Number(accountValue)) ||
        Number(accountValue) < minimum ||
        !Number.isFinite(Number(withdrawable)) ||
        Number(withdrawable) < minimumWithdrawable
      ) {
        reasons.push('COLLATERAL_INSUFFICIENT');
      }
      if (this.config.get<string>('MARKET_DATA_PROVIDER', 'MOCK') !== 'HYPERLIQUID') {
        reasons.push('MARKET_DATA_NOT_HYPERLIQUID');
      }
    } catch (_error) {
      reasons.push('PROVIDER_UNAVAILABLE');
    }
    const value = {
      ready: reasons.length === 0,
      reasons: [...new Set(reasons)],
      accountValue,
      withdrawable,
      masterAddressConfigured: true,
      agentAddressConfigured: true,
      agentRegistered,
    };
    this.readinessCache = { expiresAt: Date.now() + 10_000, value };
    return value;
  }

  async placeOrder(input: ProviderOrderInput): Promise<ProviderOrderResult> {
    return this.withProviderResilience('placeOrder', false, async () => {
    const { client, info } = await this.createClients();
    const meta = await info.meta();
    const asset = meta.universe.findIndex((item) => item.name === input.providerSymbol);
    if (asset < 0) {
      throw new ServiceUnavailableException('Hyperliquid market is unavailable');
    }

    const orderType =
      input.type === OrderType.STOP_LOSS || input.type === OrderType.TAKE_PROFIT
        ? {
            trigger: {
              isMarket: true,
              triggerPx: input.triggerPrice ?? input.price,
              tpsl: input.type === OrderType.STOP_LOSS ? 'sl' as const : 'tp' as const,
            },
          }
        : {
            limit: {
              tif: input.type === OrderType.MARKET ? 'FrontendMarket' as const : 'Gtc' as const,
            },
          };

    const assetMeta = meta.universe[asset];
    if (!assetMeta) {
      throw new ServiceUnavailableException('Hyperliquid market is unavailable');
    }
    const formattedPrice = formatHyperliquidPrice(input.price, assetMeta.szDecimals);
    const formattedSize = formatHyperliquidSize(input.size, assetMeta.szDecimals);

    const response = await client.order({
      orders: [
        {
          a: asset,
          b: input.side === OrderSide.BUY,
          p: formattedPrice,
          s: formattedSize,
          r: input.reduceOnly,
          t: orderType,
          c: input.cloid,
        },
      ],
      grouping: 'na',
    });
    const status = response.response.data.statuses[0];
    if (!status || typeof status === 'string') {
      return { status: 'PENDING', raw: response };
    }
    if ('error' in status) {
      return {
        status: 'REJECTED',
        reason: String(status.error),
        raw: response,
      };
    }
    if ('filled' in status) {
      return {
        providerOrderId: String(status.filled.oid),
        status: 'FILLED',
        filledSize: status.filled.totalSz,
        averagePrice: status.filled.avgPx,
        raw: response,
      };
    }
    return {
      providerOrderId: String(status.resting.oid),
      status: 'OPEN',
      raw: response,
    };
    });
  }

  async cancelOrder(input: {
    providerSymbol: string;
    providerOrderId?: string;
    cloid?: `0x${string}`;
  }): Promise<void> {
    return this.withProviderResilience('cancelOrder', false, async () => {
    const { client, info } = await this.createClients();
    const meta = await info.meta();
    const asset = meta.universe.findIndex((item) => item.name === input.providerSymbol);
    if (asset < 0) {
      throw new ServiceUnavailableException('Hyperliquid market is unavailable');
    }
    if (input.providerOrderId) {
      await client.cancel({ cancels: [{ a: asset, o: Number(input.providerOrderId) }] });
      return;
    }
    if (input.cloid) {
      await client.cancelByCloid({ cancels: [{ asset, cloid: input.cloid }] });
      return;
    }
    throw new ServiceUnavailableException('Provider order identifier is missing');
    });
  }

  async getOrderSnapshot(cloid: `0x${string}`): Promise<ProviderOrderSnapshot> {
    return this.withProviderResilience('getOrderSnapshot', true, async () => {
    const { info } = await this.createClients();
    const master = this.config.getOrThrow<string>('HYPERLIQUID_MASTER_ADDRESS') as `0x${string}`;
    const response = await info.orderStatus({ user: master, oid: cloid });
    if (response.status === 'unknownOid') {
      return { status: 'UNKNOWN', raw: response };
    }
    const provider = response.order;
    const state = provider.status;
    const status = state === 'open' || state === 'triggered'
      ? 'OPEN'
      : state === 'filled'
        ? 'FILLED'
        : state === 'canceled'
          ? 'CANCELLED'
          : 'REJECTED';
    return {
      status,
      providerOrderId: String(provider.order.oid),
      originalSize: provider.order.origSz,
      remainingSize: provider.order.sz,
      reason: status === 'REJECTED' ? state : undefined,
      raw: response,
    };
    });
  }

  async getOrderFills(cloid: `0x${string}`): Promise<ProviderFillResult[]> {
    return this.withProviderResilience('getOrderFills', true, async () => {
    const { info } = await this.createClients();
    const master = this.config.getOrThrow<string>('HYPERLIQUID_MASTER_ADDRESS') as `0x${string}`;
    const fills = await info.userFills({ user: master, aggregateByTime: false });
    return fills.filter((fill) => fill.cloid?.toLowerCase() === cloid.toLowerCase()).map((fill) => ({
      providerFillId: `hyperliquid:${fill.tid}`,
      providerOrderId: String(fill.oid),
      price: fill.px,
      size: fill.sz,
      feeAmount: fill.fee,
      occurredAt: new Date(fill.time),
      raw: fill,
    }));
    });
  }

  async getAccountState(): Promise<unknown> {
    const { info } = await this.createClients();
    const address = this.config.getOrThrow<string>('HYPERLIQUID_MASTER_ADDRESS');
    return info.clearinghouseState({ user: address as `0x${string}` });
  }

  async getOpenOrders(): Promise<unknown> {
    const { info } = await this.createClients();
    const address = this.config.getOrThrow<string>('HYPERLIQUID_MASTER_ADDRESS');
    const client = info as unknown as {
      openOrders?: (input: { user: `0x${string}` }) => Promise<unknown>;
    };
    if (!client.openOrders) {
      return { supported: false };
    }
    return client.openOrders({ user: address as `0x${string}` });
  }

  async getFills(): Promise<unknown> {
    const { info } = await this.createClients();
    const address = this.config.getOrThrow<string>('HYPERLIQUID_MASTER_ADDRESS');
    const client = info as unknown as {
      userFills?: (input: { user: `0x${string}` }) => Promise<unknown>;
    };
    if (!client.userFills) {
      return { supported: false };
    }
    return client.userFills({ user: address as `0x${string}` });
  }

  private async createClients() {
    if (!this.isExecutionEnabled()) {
      throw new ServiceUnavailableException('Hyperliquid execution is disabled');
    }
    const hl = (await this.dynamicImport('@nktkas/hyperliquid')) as typeof import('@nktkas/hyperliquid');
    const [privyModule, privyViem] = await Promise.all([
      this.dynamicImport('@privy-io/node') as Promise<{
        PrivyClient: new (options: {
          appId: string;
          appSecret: string;
          apiUrl?: string;
        }) => unknown;
      }>,
      this.dynamicImport('@privy-io/node/viem') as Promise<{
        createViemAccount: (
          client: unknown,
          input: {
            walletId: string;
            address: `0x${string}`;
            authorizationContext?: { authorization_private_keys: string[] };
          },
        ) => unknown;
      }>,
    ]);
    const privy = new privyModule.PrivyClient({
      appId: this.config.getOrThrow<string>('PRIVY_APP_ID'),
      appSecret: this.config.getOrThrow<string>('PRIVY_APP_SECRET'),
      apiUrl: this.getSdkApiUrl(),
    });
    const wallet = privyViem.createViemAccount(privy, {
      walletId: this.config.getOrThrow<string>('PRIVY_HYPERLIQUID_AGENT_WALLET_ID'),
      address: this.config.getOrThrow<string>(
        'PRIVY_HYPERLIQUID_AGENT_ADDRESS',
      ) as `0x${string}`,
      authorizationContext: {
        authorization_private_keys: [
          this.config.getOrThrow<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64'),
        ],
      },
    });
    const transport = new hl.HttpTransport({
      isTestnet: this.config.get<boolean>('HYPERLIQUID_TESTNET', true),
    });
    return {
      client: new hl.ExchangeClient({ transport, wallet: wallet as never }),
      info: new hl.InfoClient({ transport }),
    };
  }

  private async withProviderResilience<T>(
    operation: string,
    retrySafe: boolean,
    execute: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    if (this.circuitOpenUntil > now) {
      throw new ServiceUnavailableException(
        `Hyperliquid circuit is open for ${this.circuitOpenUntil - now}ms`,
      );
    }
    const attempts = retrySafe
      ? this.config.get<number>('HYPERLIQUID_RETRY_ATTEMPTS', 3)
      : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await execute();
        this.transientFailures = 0;
        this.circuitOpenUntil = 0;
        return result;
      } catch (error) {
        lastError = error;
        if (!this.isTransientProviderError(error)) throw error;
        this.transientFailures += 1;
        const threshold = this.config.get<number>('HYPERLIQUID_CIRCUIT_FAILURE_THRESHOLD', 5);
        if (this.transientFailures >= threshold) {
          const cooldown = this.config.get<number>('HYPERLIQUID_CIRCUIT_COOLDOWN_MS', 15_000);
          this.circuitOpenUntil = Date.now() + cooldown;
          this.logger.warn(
            `Hyperliquid circuit opened after ${this.transientFailures} transient failures`,
          );
          break;
        }
        if (attempt < attempts - 1) {
          const base = this.config.get<number>('HYPERLIQUID_RETRY_BASE_DELAY_MS', 250);
          const max = this.config.get<number>('HYPERLIQUID_RETRY_MAX_DELAY_MS', 3_000);
          const backoff = Math.min(max, base * 2 ** attempt);
          const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(backoff / 4)));
          await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
        }
      }
    }
    const message = lastError instanceof Error ? lastError.message : 'provider unavailable';
    throw new ServiceUnavailableException(`Hyperliquid ${operation} failed: ${message}`);
  }

  private isTransientProviderError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\b429\b|\b5\d\d\b|timeout|timed out|aborted|network|fetch failed|ECONN|circuit is open/i.test(
      message,
    );
  }

  private dynamicImport(specifier: string): Promise<unknown> {
    const importer = new Function('moduleName', 'return import(moduleName)') as (
      moduleName: string,
    ) => Promise<unknown>;
    return importer(specifier);
  }

  private getSdkApiUrl(): string | undefined {
    const configured = this.config.get<string>('PRIVY_API_URL');
    return configured?.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  }
}
