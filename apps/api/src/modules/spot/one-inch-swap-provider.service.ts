import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { BuildSpotSwapDto, SpotQuoteDto } from './dto/one-inch.dto';

export type OneInchTransaction = {
  to: string;
  data: `0x${string}`;
  value: string;
  gas?: string;
  gasPrice?: string;
};

type OneInchQuoteResponse = {
  srcAmount?: string;
  dstAmount: string;
};

@Injectable()
export class OneInchSwapProviderService {
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly spenderCache = new Map<number, { address: string; expiresAt: number }>();
  private readonly spotPriceCache = new Map<number, {
    value: Record<string, string>;
    expiresAt: number;
  }>();
  private readonly spotPriceInflight = new Map<number, Promise<Record<string, string>>>();

  constructor(private readonly config: ConfigService) {}

  getStatus() {
    return {
      enabled: this.isEnabled(),
      chainId: this.config.get<number>('ONEINCH_CHAIN_ID', 42161),
      provider: '1INCH',
    };
  }

  async getQuote(dto: SpotQuoteDto) {
    if (!this.isEnabled()) {
      return {
        ...this.getStatus(),
        status: 'DISABLED',
        reason: '1inch is not configured',
      };
    }
    const response = await this.request('quote', {
      src: dto.fromTokenAddress,
      dst: dto.toTokenAddress,
      amount: dto.amount,
    });
    return {
      ...this.getStatus(),
      status: 'AVAILABLE',
      quote: this.toJson(response),
    };
  }

  async quoteExactInput(input: {
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    chainId?: number;
  }): Promise<OneInchQuoteResponse> {
    this.assertEnabled();
    return this.request<OneInchQuoteResponse>('quote', {
      src: input.fromTokenAddress,
      dst: input.toTokenAddress,
      amount: input.amount,
    }, input.chainId);
  }

  async getSpotPrices(chainId?: number): Promise<Record<string, string>> {
    this.assertEnabled();
    const resolvedChainId = chainId ?? this.config.get<number>('ONEINCH_CHAIN_ID', 42161);
    const cached = this.spotPriceCache.get(resolvedChainId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const inflight = this.spotPriceInflight.get(resolvedChainId);
    if (inflight) return inflight;
    const swapBase = new URL(this.config.getOrThrow<string>('ONEINCH_BASE_URL'));
    const url = new URL(`/price/v1.1/${resolvedChainId}`, swapBase.origin);
    const request = this.enqueueRequest(() => this.requestUrl<Record<string, string>>(url))
      .then((value) => {
        this.spotPriceCache.set(resolvedChainId, {
          value,
          expiresAt: Date.now() + this.config.get<number>('ONEINCH_PRICE_CACHE_MS', 5_000),
        });
        return value;
      })
      .finally(() => this.spotPriceInflight.delete(resolvedChainId));
    this.spotPriceInflight.set(resolvedChainId, request);
    return request;
  }

  async getSpender(chainId?: number): Promise<string> {
    this.assertEnabled();
    const resolvedChainId = chainId ?? this.config.get<number>('ONEINCH_CHAIN_ID', 42161);
    const cached = this.spenderCache.get(resolvedChainId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.address;
    }
    const response = await this.request<{ address: string }>(
      'approve/spender',
      {},
      resolvedChainId,
    );
    this.spenderCache.set(resolvedChainId, {
      address: response.address,
      expiresAt: Date.now() + this.config.get<number>('ONEINCH_SPENDER_CACHE_MS', 300_000),
    });
    return response.address;
  }

  async getAllowance(input: {
    tokenAddress: string;
    walletAddress: string;
    chainId?: number;
  }): Promise<bigint> {
    this.assertEnabled();
    const response = await this.request<{ allowance: string }>('approve/allowance', {
      tokenAddress: input.tokenAddress,
      walletAddress: input.walletAddress,
    }, input.chainId);
    return BigInt(response.allowance);
  }

  async buildApproval(input: {
    tokenAddress: string;
    amount: string;
    chainId?: number;
  }): Promise<OneInchTransaction> {
    this.assertEnabled();
    return this.request<OneInchTransaction>('approve/transaction', {
      tokenAddress: input.tokenAddress,
      amount: input.amount,
    }, input.chainId);
  }

  async buildSwapTransaction(input: {
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    walletAddress: string;
    slippageBps: number;
    chainId?: number;
  }): Promise<{ tx: OneInchTransaction; dstAmount?: string }> {
    this.assertEnabled();
    return this.request<{ tx: OneInchTransaction; dstAmount?: string }>('swap', {
      src: input.fromTokenAddress,
      dst: input.toTokenAddress,
      amount: input.amount,
      from: input.walletAddress,
      origin: input.walletAddress,
      slippage: (input.slippageBps / 100).toString(),
      disableEstimate: 'false',
      allowPartialFill: 'false',
    }, input.chainId);
  }

  async buildSwap(dto: BuildSpotSwapDto) {
    if (!this.isEnabled()) {
      return {
        ...this.getStatus(),
        status: 'DISABLED',
        reason: '1inch is not configured',
      };
    }
    const response = await this.request('swap', {
      src: dto.fromTokenAddress,
      dst: dto.toTokenAddress,
      amount: dto.amount,
      from: dto.walletAddress,
      slippage: dto.slippage ?? '0.5',
      disableEstimate: 'false',
    });
    return {
      ...this.getStatus(),
      status: 'AVAILABLE',
      swap: this.toJson(response),
    };
  }

  private isEnabled(): boolean {
    return Boolean(
      this.config.get<boolean>('ONEINCH_ENABLED', false) &&
        this.config.get<string>('ONEINCH_API_KEY'),
    );
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException('1inch is not configured');
    }
  }

  private async request<T>(
    path: 'quote' | 'swap' | 'approve/spender' | 'approve/allowance' | 'approve/transaction',
    params: Record<string, string>,
    chainIdOverride?: number,
  ): Promise<T> {
    return this.enqueueRequest(async () => {
      const baseUrl = this.normalizeBaseUrl(
        this.config.getOrThrow<string>('ONEINCH_BASE_URL'),
      );
      const chainId = chainIdOverride ?? this.config.get<number>('ONEINCH_CHAIN_ID', 42161);
      const url = new URL(`${baseUrl}/${chainId}/${path}`);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      return this.requestUrl<T>(url);
    });
  }

  private async requestUrl<T>(url: URL): Promise<T> {
    const maxRetries = this.config.get<number>('ONEINCH_MAX_RETRIES', 2);
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await this.waitForRequestSlot();
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.getOrThrow<string>('ONEINCH_API_KEY')}`,
        },
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body as T;
      if (response.status === HttpStatus.TOO_MANY_REQUESTS) {
        const retryAfterMs = this.retryAfterMs(response.headers?.get?.('retry-after'));
        if (attempt < maxRetries) {
          await this.sleep(Math.max(retryAfterMs, 1_100 * 2 ** attempt));
          continue;
        }
        throw new HttpException({
          code: 'ONEINCH_RATE_LIMITED',
          message: '1inch rate limit exceeded; retry later',
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
        }, HttpStatus.TOO_MANY_REQUESTS);
      }
      const message =
        typeof body === 'object' && body && 'description' in body
          ? String((body as { description: unknown }).description)
          : `1inch returned HTTP ${response.status}`;
      throw new ServiceUnavailableException(message);
    }
    throw new ServiceUnavailableException('1inch request failed');
  }

  private enqueueRequest<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(operation, operation);
    this.requestQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async waitForRequestSlot(): Promise<void> {
    const interval = this.config.get<number>('ONEINCH_MIN_REQUEST_INTERVAL_MS', 1_100);
    const waitMs = Math.max(0, this.lastRequestAt + interval - Date.now());
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
    this.lastRequestAt = Date.now();
  }

  private retryAfterMs(value: string | null | undefined): number {
    if (!value) {
      return 1_100;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(30_000, seconds * 1_000);
    }
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.min(30_000, Math.max(0, date - Date.now())) : 1_100;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeBaseUrl(baseUrl: string) {
    const trimmed = baseUrl.replace(/\/$/, '');
    if (trimmed.includes('/swap/')) {
      return trimmed;
    }
    return `${trimmed}/swap/v6.1`;
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
