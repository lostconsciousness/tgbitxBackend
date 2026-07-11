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

async function main() {
  const appId = process.env.PRIVY_APP_ID!;
  const appSecret = process.env.PRIVY_APP_SECRET!;
  const apiUrl = (process.env.PRIVY_API_URL ?? 'https://api.privy.io/v1').replace(/\/+$/, '');
  const policyId = process.env.PRIVY_SWEEP_GAS_POLICY_ID!;
  const ruleId = process.argv[2] ?? 'mw6z10xi74qpsrgo2g3h3wn8';
  const maxTopupHex = process.env.SWEEP_GAS_MAX_TOPUP_WEI
    ? '0x' + BigInt(process.env.SWEEP_GAS_MAX_TOPUP_WEI).toString(16)
    : '0x38D7EA4C68000';

  const body = {
    name: 'Allow small gas topups on mainnet EVM chains',
    method: 'eth_sendTransaction',
    conditions: [
      {
        field_source: 'ethereum_transaction',
        field: 'chain_id',
        operator: 'in',
        value: ['1', '56', '42161'],
      },
      {
        field_source: 'ethereum_transaction',
        field: 'value',
        operator: 'lte',
        value: maxTopupHex,
      },
    ],
    action: 'ALLOW',
  };

  const response = await fetch(`${apiUrl}/policies/${policyId}/rules/${ruleId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'content-type': 'application/json',
      'privy-app-id': appId,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  console.log('status', response.status);
  console.log(text);
  if (!response.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
