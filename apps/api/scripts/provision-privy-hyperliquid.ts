import { createECDH, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PrivyWallet = { id: string; address: string };

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '../../.env'));

const appId = required('PRIVY_APP_ID');
const appSecret = required('PRIVY_APP_SECRET');
const authorizationKey = required('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64');
const masterPolicyId = required('PRIVY_HYPERLIQUID_MASTER_POLICY_ID');
const agentPolicyId = required('PRIVY_HYPERLIQUID_AGENT_POLICY_ID');
const configuredApiUrl = (process.env.PRIVY_API_URL ?? 'https://api.privy.io/v1')
  .replace(/\/+$/, '');
const sdkApiUrl = configuredApiUrl.replace(/\/v1$/, '');
const apiUrl = configuredApiUrl.endsWith('/v1')
  ? configuredApiUrl
  : `${configuredApiUrl}/v1`;

async function main(): Promise<void> {
  if (masterPolicyId === agentPolicyId) {
    throw new Error('Hyperliquid master and agent must use separate restrictive Privy policies');
  }
  if (process.env.MAINNET_ENABLED !== 'true' || process.env.HYPERLIQUID_TESTNET !== 'false') {
    throw new Error('Mainnet provisioning requires MAINNET_ENABLED=true and HYPERLIQUID_TESTNET=false');
  }
  await validatePolicies();

  const ownerPublicKey = authorizationPublicKey();
  const master = await createWallet({
    displayName: 'Dream Exchange Hyperliquid Master',
    externalId: 'dream_exchange_hyperliquid_master_mainnet',
    idempotencyKey: 'dream-exchange-hyperliquid-master-mainnet-v1',
    policyId: masterPolicyId,
    ownerPublicKey,
  });
  const agent = await createWallet({
    displayName: 'Dream Exchange Hyperliquid Agent',
    externalId: 'dream_exchange_hyperliquid_agent_mainnet',
    idempotencyKey: 'dream-exchange-hyperliquid-agent-mainnet-v1',
    policyId: agentPolicyId,
    ownerPublicKey,
  });

  console.log(JSON.stringify({
    walletsProvisioned: true,
    masterWalletId: master.id,
    masterAddress: master.address,
    agentWalletId: agent.id,
    agentAddress: agent.address,
    agentRegistered: false,
  }, null, 2));

  const registered = await ensureAgentRegistered(master, agent);
  if (!registered) {
    throw new Error('Hyperliquid agent registration could not be confirmed');
  }
  console.log(JSON.stringify({
    masterWalletId: master.id,
    masterAddress: master.address,
    agentWalletId: agent.id,
    agentAddress: agent.address,
    agentRegistered: registered,
  }, null, 2));
}

async function validatePolicies(): Promise<void> {
  await Promise.all([
    validateMasterPolicy(masterPolicyId),
    validatePolicy(agentPolicyId, {
      role: 'agent',
      chainId: '1337',
      primaryType: 'Agent',
      messageField: 'source',
      messageValue: 'a',
    }),
  ]);
}

async function validateMasterPolicy(policyId: string): Promise<void> {
  await validatePolicy(policyId, {
    role: 'master',
    chainId: '1',
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    messageField: 'hyperliquidChain',
    messageValue: 'Mainnet',
  });
  await validatePolicy(policyId, {
    role: 'master',
    primaryType: 'HyperliquidTransaction:UsdClassTransfer',
    messageField: 'hyperliquidChain',
    messageValue: 'Mainnet',
    chainId: '1',
  });
}

async function validatePolicy(policyId: string, expected: {
  role: 'master' | 'agent';
  chainId: string;
  primaryType: string;
  messageField: string;
  messageValue: string;
}): Promise<void> {
  const response = await fetch(`${apiUrl}/policies/${policyId}`, {
    headers: privyHeaders(),
  });
  const policy = await response.json().catch(() => ({})) as {
    chain_type?: string;
    rules?: Array<{
      method?: string;
      action?: string;
      conditions?: Array<{
        field_source?: string;
        field?: string;
        operator?: string;
        value?: string | string[];
        typed_data?: {
          primary_type?: string;
          types?: Record<string, Array<{ name: string; type: string }>>;
        };
      }>;
    }>;
  };
  if (!response.ok) {
    throw new Error(`Unable to read Privy ${expected.role} policy (${response.status})`);
  }
  const rules = policy.rules ?? [];
  const allowRules = rules.filter((rule) =>
    rule.method === 'eth_signTypedData_v4' && rule.action === 'ALLOW',
  );
  const domainFields = allowRules.flatMap((rule) => rule.conditions ?? []);
  const chainCondition = domainFields.find((condition) =>
    condition.field_source === 'ethereum_typed_data_domain' &&
    ['chainId', 'chain_id'].includes(condition.field ?? '') &&
    matchesValue(condition.value, expected.chainId),
  );
  const contractCondition = domainFields.find((condition) =>
    condition.field_source === 'ethereum_typed_data_domain' &&
    ['verifyingContract', 'verifying_contract'].includes(condition.field ?? '') &&
    matchesValue(condition.value, '0x0000000000000000000000000000000000000000'),
  );
  const messageCondition = domainFields.find((condition) =>
    condition.field_source === 'ethereum_typed_data_message' &&
    condition.field === expected.messageField &&
    condition.typed_data?.primary_type === expected.primaryType &&
    matchesValue(condition.value, expected.messageValue),
  );
  const domainType = messageCondition?.typed_data?.types?.EIP712Domain;
  const completeDomain = [
    ['name', 'string'],
    ['version', 'string'],
    ['chainId', 'uint256'],
    ['verifyingContract', 'address'],
  ].every(([name, type]) => domainType?.some((field) =>
    field.name === name && field.type === type,
  ));
  if (
    policy.chain_type !== 'ethereum' ||
    !chainCondition ||
    !contractCondition ||
    !messageCondition ||
    !completeDomain
  ) {
    throw new Error(
      `Privy ${expected.role} policy does not match the required Hyperliquid EIP-712 schema; include EIP712Domain in typed_data.types`,
    );
  }
}

function matchesValue(actual: string | string[] | undefined, expected: string): boolean {
  return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
}

function privyHeaders(): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
    'privy-app-id': appId,
  };
}

async function ensureAgentRegistered(master: PrivyWallet, agent: PrivyWallet): Promise<boolean> {
  const hl = await dynamicImport('@nktkas/hyperliquid') as typeof import('@nktkas/hyperliquid');
  const transport = new hl.HttpTransport({ isTestnet: false });
  const info = new hl.InfoClient({ transport });
  const agents = await info.extraAgents({ user: master.address as `0x${string}` });
  if (agents.some((candidate) => candidate.address.toLowerCase() === agent.address.toLowerCase())) {
    return true;
  }
  await ensurePerpsCollateral(master);
  const exchange = await createMasterExchangeClient(master);
  await exchange.approveAgent({
    agentAddress: agent.address as `0x${string}`,
    agentName: 'dream-perp-v1',
  });
  const updated = await info.extraAgents({ user: master.address as `0x${string}` });
  return updated.some((candidate) => candidate.address.toLowerCase() === agent.address.toLowerCase());
}

async function ensurePerpsCollateral(master: PrivyWallet): Promise<void> {
  const hl = await dynamicImport('@nktkas/hyperliquid') as typeof import('@nktkas/hyperliquid');
  const transport = new hl.HttpTransport({ isTestnet: false });
  const info = new hl.InfoClient({ transport });
  const minimumAccountValue = Number(process.env.HYPERLIQUID_MIN_ACCOUNT_VALUE_USDC ?? '25');
  const address = master.address as `0x${string}`;

  const readBalances = async () => {
    const [perps, spot] = await Promise.all([
      info.clearinghouseState({ user: address }),
      info.spotClearinghouseState({ user: address }),
    ]);
    const accountValue = Number(perps.marginSummary.accountValue);
    const spotUsdc = spot.balances.find((balance) => balance.coin === 'USDC');
    const spotAmount = Number(spotUsdc?.total ?? '0');
    return { accountValue, spotAmount, spotTotal: spotUsdc?.total ?? '0' };
  };

  let { accountValue, spotAmount, spotTotal } = await readBalances();
  if (Number.isFinite(accountValue) && accountValue >= minimumAccountValue) {
    return;
  }
  if (!Number.isFinite(spotAmount) || spotAmount <= 0) {
    throw new Error(
      `Fund the Hyperliquid master account with at least ${minimumAccountValue} USDC before approveAgent`,
    );
  }

  const exchange = await createMasterExchangeClient(master);
  console.log(JSON.stringify({
    spotToPerpTransfer: true,
    masterAddress: master.address,
    amount: spotTotal,
  }, null, 2));
  await exchange.usdClassTransfer({ amount: spotTotal, toPerp: true });

  ({ accountValue, spotAmount } = await readBalances());
  if (!Number.isFinite(accountValue) || accountValue < minimumAccountValue) {
    throw new Error(
      `Hyperliquid perps account value is ${accountValue}; need at least ${minimumAccountValue} USDC after spot-to-perp transfer`,
    );
  }
}

async function createMasterExchangeClient(master: PrivyWallet) {
  const hl = await dynamicImport('@nktkas/hyperliquid') as typeof import('@nktkas/hyperliquid');
  const privyModule = await dynamicImport('@privy-io/node') as typeof import('@privy-io/node');
  const privyViem = await dynamicImport('@privy-io/node/viem') as typeof import('@privy-io/node/viem');
  const privy = new privyModule.PrivyClient({ appId, appSecret, apiUrl: sdkApiUrl });
  const transport = new hl.HttpTransport({ isTestnet: false });
  const wallet = privyViem.createViemAccount(privy, {
    walletId: master.id,
    address: master.address as `0x${string}`,
    authorizationContext: { authorization_private_keys: [authorizationKey] },
  });
  return new hl.ExchangeClient({ transport, wallet, signatureChainId: '0x1' });
}

async function createWallet(input: {
  displayName: string;
  externalId: string;
  idempotencyKey: string;
  policyId: string;
  ownerPublicKey: string;
}): Promise<PrivyWallet> {
  const existing = await findWallet(input.externalId);
  if (existing) return existing;
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
      policy_ids: [input.policyId],
      owner: { public_key: input.ownerPublicKey },
    }),
  });
  const body = await response.json().catch(() => ({})) as Partial<PrivyWallet> & {
    message?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(`Privy wallet creation failed (${response.status}): ${body.message ?? body.error ?? 'unknown error'}`);
  }
  if (!body.id || !body.address) throw new Error('Privy response did not include wallet id and address');
  return { id: body.id, address: body.address.toLowerCase() };
}

async function findWallet(externalId: string): Promise<PrivyWallet | null> {
  const response = await fetch(
    `${apiUrl}/wallets?chain_type=ethereum&external_id=${encodeURIComponent(externalId)}`,
    { headers: {
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'privy-app-id': appId,
    } },
  );
  if (!response.ok) throw new Error(`Privy wallet lookup failed (${response.status})`);
  const body = await response.json() as { data?: PrivyWallet[]; wallets?: PrivyWallet[] };
  const wallet = [...(body.data ?? []), ...(body.wallets ?? [])].find((item) => item.id && item.address);
  return wallet ? { id: wallet.id, address: wallet.address.toLowerCase() } : null;
}

function authorizationPublicKey(): string {
  const raw = authorizationKey.startsWith('wallet-auth:')
    ? authorizationKey.slice('wallet-auth:'.length)
    : authorizationKey;
  const decoded = Buffer.from(raw, 'base64');
  try {
    const text = decoded.toString('utf8');
    const privateKey = text.includes('BEGIN PRIVATE KEY')
      ? createPrivateKey(text)
      : createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
    return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  } catch (_error) {
    const marker = decoded.indexOf(Buffer.from([0x04, 0x20]));
    if (marker === -1) throw new Error('Privy authorization private key is invalid');
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(decoded.subarray(marker + 2, marker + 34));
    const header = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
    return Buffer.concat([header, ecdh.getPublicKey()]).toString('base64');
  }
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(separator + 1).trim();
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function dynamicImport(specifier: string): Promise<unknown> {
  const importer = new Function('moduleName', 'return import(moduleName)') as (
    moduleName: string,
  ) => Promise<unknown>;
  return importer(specifier);
}

void main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});

function safeError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error && current.message && !messages.includes(current.message)) {
      messages.push(sanitizeErrorMessage(current.message));
      current = current.cause;
    } else {
      break;
    }
  }
  return messages.join(': ') || 'Hyperliquid provisioning failed';
}

function sanitizeErrorMessage(message: string): string {
  if (/\b404\b[\s\S]*<!doctype html/i.test(message)) {
    return 'Privy API returned HTTP 404; check PRIVY_API_URL base path';
  }
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}
