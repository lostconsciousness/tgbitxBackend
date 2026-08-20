import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RULE_NAME = 'Allow Hyperliquid Bridge USDC';
const ARBITRUM_CHAIN_ID = '42161';
const NATIVE_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const HYPERLIQUID_BRIDGE = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
const MAX_AMOUNT_RAW = '248744945';

loadEnv(resolve(process.cwd(), '.env'));

async function main(): Promise<void> {
  const policyId = required('PRIVY_HYPERLIQUID_MASTER_POLICY_ID');
  const policy = await privyFetch(`/policies/${policyId}`) as {
    rules?: Array<{ id?: string; name?: string; method?: string }>;
  };
  const existing = (policy.rules ?? []).find(
    (rule) => rule.name === RULE_NAME && rule.method === 'eth_sendTransaction',
  );
  if (process.argv.includes('--delete')) {
    if (!existing?.id) {
      console.log(`${RULE_NAME} is already absent`);
      return;
    }
    await privyFetch(`/policies/${policyId}/rules/${existing.id}`, { method: 'DELETE' });
    const verified = await privyFetch(`/policies/${policyId}`) as {
      rules?: Array<{ name?: string; method?: string }>;
    };
    if ((verified.rules ?? []).some(
      (rule) => rule.name === RULE_NAME && rule.method === 'eth_sendTransaction',
    )) {
      throw new Error(`${RULE_NAME} still exists after delete`);
    }
    console.log(`Deleted and verified absent: ${RULE_NAME}`);
    return;
  }
  const rule = {
    name: RULE_NAME,
    method: 'eth_sendTransaction',
    conditions: [
      {
        field_source: 'ethereum_transaction',
        field: 'chain_id',
        operator: 'eq',
        value: ARBITRUM_CHAIN_ID,
      },
      {
        field_source: 'ethereum_transaction',
        field: 'to',
        operator: 'eq',
        value: NATIVE_USDC,
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
        abi: erc20TransferAbi(),
        operator: 'eq',
        value: HYPERLIQUID_BRIDGE,
      },
      {
        field_source: 'ethereum_calldata',
        field: 'transfer.amount',
        abi: erc20TransferAbi(),
        operator: 'lte',
        value: MAX_AMOUNT_RAW,
      },
    ],
    action: 'ALLOW',
  };
  if (existing?.id) {
    await privyFetch(`/policies/${policyId}/rules/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify(rule),
    });
    console.log(`Verified ${RULE_NAME}`);
    return;
  }
  await privyFetch(`/policies/${policyId}/rules`, {
    method: 'POST',
    body: JSON.stringify(rule),
  });
  console.log(`Created ${RULE_NAME}`);
}

function erc20TransferAbi() {
  return [{
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address', internalType: 'address' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  }];
}

async function privyFetch(path: string, init?: RequestInit): Promise<unknown> {
  const appId = required('PRIVY_APP_ID');
  const appSecret = required('PRIVY_APP_SECRET');
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
  if (!response.ok) throw new Error(`Privy policy update failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Hyperliquid bridge policy update failed');
  process.exitCode = 1;
});
