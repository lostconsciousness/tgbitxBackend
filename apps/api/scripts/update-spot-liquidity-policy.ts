import 'dotenv/config';
import { PrismaClient, TokenStandard } from '@prisma/client';
import { generateAuthorizationSignature } from '@privy-io/node';

const prisma = new PrismaClient();
const CHAINS: Record<string, { chainId: number; maxNativeWei: string }> = {
  ethereum: { chainId: 1, maxNativeWei: '100000000000000000' },
  bnb: { chainId: 56, maxNativeWei: '1000000000000000000' },
  base: { chainId: 8453, maxNativeWei: '50000000000000000' },
  arbitrum: { chainId: 42161, maxNativeWei: '50000000000000000' },
  optimism: { chainId: 10, maxNativeWei: '50000000000000000' },
};

type Rule = {
  name: string;
  method: 'eth_sendTransaction' | 'eth_signTransaction';
  conditions: Array<Record<string, unknown>>;
  action: 'ALLOW';
};

async function main(): Promise<void> {
  const policyId = required('PRIVY_SPOT_LIQUIDITY_POLICY_ID');
  const minimumAssets = parseMinimumAssets();
  const routers = new Map<string, string>();
  for (const [network, chain] of Object.entries(CHAINS)) {
    routers.set(network, await loadOneInchSpender(chain.chainId));
  }
  const contracts = await prisma.tokenContract.findMany({
    where: {
      standard: TokenStandard.ERC20,
      address: { not: null },
      contractVerifiedAt: { not: null },
      network: { chainKey: { in: Object.keys(CHAINS) }, mainnet: true },
      OR: [
        { metadata: { path: ['purpose'], equals: 'SPOT_CONVERT' } },
        { asset: { symbol: { in: ['USDC', 'USDT'] } } },
      ],
    },
    include: { network: true, asset: true },
  });
  const spotConvertCount = contracts.filter((contract) =>
    isSpotConvertMetadata(contract.metadata),
  ).length;
  if (spotConvertCount < minimumAssets) {
    throw new Error(
      `Refusing policy update: only ${spotConvertCount} verified SPOT_CONVERT contracts; ` +
      `required ${minimumAssets}`,
    );
  }

  const desired = contracts.flatMap((contract) => {
    const chain = CHAINS[contract.network.chainKey]!;
    const router = routers.get(contract.network.chainKey)!;
    const maxApproval = 1_000n * 10n ** BigInt(contract.decimals);
    return (['eth_sendTransaction', 'eth_signTransaction'] as const).map((method) => ({
      name: `Spot ${contract.network.chainKey} ${contract.asset.symbol} approve ${method}`,
      method,
      conditions: [
        condition('ethereum_transaction', 'chain_id', 'eq', String(chain.chainId)),
        condition('ethereum_transaction', 'to', 'eq', contract.address!),
        condition('ethereum_transaction', 'value', 'eq', '0x0'),
        {
          ...condition('ethereum_calldata', 'approve.spender', 'eq', router),
          abi: [{
            type: 'function',
            name: 'approve',
            inputs: [
              { name: 'spender', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          }],
        },
        {
          ...condition('ethereum_calldata', 'approve.amount', 'lte', `0x${maxApproval.toString(16)}`),
          abi: [{
            type: 'function',
            name: 'approve',
            inputs: [
              { name: 'spender', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          }],
        },
      ],
      action: 'ALLOW' as const,
    }));
  });
  for (const [network, chain] of Object.entries(CHAINS)) {
    const router = routers.get(network)!;
    for (const method of ['eth_sendTransaction', 'eth_signTransaction'] as const) {
      desired.push({
        name: `Spot ${network} 1inch router ${method}`,
        method,
        conditions: [
          condition('ethereum_transaction', 'chain_id', 'eq', String(chain.chainId)),
          condition('ethereum_transaction', 'to', 'eq', router),
          condition('ethereum_transaction', 'value', 'lte', `0x${BigInt(chain.maxNativeWei).toString(16)}`),
        ],
        action: 'ALLOW',
      });
    }
  }

  const policy = await privyFetch(`/policies/${policyId}`);
  const existing = Array.isArray(policy.rules) ? policy.rules as Array<{ id?: string; name?: string }> : [];
  for (const rule of desired) {
    const current = existing.find((item) => item.name === rule.name);
    if (current?.id) {
      await privyFetch(`/policies/${policyId}/rules/${current.id}`, {
        method: 'PATCH',
        body: JSON.stringify(rule),
      });
    } else {
      await privyFetch(`/policies/${policyId}/rules`, {
        method: 'POST',
        body: JSON.stringify(rule),
      });
    }
  }
  console.log(JSON.stringify({
    policyUpdated: true,
    minimumAssets,
    spotConvertCount,
    contractCount: contracts.length,
    ruleCount: desired.length,
  }));
}

function isSpotConvertMetadata(metadata: unknown): boolean {
  return Boolean(
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).purpose === 'SPOT_CONVERT',
  );
}

function parseMinimumAssets(): number {
  const inline = process.argv.find((value) => value.startsWith('--min-assets='));
  const argumentIndex = process.argv.indexOf('--min-assets');
  const raw = inline
    ? inline.slice('--min-assets='.length)
    : argumentIndex >= 0
      ? process.argv[argumentIndex + 1]
      : process.env.SPOT_ONBOARDING_MIN_ASSETS ?? '75';
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('SPOT_ONBOARDING_MIN_ASSETS/--min-assets must be a positive integer');
  }
  return value;
}

async function loadOneInchSpender(chainId: number): Promise<string> {
  const apiKey = required('ONEINCH_API_KEY');
  const configured = (process.env.ONEINCH_BASE_URL ?? 'https://api.1inch.com/swap/v6.1').replace(/\/$/, '');
  const base = configured.includes('/swap/') ? configured : `${configured}/swap/v6.1`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${base}/${chainId}/approve/spender`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    });
    const body = await response.json().catch(() => ({})) as { address?: string };
    if (response.ok && body.address && /^0x[a-fA-F0-9]{40}$/.test(body.address)) {
      await sleep(1_100);
      return body.address;
    }
    if (response.status !== 429 || attempt === 4) {
      throw new Error(`Could not pin verified 1inch spender for chain ${chainId} (${response.status})`);
    }
    const retryAfter = Number(response.headers.get('retry-after') ?? '1');
    await sleep(Math.max(1_100, Number.isFinite(retryAfter) ? retryAfter * 1_000 : 1_100));
  }
  throw new Error(`Could not pin verified 1inch spender for chain ${chainId}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function condition(fieldSource: string, field: string, operator: string, value: string) {
  return { field_source: fieldSource, field, operator, value };
}

async function privyFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const appId = required('PRIVY_APP_ID');
  const secret = required('PRIVY_APP_SECRET');
  const base = (process.env.PRIVY_API_URL ?? 'https://api.privy.io/v1').replace(/\/$/, '');
  const url = `${base}${path}`;
  const method = (init?.method ?? 'GET').toUpperCase();
  const privyHeaders: Record<string, string> = { 'privy-app-id': appId };
  if (method !== 'GET') {
    const rawKey = required('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64');
    const authorizationPrivateKey = rawKey.startsWith('wallet-auth:')
      ? rawKey.slice('wallet-auth:'.length)
      : rawKey;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    privyHeaders['privy-authorization-signature'] = generateAuthorizationSignature({
      input: {
        version: 1,
        url,
        method: method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        headers: { 'privy-app-id': appId },
        body,
      },
      authorizationPrivateKey,
    });
  }
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}`,
      'content-type': 'application/json',
      ...privyHeaders,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Privy policy request failed (${response.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
