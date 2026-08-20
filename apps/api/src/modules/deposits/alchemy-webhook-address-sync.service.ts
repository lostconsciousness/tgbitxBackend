import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Chain } from '@prisma/client';
import { getAddress } from 'viem';
import { PrismaService } from '../../database/prisma.service';

const NOTIFY_API = 'https://dashboard.alchemy.com/api';
const ADDRESS_BATCH_SIZE = 500;
const NETWORK_CHAINS: Record<string, Chain> = {
  ethereum: Chain.ETHEREUM,
  arbitrum: Chain.ARBITRUM,
  base: Chain.BASE,
  optimism: Chain.OPTIMISM,
  bnb: Chain.BNB,
};

type WebhookAddressesResponse = {
  data?: string[];
  pagination?: {
    cursors?: {
      after?: string;
    };
  };
};

@Injectable()
export class AlchemyWebhookAddressSyncService {
  private readonly logger = new Logger(AlchemyWebhookAddressSyncService.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('0 */10 * * * *')
  async reconcileCron(): Promise<void> {
    if (this.running || !this.enabled()) return;
    this.running = true;
    try {
      const result = await this.reconcileAll();
      if (result.added > 0) {
        this.logger.log(
          `Added ${result.added} missing deposit address subscription(s) across ${result.webhooks} Alchemy webhook(s)`,
        );
      }
    } catch (error) {
      this.logger.warn(`Alchemy webhook address reconciliation failed: ${this.safeError(error)}`);
    } finally {
      this.running = false;
    }
  }

  async trackAddress(networkKey: string, address: string): Promise<boolean> {
    if (!this.enabled()) return false;
    const webhookId = this.webhookIds()[networkKey];
    if (!webhookId || !NETWORK_CHAINS[networkKey]) return false;
    await this.addAddresses(webhookId, [getAddress(address).toLowerCase()]);
    return true;
  }

  async reconcileAll(): Promise<{ webhooks: number; added: number }> {
    if (!this.enabled()) return { webhooks: 0, added: 0 };
    const ids = this.webhookIds();
    let webhooks = 0;
    let added = 0;

    for (const [networkKey, webhookId] of Object.entries(ids)) {
      const chain = NETWORK_CHAINS[networkKey];
      if (!chain) continue;
      const local = (
        await this.prisma.userDepositAddress.findMany({
          where: { network: chain, status: 'ACTIVE' },
          select: { address: true },
        })
      ).map((item) => getAddress(item.address).toLowerCase());
      const remote = await this.listAddresses(webhookId);
      const missing = [...new Set(local)].filter((address) => !remote.has(address));
      for (let offset = 0; offset < missing.length; offset += ADDRESS_BATCH_SIZE) {
        const batch = missing.slice(offset, offset + ADDRESS_BATCH_SIZE);
        await this.addAddresses(webhookId, batch);
        added += batch.length;
      }
      webhooks += 1;
    }

    return { webhooks, added };
  }

  private enabled(): boolean {
    return (
      this.config.get<boolean>('ALCHEMY_ADDRESS_ACTIVITY_ENABLED', false) &&
      Boolean(this.authToken()) &&
      Object.keys(this.webhookIds()).length > 0
    );
  }

  private authToken(): string {
    return this.config.get<string>('ALCHEMY_WEBHOOK_AUTH_TOKEN', '').trim();
  }

  private webhookIds(): Record<string, string> {
    const encoded = this.config.get<string>('ALCHEMY_WEBHOOK_IDS_JSON', '').trim();
    if (!encoded) return {};
    try {
      const parsed = JSON.parse(encoded) as Record<string, string>;
      const result: Record<string, string> = {};
      for (const [rawNetwork, rawId] of Object.entries(parsed)) {
        const network = rawNetwork.trim().toLowerCase();
        const id = typeof rawId === 'string' ? rawId.trim() : '';
        if (NETWORK_CHAINS[network] && id.startsWith('wh_')) {
          result[network] = id;
        }
      }
      return result;
    } catch (_error) {
      return {};
    }
  }

  private async listAddresses(webhookId: string): Promise<Set<string>> {
    const addresses = new Set<string>();
    let after = '';
    for (let page = 0; page < 1000; page += 1) {
      const url = new URL(`${NOTIFY_API}/webhook-addresses`);
      url.searchParams.set('webhook_id', webhookId);
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const body = await this.request<WebhookAddressesResponse>(url, { method: 'GET' });
      for (const address of body.data ?? []) {
        try {
          addresses.add(getAddress(address).toLowerCase());
        } catch (_error) {
          // Ignore malformed remote entries and leave them untouched.
        }
      }
      const next = body.pagination?.cursors?.after?.trim() ?? '';
      if (!next || next === after) return addresses;
      after = next;
    }
    throw new Error('Alchemy webhook address pagination exceeded the safety limit');
  }

  private async addAddresses(webhookId: string, addresses: string[]): Promise<void> {
    if (addresses.length === 0) return;
    await this.request(`${NOTIFY_API}/update-webhook-addresses`, {
      method: 'PATCH',
      body: JSON.stringify({
        webhook_id: webhookId,
        addresses_to_add: addresses,
        addresses_to_remove: [],
      }),
    });
  }

  private async request<T = unknown>(url: string | URL, init: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Alchemy-Token': this.authToken(),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Alchemy Notify API returned HTTP ${response.status}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error';
  }
}
