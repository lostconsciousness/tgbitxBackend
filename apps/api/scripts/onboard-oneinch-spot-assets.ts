import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../src/database/prisma.service';
import { DatabaseModule } from '../src/database/database.module';
import { AssetsModule } from '../src/modules/assets/assets.module';
import { AssetsService } from '../src/modules/assets/assets.service';

type ProviderToken = {
  chainId: number;
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  logoURI?: string;
  providers?: string[];
  rating?: number | string;
  blacklisted?: boolean;
  isFoT?: boolean;
};

type NetworkConfig = {
  chainId: number;
  usdc: string;
  usdcDecimals: number;
};

const NETWORKS: Record<string, NetworkConfig> = {
  arbitrum: { chainId: 42161, usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', usdcDecimals: 6 },
  bnb: { chainId: 56, usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', usdcDecimals: 18 },
  base: { chainId: 8453, usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', usdcDecimals: 6 },
  optimism: { chainId: 10, usdc: '0x0b2c639c533813f4aa9d7837caf62653d097fff85', usdcDecimals: 6 },
  ethereum: { chainId: 1, usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', usdcDecimals: 6 },
};
const NETWORK_PREFERENCE = Object.keys(NETWORKS);
const ONEINCH_NATIVE_PLACEHOLDER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['apps/api/.env', '.env', '../../.env'],
      isGlobal: true,
    }),
    DatabaseModule,
    AssetsModule,
  ],
})
class SpotAssetOnboardingModule {}

async function main() {
  const apply = process.argv.includes('--apply');
  const minimumAssets = numericArg(
    '--min-assets',
    Number(process.env.SPOT_ONBOARDING_MIN_ASSETS ?? '75'),
  );
  const apiKey = requiredEnv('ONEINCH_API_KEY');
  const app = await NestFactory.createApplicationContext(SpotAssetOnboardingModule, {
    logger: ['error', 'warn'],
  });
  const prisma = app.get(PrismaService);
  const assets = app.get(AssetsService);

  try {
    const networks = await prisma.network.findMany({
      where: { chainKey: { in: NETWORK_PREFERENCE }, mainnet: true },
    });
    for (const [networkKey, expected] of Object.entries(NETWORKS)) {
      const network = networks.find((item) => item.chainKey === networkKey);
      if (!network || network.chainId !== expected.chainId) {
        throw new Error(`${networkKey} mainnet configuration is missing or has the wrong chain ID`);
      }
    }

    const markets = await prisma.market.findMany({
      where: { type: 'PERP', status: 'ACTIVE' },
      include: {
        baseAsset: {
          include: {
            tokenContracts: {
              where: { network: { chainKey: { in: NETWORK_PREFERENCE } } },
              include: { network: true },
            },
          },
        },
      },
      orderBy: { symbol: 'asc' },
    });
    const providerLists = new Map<string, ProviderToken[]>();
    for (const networkKey of NETWORK_PREFERENCE) {
      providerLists.set(
        networkKey,
        await loadTokenList(apiKey, NETWORKS[networkKey]!.chainId),
      );
      await sleep(1_100);
    }

    const manifest: Array<{
      symbol: string;
      network: string;
      chainId: number;
      address: string;
      decimals: number;
      name: string;
      logoURI?: string;
    }> = [];
    const rejected: Array<{ symbol: string; reason: string }> = [];

    for (const market of markets) {
      const symbol = String(market.providerSymbol || market.baseAsset.symbol).toUpperCase();
      const candidates = selectCandidates(
        symbol,
        market.baseAsset.tokenContracts.map((contract) => ({
          network: contract.network.chainKey,
          address: contract.address?.toLowerCase() ?? null,
        })),
        providerLists,
      );
      if (candidates.length === 0) {
        rejected.push({ symbol, reason: 'no unique whitelisted 1inch contract on supported networks' });
        continue;
      }
      const failures: string[] = [];
      let accepted = false;
      for (const selected of candidates) {
        try {
          const trusted = await loadTrustedToken(
            apiKey,
            symbol,
            selected.network,
            selected.token.address,
          );
          const addressOwner = await prisma.tokenContract.findFirst({
            where: {
              network: { chainKey: selected.network },
              address: { equals: trusted.address, mode: 'insensitive' },
            },
            include: { asset: true },
          });
          if (
            addressOwner &&
            addressOwner.asset.symbol.toUpperCase() !== market.baseAsset.symbol.toUpperCase()
          ) {
            throw new Error(
              `${symbol} contract is already assigned to ${addressOwner.asset.symbol} on ${selected.network}`,
            );
          }
          const configuredContract = market.baseAsset.tokenContracts.find(
            (contract) => contract.network.chainKey === selected.network && contract.address,
          );
          if (
            configuredContract?.address &&
            configuredContract.address.toLowerCase() !== trusted.address.toLowerCase()
          ) {
            throw new Error(
              `${symbol} already has a different configured contract on ${selected.network}`,
            );
          }
          await assertRoundTripQuotes(apiKey, selected.network, trusted);
          manifest.push({
            symbol: market.baseAsset.symbol,
            network: selected.network,
            chainId: NETWORKS[selected.network]!.chainId,
            address: trusted.address.toLowerCase(),
            decimals: Number(trusted.decimals),
            name: trusted.name ?? market.baseAsset.name,
            ...(trusted.logoURI ? { logoURI: trusted.logoURI } : {}),
          });
          accepted = true;
          break;
        } catch (error) {
          failures.push(
            `${selected.network}: ${error instanceof Error ? error.message : 'provider validation failed'}`,
          );
        }
      }
      if (!accepted) {
        rejected.push({
          symbol,
          reason: failures.join('; '),
        });
      }
      await sleep(1_100);
    }

    if (manifest.length < minimumAssets) {
      throw new Error(
        `Only ${manifest.length} assets passed validation; required ${minimumAssets}. No changes applied. ` +
        `Rejected: ${JSON.stringify(rejected.slice(0, 30))}`,
      );
    }

    if (apply) {
      for (const item of manifest) {
        process.stderr.write(`Applying ${item.symbol} on ${item.network}\n`);
        try {
        const existing = await prisma.tokenContract.findFirst({
          where: {
            asset: { symbol: item.symbol },
            network: { chainKey: item.network },
            standard: 'ERC20',
          },
        });
        if (existing?.address && existing.address.toLowerCase() !== item.address) {
          throw new Error(
            `${item.symbol} already has a different ${item.network} contract; refusing to overwrite it`,
          );
        }
        if (existing && existing.decimals !== item.decimals) {
          throw new Error(
            `${item.symbol} has decimals=${existing.decimals} on ${item.network}; expected ${item.decimals}`,
          );
        }
        if (!existing) {
          await assets.upsertTokenContract(item.symbol, {
            network: item.network,
            tokenAddress: item.address,
            decimals: item.decimals,
            minWithdrawalAmount: '0',
            withdrawalFeeAmount: '0',
          });
        }
        if (
          !existing?.contractVerifiedAt ||
          !existing.contractCodeHash ||
          existing.verifiedChainId !== item.chainId
        ) {
          await verifyContractWithBackoff(assets, item.symbol, item.network);
        }
        const verified = await prisma.tokenContract.findFirstOrThrow({
          where: {
            asset: { symbol: item.symbol },
            network: { chainKey: item.network },
            standard: 'ERC20',
          },
        });
        await prisma.tokenContract.update({
          where: { id: verified.id },
          data: {
            depositEnabled: false,
            withdrawalEnabled: false,
            metadata: {
              purpose: 'SPOT_CONVERT',
              source: '1inch-token-api-v1.5',
              providerVerified: true,
              providerQuoteRoundTripVerified: true,
              providerChainId: item.chainId,
            },
          },
        });
        if (item.logoURI) {
          await prisma.asset.updateMany({
            where: { symbol: item.symbol, iconUrl: null },
            data: { iconUrl: item.logoURI },
          });
        }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Spot apply failed for ${item.symbol} on ${item.network}: ${message}`);
        }
      }
    }

    process.stdout.write(`${JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      required: minimumAssets,
      verified: manifest.length,
      networks: NETWORK_PREFERENCE,
      manifest,
      rejected,
    }, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

function selectCandidates(
  symbol: string,
  existing: Array<{ network: string; address: string | null }>,
  lists: Map<string, ProviderToken[]>,
) {
  const candidates: Array<{ network: string; token: ProviderToken }> = [];
  for (const network of NETWORK_PREFERENCE) {
    const matches = (lists.get(network) ?? []).filter(
      (token) => token.symbol.toUpperCase() === symbol && token.address,
    );
    if (matches.length === 1) candidates.push({ network, token: matches[0]! });
    if (matches.length > 1) {
      const current = existing.find((contract) => contract.network === network && contract.address);
      const matched = current
        ? matches.find((token) => token.address.toLowerCase() === current.address)
        : undefined;
      if (matched) candidates.push({ network, token: matched });
    }
  }
  return candidates;
}

async function loadTokenList(apiKey: string, chainId: number): Promise<ProviderToken[]> {
  const url = new URL(`https://api.1inch.com/token/v1.5/${chainId}/token-list`);
  const response = await fetchWithRetry(url, apiKey);
  const body = await response.json() as { tokens?: ProviderToken[] };
  return body.tokens ?? [];
}

async function loadTrustedToken(
  apiKey: string,
  symbol: string,
  network: string,
  expectedAddress: string,
): Promise<ProviderToken> {
  const chainId = NETWORKS[network]!.chainId;
  const url = new URL(`https://api.1inch.com/token/v1.5/${chainId}/search`);
  url.searchParams.set('query', symbol);
  url.searchParams.set('only_positive_rating', 'true');
  url.searchParams.set('limit', '50');
  const response = await fetchWithRetry(url, apiKey);
  const body = await response.json() as ProviderToken[];
  const matches = body.filter((item) =>
    Number(item.chainId) === chainId &&
    item.symbol.toUpperCase() === symbol &&
    item.address.toLowerCase() === expectedAddress.toLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(`${symbol} contract is not a unique positive-rated 1inch result on ${network}`);
  }
  const token = matches[0]!;
  if (token.address.toLowerCase() === ONEINCH_NATIVE_PLACEHOLDER) {
    throw new Error(`${symbol} resolves to a native placeholder, not an ERC20 contract`);
  }
  if (token.blacklisted === true || token.isFoT === true) {
    throw new Error(`${symbol} is blacklisted or fee-on-transfer according to 1inch`);
  }
  if (!Array.isArray(token.providers) || !token.providers.includes('1inch')) {
    throw new Error(`${symbol} is not in the 1inch provider allowlist`);
  }
  return token;
}

async function assertRoundTripQuotes(
  apiKey: string,
  network: string,
  token: ProviderToken,
) {
  const config = NETWORKS[network]!;
  for (const stableAmount of ['1', '100']) {
    const rawStable = BigInt(stableAmount) * 10n ** BigInt(config.usdcDecimals);
    const forward = await quote(apiKey, config.chainId, config.usdc, token.address, rawStable);
    if (forward <= 0n) throw new Error(`${token.symbol} has no ${stableAmount} USDC buy quote`);
    const reverse = await quote(apiKey, config.chainId, token.address, config.usdc, forward);
    if (reverse <= 0n) throw new Error(`${token.symbol} has no ${stableAmount} USDC sell quote`);
    await sleep(1_100);
  }
}

async function quote(
  apiKey: string,
  chainId: number,
  source: string,
  destination: string,
  amount: bigint,
): Promise<bigint> {
  const configuredBase = (process.env.ONEINCH_BASE_URL ?? 'https://api.1inch.com').replace(/\/$/, '');
  const base = configuredBase.includes('/swap/') ? configuredBase : `${configuredBase}/swap/v6.1`;
  const url = new URL(`${base}/${chainId}/quote`);
  url.searchParams.set('src', source);
  url.searchParams.set('dst', destination);
  url.searchParams.set('amount', amount.toString());
  const response = await fetchWithRetry(url, apiKey);
  const body = await response.json() as { dstAmount?: string };
  return body.dstAmount ? BigInt(body.dstAmount) : 0n;
}

async function fetchWithRetry(url: URL, apiKey: string): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    });
    if (response.ok) return response;
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 4) {
      const body = await response.text();
      throw new Error(`1inch HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    await sleep(1_200 * 2 ** attempt);
  }
  throw new Error('1inch request failed');
}

function numericArg(name: string, fallback: number): number {
  const entry = process.argv.find((value) => value.startsWith(`${name}=`));
  const separateIndex = process.argv.indexOf(name);
  const raw = entry
    ? entry.slice(name.length + 1)
    : separateIndex >= 0
      ? process.argv[separateIndex + 1]
      : String(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyContractWithBackoff(
  assets: AssetsService,
  symbol: string,
  network: string,
): Promise<void> {
  const maximumAttempts = 6;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      await assets.verifyContract(symbol, network);
      await sleep(250);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /429|rate limit|too many requests|limit exceeded/i.test(message);
      if (!retryable || attempt === maximumAttempts - 1) throw error;
      await sleep(Math.min(30_000, 2_000 * (2 ** attempt)));
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
