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
    // keep raw text
  }
  if (!response.ok) {
    throw new Error(`Privy ${path} failed (${response.status}): ${text}`);
  }
  return body as Record<string, unknown>;
}

async function ensureSignTransactionRule(policyId: string, label: string) {
  const policy = await privyFetch(`/policies/${policyId}`);
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const existing = rules.find(
    (rule) =>
      typeof rule === 'object' &&
      rule &&
      (rule as { method?: string }).method === 'eth_signTransaction',
  ) as { id?: string } | undefined;

  const body = {
    name: `Allow ${label} BNB signTransaction`,
    method: 'eth_signTransaction',
    conditions: [
      {
        field_source: 'ethereum_transaction',
        field: 'chain_id',
        operator: 'eq',
        value: '56',
      },
    ],
    action: 'ALLOW',
  };

  if (existing?.id) {
    console.log(`Updating eth_signTransaction rule ${existing.id} on policy ${policyId}`);
    await privyFetch(`/policies/${policyId}/rules/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return;
  }

  console.log(`Creating eth_signTransaction rule on policy ${policyId}`);
  await privyFetch(`/policies/${policyId}/rules`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function main() {
  const walletIds = [
    { env: 'PRIVY_SERVER_WALLET_ID', label: 'withdrawal hot' },
    { env: 'PRIVY_DEPOSIT_TREASURY_WALLET_ID', label: 'deposit treasury' },
    { env: 'PRIVY_SWEEP_GAS_WALLET_ID', label: 'sweep gas' },
  ];

  for (const target of walletIds) {
    const walletId = process.env[target.env];
    if (!walletId) {
      console.log(`Skip ${target.label}: ${target.env} is not set`);
      continue;
    }
    const wallet = await privyFetch(`/wallets/${walletId}`);
    const policyIds = Array.isArray(wallet.policy_ids) ? wallet.policy_ids : [];
    if (policyIds.length === 0) {
      console.log(`Skip ${target.label}: wallet ${walletId} has no policy_ids`);
      continue;
    }
    for (const policyId of policyIds) {
      if (typeof policyId !== 'string') continue;
      await ensureSignTransactionRule(policyId, target.label);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
