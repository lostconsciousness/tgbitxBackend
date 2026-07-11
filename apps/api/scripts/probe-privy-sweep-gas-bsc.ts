import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';

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

function authPrivateKey(): string {
  const encoded = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64!;
  if (encoded.startsWith('wallet-auth:')) {
    return encoded.slice('wallet-auth:'.length);
  }
  return encoded;
}

async function main() {
  const appId = process.env.PRIVY_APP_ID!;
  const appSecret = process.env.PRIVY_APP_SECRET!;
  const apiUrl = (process.env.PRIVY_API_URL ?? 'https://api.privy.io/v1').replace(/\/+$/, '');
  const policyId = process.env.PRIVY_SWEEP_GAS_POLICY_ID!;
  const walletId = process.env.PRIVY_SWEEP_GAS_WALLET_ID!;

  const policyRes = await fetch(`${apiUrl}/policies/${policyId}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'privy-app-id': appId,
    },
  });
  console.log('Policy status', policyRes.status);
  console.log(await policyRes.text());

  const deposit = '0x4393bf55240855ef78f01d103ce17ee5a1227906';
  const value = '0x' + (100000000000000n).toString(16);
  const txRes = await fetch(`${apiUrl}/wallets/${walletId}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'content-type': 'application/json',
      'privy-app-id': appId,
    },
    body: JSON.stringify({
      method: 'eth_sendTransaction',
      caip2: 'eip155:56',
      chain_type: 'ethereum',
      sponsor: false,
      authorization_context: {
        authorization_private_keys: [authPrivateKey()],
      },
      params: {
        transaction: {
          chain_id: 56,
          to: deposit,
          value,
        },
      },
    }),
  });
  console.log('\nTest BSC send status', txRes.status);
  console.log(await txRes.text());
}

main().catch(console.error);
