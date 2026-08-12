import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NetworkFamily, Prisma, TokenStandard } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { DepositIndexerService } from './deposit-indexer.service';
import { DepositsService } from './deposits.service';

type AlchemyActivity = {
  blockNum?: string;
  hash?: string;
  toAddress?: string;
  category?: string;
  rawContract?: { address?: string | null } | null;
  log?: { address?: string; removed?: boolean } | null;
  removed?: boolean;
};

type AlchemyAddressActivityPayload = {
  webhookId?: string;
  id?: string;
  type?: string;
  event?: {
    network?: string;
    activity?: AlchemyActivity[];
  };
};

const NETWORK_KEYS: Record<string, string> = {
  ETH_MAINNET: 'ethereum',
  ARB_MAINNET: 'arbitrum',
  BASE_MAINNET: 'base',
  OPT_MAINNET: 'optimism',
  BNB_MAINNET: 'bnb',
};

@Injectable()
export class AlchemyDepositWebhookService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly indexer: DepositIndexerService,
    private readonly deposits: DepositsService,
  ) {}

  async handle(rawBody: Buffer, signature: string) {
    if (!this.config.get<boolean>('ALCHEMY_ADDRESS_ACTIVITY_ENABLED', false)) {
      throw new ServiceUnavailableException('Alchemy address activity webhooks are disabled');
    }
    const payload = this.parsePayload(rawBody);
    const signingKey = this.signingKey(payload.webhookId!);
    if (!this.verifySignature(rawBody, signature, signingKey)) {
      throw new ForbiddenException('Invalid Alchemy webhook signature');
    }
    if (payload.type !== 'ADDRESS_ACTIVITY') {
      throw new BadRequestException('Unsupported Alchemy webhook event type');
    }

    const networkKey = NETWORK_KEYS[payload.event?.network ?? ''];
    if (!networkKey) {
      throw new BadRequestException('Unsupported Alchemy webhook network');
    }
    const network = await this.prisma.network.findUnique({
      where: { chainKey: networkKey },
      select: { id: true, chainKey: true, legacyChain: true, family: true },
    });
    if (
      !network ||
      network.family !== NetworkFamily.EVM ||
      !network.legacyChain
    ) {
      throw new BadRequestException('Alchemy webhook network is not configured for deposits');
    }

    const existing = await this.prisma.providerWebhookEvent.findUnique({
      where: { id: payload.id! },
    });
    if (existing?.processedAt) {
      return { accepted: true, duplicate: true, scans: 0 };
    }
    if (!existing) {
      try {
        await this.prisma.providerWebhookEvent.create({
          data: {
            id: payload.id!,
            provider: 'ALCHEMY',
            eventType: payload.type!,
            referenceId: payload.webhookId!,
            providerTransactionId: this.singleTransactionHash(payload.event?.activity ?? []),
            payload: payload as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        const raced = await this.prisma.providerWebhookEvent.findUnique({
          where: { id: payload.id! },
        });
        if (!raced) throw error;
        if (raced.processedAt) {
          return { accepted: true, duplicate: true, scans: 0 };
        }
      }
    }

    const activeAddresses = new Set(
      (
        await this.prisma.userDepositAddress.findMany({
          where: { network: network.legacyChain, status: 'ACTIVE' },
          select: { address: true },
        })
      ).map((item) => item.address.toLowerCase()),
    );
    const contracts = await this.prisma.tokenContract.findMany({
      where: {
        networkId: network.id,
        depositEnabled: true,
        OR: [
          { standard: TokenStandard.NATIVE },
          { standard: TokenStandard.ERC20, address: { not: null } },
        ],
      },
      include: { asset: true },
    });
    const nativeContract = contracts.find((item) => item.standard === TokenStandard.NATIVE);
    const erc20ByAddress = new Map(
      contracts
        .filter((item) => item.standard === TokenStandard.ERC20 && item.address)
        .map((item) => [item.address!.toLowerCase(), item]),
    );
    const scans = new Map<string, { assetSymbol: string; blockNumber: number }>();

    for (const activity of payload.event?.activity ?? []) {
      if (
        activity.removed ||
        activity.log?.removed ||
        !activity.toAddress ||
        !activeAddresses.has(activity.toAddress.toLowerCase())
      ) {
        continue;
      }
      const blockNumber = this.parseBlockNumber(activity.blockNum);
      if (blockNumber === null) continue;

      const category = activity.category?.toLowerCase();
      const contractAddress = (
        activity.rawContract?.address ?? activity.log?.address ?? ''
      ).toLowerCase();
      const contract =
        category === 'external'
          ? nativeContract
          : category === 'token' || category === 'erc20'
            ? erc20ByAddress.get(contractAddress)
            : undefined;
      if (!contract) continue;
      scans.set(`${contract.id}:${blockNumber}`, {
        assetSymbol: contract.asset.symbol,
        blockNumber,
      });
    }

    for (const scan of scans.values()) {
      await this.indexer.scanDeposits({
        assetSymbol: scan.assetSymbol,
        network: network.chainKey,
        fromBlock: scan.blockNumber,
        toBlock: scan.blockNumber,
        latestBlock: scan.blockNumber,
      });
    }
    await this.deposits.creditReadyDeposits();
    await this.prisma.providerWebhookEvent.update({
      where: { id: payload.id! },
      data: { processedAt: new Date() },
    });
    return { accepted: true, duplicate: false, scans: scans.size };
  }

  private parsePayload(rawBody: Buffer): AlchemyAddressActivityPayload {
    let payload: AlchemyAddressActivityPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as AlchemyAddressActivityPayload;
    } catch (_error) {
      throw new BadRequestException('Invalid Alchemy webhook JSON');
    }
    if (!payload.id || !payload.webhookId || !payload.event) {
      throw new BadRequestException('Incomplete Alchemy webhook payload');
    }
    return payload;
  }

  private signingKey(webhookId: string): string {
    const encoded = this.config.get<string>('ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON', '').trim();
    if (encoded) {
      try {
        const keys = JSON.parse(encoded) as Record<string, string>;
        const selected = keys[webhookId] ?? keys.default;
        if (selected) return selected;
      } catch (_error) {
        throw new ServiceUnavailableException('Alchemy webhook signing key map is invalid');
      }
    }
    const shared = this.config.get<string>('ALCHEMY_WEBHOOK_SIGNING_KEY', '').trim();
    if (shared) return shared;
    throw new ServiceUnavailableException('Alchemy webhook signing key is not configured');
  }

  private verifySignature(rawBody: Buffer, signature: string, signingKey: string): boolean {
    if (!/^[a-fA-F0-9]{64}$/.test(signature)) return false;
    const expected = createHmac('sha256', signingKey).update(rawBody).digest();
    const actual = Buffer.from(signature, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private parseBlockNumber(value?: string): number | null {
    if (!value) return null;
    const parsed = Number.parseInt(value, value.startsWith('0x') ? 16 : 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  private singleTransactionHash(activities: AlchemyActivity[]): string | null {
    const hashes = [...new Set(activities.map((item) => item.hash).filter(Boolean))] as string[];
    return hashes.length === 1 ? hashes[0]!.toLowerCase() : null;
  }
}
