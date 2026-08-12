import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(resolve(process.cwd(), '.env'));

async function privyFetch(path: string, init?: RequestInit) {
  const appId = process.env.PRIVY_APP_ID!;
  const appSecret = process.env.PRIVY_APP_SECRET!;
  const apiUrl = (process.env.PRIVY_API_URL ?? 'https://api.privy.io/v1').replace(/\/+$/, '');
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'content-type': 'application/json',
      'privy-app-id': appId,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch (_error) {
    // Keep the provider response for a useful, non-secret error message.
  }
  if (!response.ok) {
    throw new Error(`Privy ${path} failed (${response.status}): ${text}`);
  }
  return body as Record<string, unknown>;
}

function erc20TransferRule(input: {
  name: string;
  method: 'eth_sendTransaction' | 'eth_signTransaction';
  chainId: string;
  tokenAddress: string;
  treasuryAddress: string;
}) {
  return {
    name: input.name,
    method: input.method,
    conditions: [
      {
        field_source: 'ethereum_transaction',
        field: 'chain_id',
        operator: 'eq',
        value: input.chainId,
      },
      {
        field_source: 'ethereum_transaction',
        field: 'to',
        operator: 'eq',
        value: input.tokenAddress,
      },
      {
        field_source: 'ethereum_transaction',
        field: 'value',
        operator: 'eq',
        value: '0x0',
      },
      {
        field_source: 'ethereum_calldata',
        field: 'transfer.recipient',
        abi: [
          {
            type: 'function',
            name: 'transfer',
            inputs: [
              { name: 'recipient', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
        ],
        operator: 'eq',
        value: input.treasuryAddress,
      },
    ],
    action: 'ALLOW' as const,
  };
}

type PrivyRule = {
  id?: string;
  name?: string;
  method?: string;
  conditions?: Array<{ field?: string; value?: string }>;
};

type DesiredRule = {
  name: string;
  method: 'eth_sendTransaction' | 'eth_signTransaction';
  conditions: Array<{
    field_source: string;
    field: string;
    operator: string;
    value: string;
    abi?: Array<Record<string, unknown>>;
  }>;
  action: 'ALLOW';
};

function matchesTransferRule(existing: PrivyRule, expected: DesiredRule) {
  if (existing.method !== expected.method) return false;
  const expectedTo = expected.conditions.find((condition) => condition.field === 'to')?.value;
  return existing.conditions?.some(
    (condition) =>
      condition.field === 'to' &&
      condition.value?.toLowerCase() === expectedTo?.toLowerCase(),
  );
}

async function ensureRule(
  policyId: string,
  existingRules: PrivyRule[],
  rule: DesiredRule,
) {
  const existing = existingRules.find((candidate) => matchesTransferRule(candidate, rule)) ??
    existingRules.find((candidate) => candidate.name === rule.name);
  if (existing?.id) {
    await privyFetch(`/policies/${policyId}/rules/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify(rule),
    });
    console.log(`Verified ${rule.name}`);
    return;
  }
  await privyFetch(`/policies/${policyId}/rules`, {
    method: 'POST',
    body: JSON.stringify(rule),
  });
  console.log(`Created ${rule.name}`);
}

function nativeBnbSweepRule(treasuryAddress: string): DesiredRule {
  return {
    name: 'BNB native sweep to treasury',
    method: 'eth_signTransaction',
    conditions: [
      {
        field_source: 'ethereum_transaction',
        field: 'chain_id',
        operator: 'eq',
        value: '56',
      },
      {
        field_source: 'ethereum_transaction',
        field: 'to',
        operator: 'eq',
        value: treasuryAddress,
      },
      {
        field_source: 'ethereum_transaction',
        field: 'value',
        operator: 'gt',
        value: '0x0',
      },
    ],
    action: 'ALLOW',
  };
}

async function main() {
  const policyId = process.env.PRIVY_DEPOSIT_SWEEP_POLICY_ID!;
  const treasury = process.env.DEPOSIT_TREASURY_ADDRESS!;
  if (!policyId || !treasury) {
    throw new Error('PRIVY_DEPOSIT_SWEEP_POLICY_ID and DEPOSIT_TREASURY_ADDRESS are required');
  }
  const bnbTokens = [
    {
      symbol: 'USDC',
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    },
    {
      symbol: 'USDT',
      address: '0x55d398326f99059fF775485246999027B3197955',
    },
  ];
  const rules = [
    nativeBnbSweepRule(treasury),
    ...bnbTokens.flatMap(({ symbol, address }) =>
      (['eth_sendTransaction', 'eth_signTransaction'] as const).map((method) =>
        erc20TransferRule({
          name: `BNB ${symbol} sweep (${method === 'eth_signTransaction' ? 'sign' : 'send'})`,
          method,
          chainId: '56',
          tokenAddress: address,
          treasuryAddress: treasury,
        }),
      ),
    ),
    erc20TransferRule({
      name: 'Allow Arbitrum USDT sweep to treasury',
      method: 'eth_sendTransaction',
      chainId: '42161',
      tokenAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      treasuryAddress: treasury,
    }),
  ] satisfies DesiredRule[];

  const policy = await privyFetch(`/policies/${policyId}`);
  const existingRules = Array.isArray(policy.rules) ? policy.rules as PrivyRule[] : [];
  for (const rule of rules) {
    await ensureRule(policyId, existingRules, rule);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
