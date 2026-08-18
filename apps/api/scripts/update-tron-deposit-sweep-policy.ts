import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TRON_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(resolve(process.cwd(), '.env'));
loadEnv(resolve(process.cwd(), '../../.env'));

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function privyFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
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
  if (!response.ok) {
    throw new Error(`Privy request failed for ${path} (${response.status})`);
  }
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

type PrivyCondition = {
  field_source?: string;
  field?: string;
  operator?: string;
  value?: string | string[];
};

type PrivyRule = {
  id?: string;
  name?: string;
  method?: string;
  action?: string;
  conditions?: PrivyCondition[];
};

type DesiredRule = {
  name: string;
  method: 'signTransactionBytes';
  conditions: Array<PrivyCondition & { abi?: Array<Record<string, unknown>> }>;
  action: 'ALLOW';
};

function nativeSweepRule(treasuryAddress: string): DesiredRule {
  return {
    name: 'TRON native sweep to treasury (raw sign)',
    method: 'signTransactionBytes',
    conditions: [
      {
        field_source: 'tron_transaction',
        field: 'TransferContract.to_address',
        operator: 'eq',
        value: treasuryAddress,
      },
      {
        field_source: 'tron_transaction',
        field: 'TransferContract.amount',
        operator: 'gt',
        value: '0',
      },
    ],
    action: 'ALLOW',
  };
}

function usdtSweepRule(treasuryAddress: string): DesiredRule {
  return {
    name: 'TRON USDT sweep to treasury (raw sign)',
    method: 'signTransactionBytes',
    conditions: [
      {
        field_source: 'tron_transaction',
        field: 'TriggerSmartContract.contract_address',
        operator: 'eq',
        value: TRON_USDT_CONTRACT,
      },
      {
        field_source: 'tron_transaction',
        field: 'TriggerSmartContract.call_value',
        operator: 'eq',
        value: '0',
      },
      {
        field_source: 'tron_trigger_smart_contract_data',
        field: 'transfer.to',
        operator: 'eq',
        value: treasuryAddress,
        abi: [
          {
            name: 'transfer',
            type: 'function',
            inputs: [{ name: 'to', type: 'address' }],
          },
        ],
      },
    ],
    action: 'ALLOW',
  };
}

function conditionValueEquals(condition: PrivyCondition, value: string): boolean {
  return typeof condition.value === 'string' && condition.value === value;
}

function findRule(existingRules: PrivyRule[], desired: DesiredRule): PrivyRule | undefined {
  if (desired.conditions.some((condition) => condition.field === 'TransferContract.to_address')) {
    return existingRules.find((rule) =>
      rule.conditions?.some((condition) => condition.field === 'TransferContract.to_address'),
    );
  }
  return existingRules.find((rule) =>
    rule.conditions?.some((condition) =>
      condition.field === 'TriggerSmartContract.contract_address' &&
      conditionValueEquals(condition, TRON_USDT_CONTRACT),
    ),
  );
}

async function upsertRule(
  policyId: string,
  existingRules: PrivyRule[],
  desired: DesiredRule,
): Promise<void> {
  const existing = findRule(existingRules, desired) ??
    existingRules.find((rule) => rule.name === desired.name);
  if (existing?.id) {
    await privyFetch(`/policies/${policyId}/rules/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify(desired),
    });
    console.log(`Updated ${desired.name}`);
    return;
  }
  await privyFetch(`/policies/${policyId}/rules`, {
    method: 'POST',
    body: JSON.stringify(desired),
  });
  console.log(`Created ${desired.name}`);
}

async function main(): Promise<void> {
  const policyId = required('PRIVY_TRON_POLICY_ID');
  const treasuryWalletId = required('PRIVY_TRON_WALLET_ID');
  const configuredTreasuryAddress = required('TRON_WITHDRAWAL_HOT_ADDRESS');

  const wallet = await privyFetch(`/wallets/${treasuryWalletId}`);
  const walletAddress = typeof wallet.address === 'string' ? wallet.address : '';
  if (!walletAddress || walletAddress !== configuredTreasuryAddress) {
    throw new Error('Privy Tron treasury wallet does not match TRON_WITHDRAWAL_HOT_ADDRESS');
  }

  const policy = await privyFetch(`/policies/${policyId}`);
  if (policy.chain_type !== 'tron') {
    throw new Error('PRIVY_TRON_POLICY_ID must reference a Tron policy');
  }
  const existingRules = Array.isArray(policy.rules) ? policy.rules as PrivyRule[] : [];
  const recognizedRuleIds = new Set(
    [
      findRule(existingRules, nativeSweepRule(configuredTreasuryAddress))?.id,
      findRule(existingRules, usdtSweepRule(configuredTreasuryAddress))?.id,
    ].filter((id): id is string => Boolean(id)),
  );
  const unexpectedAllowRules = existingRules.filter((rule) =>
    rule.action === 'ALLOW' && (!rule.id || !recognizedRuleIds.has(rule.id)),
  );
  if (unexpectedAllowRules.length > 0) {
    throw new Error('Tron sweep policy contains an unrecognized ALLOW rule; refusing automatic update');
  }

  await upsertRule(policyId, existingRules, nativeSweepRule(configuredTreasuryAddress));
  await upsertRule(policyId, existingRules, usdtSweepRule(configuredTreasuryAddress));
  console.log('Tron sweep policy is restricted to the configured treasury address');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Unknown policy update error');
  process.exit(1);
});
