import { createECDH, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PrivyPolicy = {
  id: string;
  name: string;
  chain_type: string;
  rules?: unknown[];
};

type PrivyWallet = {
  id: string;
  address: string;
  chain_type: string;
  external_id?: string;
  policy_ids?: string[];
};

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), 'apps/api/.env'));

const appId = required('PRIVY_APP_ID');
const appSecret = required('PRIVY_APP_SECRET');
const apiUrl = (process.env.PRIVY_API_URL ?? 'https://api.privy.io/v1').replace(/\/+$/, '');
const ownerPublicKey = authorizationPublicKey();

async function main(): Promise<void> {
  const platformPolicy = await ensurePolicy({
    configuredId: process.env.PRIVY_PLATFORM_CAPITAL_POLICY_ID,
    name: 'B-book platform capital custody',
    idempotencyKey: 'dream-exchange-bbook-platform-policy-v1',
  });
  const insurancePolicy = await ensurePolicy({
    configuredId: process.env.PRIVY_INSURANCE_POLICY_ID,
    name: 'B-book insurance custody',
    idempotencyKey: 'dream-exchange-bbook-insurance-policy-v1',
  });
  if (platformPolicy.id === insurancePolicy.id) {
    throw new Error('Platform capital and insurance must use separate Privy policies');
  }

  const platformWallet = await ensureWallet({
    configuredId: process.env.PRIVY_PLATFORM_CAPITAL_WALLET_ID,
    policyId: platformPolicy.id,
    displayName: 'B-book platform capital',
    externalId: 'bbook_platform_capital',
    idempotencyKey: 'dream-exchange-bbook-platform-capital-v1',
  });
  const insuranceWallet = await ensureWallet({
    configuredId: process.env.PRIVY_INSURANCE_WALLET_ID,
    policyId: insurancePolicy.id,
    displayName: 'B-book insurance reserve',
    externalId: 'bbook_insurance_reserve',
    idempotencyKey: 'dream-exchange-bbook-insurance-v1',
  });
  if (platformWallet.address.toLowerCase() === insuranceWallet.address.toLowerCase()) {
    throw new Error('Platform capital and insurance must use separate Privy wallets');
  }

  console.log(`PRIVY_PLATFORM_CAPITAL_POLICY_ID=${platformPolicy.id}`);
  console.log(`PRIVY_PLATFORM_CAPITAL_WALLET_ID=${platformWallet.id}`);
  console.log(`PLATFORM_CAPITAL_ADDRESS=${platformWallet.address.toLowerCase()}`);
  console.log(`PRIVY_INSURANCE_POLICY_ID=${insurancePolicy.id}`);
  console.log(`PRIVY_INSURANCE_WALLET_ID=${insuranceWallet.id}`);
  console.log(`INSURANCE_ADDRESS=${insuranceWallet.address.toLowerCase()}`);
}

async function ensurePolicy(input: {
  configuredId?: string;
  name: string;
  idempotencyKey: string;
}): Promise<PrivyPolicy> {
  const policy = input.configuredId
    ? await privyFetch<PrivyPolicy>(`/policies/${input.configuredId}`)
    : await privyFetch<PrivyPolicy>('/policies', {
        method: 'POST',
        headers: { 'privy-idempotency-key': input.idempotencyKey },
        body: JSON.stringify({
          version: '1.0',
          name: input.name,
          chain_type: 'ethereum',
          // An attached policy defaults to DENY when no rule matches. These
          // receive-only reserves therefore cannot sign or export by default.
          rules: [],
          owner: { public_key: ownerPublicKey },
        }),
      });
  if (!policy.id || policy.chain_type !== 'ethereum') {
    throw new Error(`${input.name} policy is invalid`);
  }
  if ((policy.rules ?? []).length !== 0) {
    throw new Error(`${input.name} must remain deny-by-default until an audited outbound rule exists`);
  }
  return policy;
}

async function ensureWallet(input: {
  configuredId?: string;
  policyId: string;
  displayName: string;
  externalId: string;
  idempotencyKey: string;
}): Promise<PrivyWallet> {
  const existing = input.configuredId
    ? await privyFetch<PrivyWallet>(`/wallets/${input.configuredId}`)
    : await findWallet(input.externalId);
  const wallet = existing ?? await privyFetch<PrivyWallet>('/wallets', {
    method: 'POST',
    headers: { 'privy-idempotency-key': input.idempotencyKey },
    body: JSON.stringify({
      chain_type: 'ethereum',
      display_name: input.displayName,
      external_id: input.externalId,
      policy_ids: [input.policyId],
      owner: { public_key: ownerPublicKey },
    }),
  });
  if (!wallet.id || !wallet.address || wallet.chain_type !== 'ethereum') {
    throw new Error(`${input.displayName} wallet is invalid`);
  }
  if (!(wallet.policy_ids ?? []).includes(input.policyId)) {
    throw new Error(`${input.displayName} is not bound to the expected restrictive policy`);
  }
  return wallet;
}

async function findWallet(externalId: string): Promise<PrivyWallet | null> {
  const body = await privyFetch<{ data?: PrivyWallet[]; wallets?: PrivyWallet[] }>(
    `/wallets?chain_type=ethereum&external_id=${encodeURIComponent(externalId)}`,
  );
  return [...(body.data ?? []), ...(body.wallets ?? [])].find(
    (wallet) => wallet.external_id === externalId,
  ) ?? null;
}

async function privyFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
  if (!response.ok) {
    throw new Error(`Privy custody provisioning failed (${response.status}): ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function authorizationPublicKey(): string {
  const encoded = required('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64');
  const material = encoded.startsWith('wallet-auth:')
    ? encoded.slice('wallet-auth:'.length)
    : encoded;
  const decoded = Buffer.from(material, 'base64');
  try {
    const text = decoded.toString('utf8');
    const privateKey = text.includes('BEGIN PRIVATE KEY')
      ? createPrivateKey(text)
      : createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
    return createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
  } catch (_error) {
    const marker = decoded.indexOf(Buffer.from([0x04, 0x20]));
    if (marker === -1) throw new Error('Privy authorization private key is invalid');
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(decoded.subarray(marker + 2, marker + 34));
    const spkiHeader = Buffer.from(
      '3059301306072a8648ce3d020106082a8648ce3d030107034200',
      'hex',
    );
    return Buffer.concat([spkiHeader, ecdh.getPublicKey()]).toString('base64');
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'B-book custody provisioning failed');
  process.exitCode = 1;
});
