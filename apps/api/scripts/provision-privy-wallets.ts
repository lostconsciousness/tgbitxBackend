import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createECDH, createPrivateKey, createPublicKey } from 'node:crypto';

type PrivyWallet = {
  id: string;
  address: string;
  chain_type?: string;
  display_name?: string;
};

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '../../.env'));

const appId = required('PRIVY_APP_ID');
const appSecret = required('PRIVY_APP_SECRET');
const apiUrl = (process.env.PRIVY_API_URL ?? 'https://api.privy.io/v1').replace(/\/+$/, '');

async function main(): Promise<void> {
  const deposit = await createWallet({
    displayName: 'Deposit treasury',
    externalId: 'deposit_treasury',
    idempotencyKey: 'dream-exchange-deposit-treasury-v1',
  });
  const withdrawal = await createWallet({
    displayName: 'Withdrawal hot wallet',
    externalId: 'withdrawal_hot_wallet',
    idempotencyKey: 'dream-exchange-withdrawal-hot-v1',
  });
  const sweepGasPolicyId = process.env.PRIVY_SWEEP_GAS_POLICY_ID;
  const sweepGas = sweepGasPolicyId
    ? await createWallet({
        displayName: 'Deposit sweep gas',
        externalId: 'deposit_sweep_gas',
        idempotencyKey: 'dream-exchange-deposit-sweep-gas-v1',
        policyId: sweepGasPolicyId,
        ownerPublicKey: authorizationPublicKey(),
      })
    : null;
  const capitalPolicyId = process.env.PRIVY_PLATFORM_CAPITAL_POLICY_ID;
  const insurancePolicyId = process.env.PRIVY_INSURANCE_POLICY_ID;
  const spotLiquidityPolicyId = process.env.PRIVY_SPOT_LIQUIDITY_POLICY_ID;
  const spotLiquidity = spotLiquidityPolicyId
    ? await createWallet({
        displayName: 'Spot liquidity reserve',
        externalId: 'spot_liquidity_reserve',
        idempotencyKey: 'dream-exchange-spot-liquidity-v1',
        policyId: spotLiquidityPolicyId,
        ownerPublicKey: authorizationPublicKey(),
      })
    : null;
  const platformCapital = capitalPolicyId
    ? await createWallet({
        displayName: 'B-book platform capital',
        externalId: 'bbook_platform_capital',
        idempotencyKey: 'dream-exchange-bbook-platform-capital-v1',
        policyId: capitalPolicyId,
        ownerPublicKey: authorizationPublicKey(),
      })
    : null;
  const insurance = insurancePolicyId
    ? await createWallet({
        displayName: 'B-book insurance reserve',
        externalId: 'bbook_insurance_reserve',
        idempotencyKey: 'dream-exchange-bbook-insurance-v1',
        policyId: insurancePolicyId,
        ownerPublicKey: authorizationPublicKey(),
      })
    : null;

  console.log('');
  console.log('Privy wallets created or recovered by idempotency key.');
  console.log('Add these non-secret values to apps/api/.env:');
  console.log('');
  console.log(`PRIVY_DEPOSIT_TREASURY_WALLET_ID=${deposit.id}`);
  console.log(`DEPOSIT_TREASURY_ADDRESS=${deposit.address}`);
  console.log(`PRIVY_SERVER_WALLET_ID=${withdrawal.id}`);
  console.log(`WITHDRAWAL_HOT_ADDRESS=${withdrawal.address}`);
  if (sweepGas) {
    console.log(`PRIVY_SWEEP_GAS_WALLET_ID=${sweepGas.id}`);
    console.log(`SWEEP_GAS_ADDRESS=${sweepGas.address}`);
  } else {
    console.log('');
    console.log('Sweep gas wallet skipped: set PRIVY_SWEEP_GAS_POLICY_ID first.');
  }
  if (platformCapital && insurance) {
    console.log(`PRIVY_PLATFORM_CAPITAL_WALLET_ID=${platformCapital.id}`);
    console.log(`PLATFORM_CAPITAL_ADDRESS=${platformCapital.address}`);
    console.log(`PRIVY_INSURANCE_WALLET_ID=${insurance.id}`);
    console.log(`INSURANCE_ADDRESS=${insurance.address}`);
  } else {
    console.log('B-book custody wallets skipped: set both capital/insurance policy IDs first.');
  }
  if (spotLiquidity) {
    console.log(`PRIVY_SPOT_LIQUIDITY_WALLET_ID=${spotLiquidity.id}`);
    console.log(`SPOT_LIQUIDITY_ADDRESS=${spotLiquidity.address}`);
  } else {
    console.log('Spot liquidity wallet skipped: set PRIVY_SPOT_LIQUIDITY_POLICY_ID first.');
  }
  console.log('');
  console.log('The app secret was not printed or persisted by this script.');
}

async function createWallet(input: {
  displayName: string;
  externalId: string;
  idempotencyKey: string;
  policyId?: string;
  ownerPublicKey?: string;
}): Promise<PrivyWallet> {
  const existing = await findWallet(input.externalId);
  if (existing) {
    return existing;
  }
  const response = await fetch(`${apiUrl}/wallets`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'content-type': 'application/json',
      'privy-app-id': appId,
      'privy-idempotency-key': input.idempotencyKey,
    },
    body: JSON.stringify({
      chain_type: 'ethereum',
      display_name: input.displayName,
      external_id: input.externalId,
      ...(input.policyId ? { policy_ids: [input.policyId] } : {}),
      ...(input.ownerPublicKey
        ? { owner: { public_key: input.ownerPublicKey } }
        : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<PrivyWallet> & {
    message?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      `Privy wallet creation failed (${response.status}): ${
        body.message ?? body.error ?? 'unknown error'
      }`,
    );
  }
  if (!body.id || !body.address) {
    throw new Error('Privy response did not include wallet id and address');
  }
  return {
    id: body.id,
    address: body.address.toLowerCase(),
    chain_type: body.chain_type,
    display_name: body.display_name,
  };
}

async function findWallet(externalId: string): Promise<PrivyWallet | null> {
  const response = await fetch(
    `${apiUrl}/wallets?chain_type=ethereum&external_id=${encodeURIComponent(externalId)}`,
    {
      headers: {
        authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
        'privy-app-id': appId,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Privy wallet lookup failed (${response.status})`);
  }
  const body = (await response.json()) as {
    data?: PrivyWallet[];
    wallets?: PrivyWallet[];
  };
  const wallet = [...(body.data ?? []), ...(body.wallets ?? [])].find(
    (candidate) => candidate.id && candidate.address,
  );
  return wallet
    ? { ...wallet, address: wallet.address.toLowerCase() }
    : null;
}

function authorizationPublicKey(): string {
  const encoded = required('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64');
  const privateKeyMaterial = encoded.startsWith('wallet-auth:')
    ? encoded.slice('wallet-auth:'.length)
    : encoded;
  const decoded = Buffer.from(privateKeyMaterial, 'base64');
  try {
    const text = decoded.toString('utf8');
    const privateKey = text.includes('BEGIN PRIVATE KEY')
      ? createPrivateKey(text)
      : createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
    return createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
  } catch (_error) {
    return deriveP256PublicKeyFromPkcs8Bytes(decoded);
  }
}

function deriveP256PublicKeyFromPkcs8Bytes(pkcs8Bytes: Buffer): string {
  const privateKeyStart = pkcs8Bytes.indexOf(Buffer.from([0x04, 0x20]));
  if (privateKeyStart === -1) {
    throw new Error('Privy authorization private key is invalid');
  }
  const privateKeyBytes = pkcs8Bytes.subarray(privateKeyStart + 2, privateKeyStart + 34);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privateKeyBytes);
  const publicKey = ecdh.getPublicKey();
  const spkiP256Header = Buffer.from(
    '3059301306072a8648ce3d020106082a8648ce3d030107034200',
    'hex',
  );
  return Buffer.concat([spkiP256Header, publicKey]).toString('base64');
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator < 1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is empty. Add a newly generated value to H:\\work\\dreamCryptoExchange\\apps\\api\\.env, then run the command again.`,
    );
  }
  return value;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
