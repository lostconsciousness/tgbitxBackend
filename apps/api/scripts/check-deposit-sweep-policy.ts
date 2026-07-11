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
  const policyId = process.env.PRIVY_DEPOSIT_SWEEP_POLICY_ID!;
  const treasury = (process.env.DEPOSIT_TREASURY_ADDRESS ?? '').toLowerCase();

  const response = await fetch(`${apiUrl}/policies/${policyId}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'privy-app-id': appId,
    },
  });
  console.log('DEPOSIT_SWEEP policy', response.status);
  console.log(await response.text());
  console.log('\nTreasury in env:', treasury);
}

main().catch(console.error);
