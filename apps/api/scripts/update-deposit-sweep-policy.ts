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
  return fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'content-type': 'application/json',
      'privy-app-id': appId,
      ...(init?.headers ?? {}),
    },
  });
}

function erc20TransferRule(input: {
  name: string;
  chainId: string;
  tokenAddress: string;
  treasuryAddress: string;
}) {
  return {
    name: input.name,
    method: 'eth_sendTransaction',
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
    action: 'ALLOW',
  };
}

async function main() {
  const policyId = process.env.PRIVY_DEPOSIT_SWEEP_POLICY_ID!;
  const treasury = process.env.DEPOSIT_TREASURY_ADDRESS!;
  const rules = [
    erc20TransferRule({
      name: 'Allow BNB USDT sweep to treasury',
      chainId: '56',
      tokenAddress: '0x55d398326f99059fF775485246999027B3197955',
      treasuryAddress: treasury,
    }),
    erc20TransferRule({
      name: 'Allow Arbitrum USDT sweep to treasury',
      chainId: '42161',
      tokenAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      treasuryAddress: treasury,
    }),
  ];

  for (const rule of rules) {
    const response = await privyFetch(`/policies/${policyId}/rules`, {
      method: 'POST',
      body: JSON.stringify(rule),
    });
    const text = await response.text();
    console.log(`Create ${rule.name}:`, response.status, text);
    if (!response.ok) {
      process.exitCode = 1;
    }
  }
}

main().catch(console.error);
