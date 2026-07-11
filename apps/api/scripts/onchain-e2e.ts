import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

type Json = Record<string, any>;

const enabled = process.env.E2E_ONCHAIN_ENABLED === 'true';
if (!enabled) {
  throw new Error('Set E2E_ONCHAIN_ENABLED=true to run the real on-chain test');
}

const apiUrl = process.env.E2E_API_URL ?? 'http://localhost:3000';
const userToken = required('E2E_USER_ACCESS_TOKEN');
const adminToken = required('E2E_ADMIN_ACCESS_TOKEN');
const withdrawalAddress = required('E2E_WITHDRAWAL_ADDRESS');
const network = process.env.E2E_NETWORK ?? 'arbitrum-sepolia';
const assetSymbol = process.env.E2E_ASSET_SYMBOL ?? 'USDC';
const walletId = required('E2E_WALLET_ID');
const amount = process.env.E2E_AMOUNT ?? process.env.E2E_USDC_AMOUNT ?? '1';
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 15 * 60_000);
const prompt = createInterface({ input: stdin, output: stdout });

async function main(): Promise<void> {
  try {
    const readiness = await api<Json>('/admin/onchain/readiness', adminToken);
  if (!readiness.workers?.depositIndexer?.ready || !readiness.workers?.withdrawal?.ready) {
    throw new Error(`On-chain workers are not ready: ${(readiness.issues ?? []).join(', ')}`);
  }

    const before = await api<Json>('/account/overview', userToken);
    const depositAddress = await api<Json>('/deposits/address', userToken, {
      method: 'POST',
      body: { assetSymbol, network },
    });
    const instructions = await api<Json>(
      `/deposits/instructions/${assetSymbol}?network=${encodeURIComponent(network)}`,
      userToken,
    );
    const intent = await api<Json>('/deposits/intents', userToken, {
      method: 'POST',
      body: { assetSymbol, network, amount, walletId },
    });

    stdout.write(
    [
      '',
      `Send test ${assetSymbol} on ${network}:`,
      `chainId: ${intent.transfer.chainId}`,
      `caip2: ${intent.transfer.caip2}`,
      `token: ${intent.transfer.tokenAddress}`,
      `standard: ${intent.transfer.tokenStandard}`,
      `recipient: ${intent.transfer.recipient}`,
      `amount: ${amount} ${assetSymbol}`,
      `rawAmount: ${intent.transfer.rawAmount}`,
      `depositAddress: ${depositAddress.address}`,
      `instructionsAddress: ${instructions.depositAddress}`,
      '',
    ].join('\n'),
  );
    const txHash = (await prompt.question('Deposit tx hash: ')).trim();
    await api<Json>(`/deposits/intents/${intent.id}/submit`, userToken, {
      method: 'POST',
      body: { txHash },
    });
    const creditedDeposit = await poll(
    '/deposits',
    userToken,
    (items) =>
      Array.isArray(items) &&
      items.some(
        (item) =>
          item.txHash?.toLowerCase() === txHash.toLowerCase() &&
          item.status === 'CREDITED',
      ),
    (items) =>
      items.find((item: Json) => item.txHash?.toLowerCase() === txHash.toLowerCase()),
  );

    let confirmedSweep: Json | undefined;
    if (readiness.workers?.depositSweep?.enabled) {
      confirmedSweep = await poll(
        '/admin/deposits/sweeps',
        adminToken,
        (items) =>
          Array.isArray(items) &&
          items.some(
            (item) =>
              item.deposits?.some((deposit: Json) => deposit.id === creditedDeposit.id) &&
              item.status === 'CONFIRMED',
          ),
        (items) =>
          items.find((item: Json) =>
            item.deposits?.some((deposit: Json) => deposit.id === creditedDeposit.id),
          ),
      );
    }

    const withdrawal = await api<Json>('/withdrawals', userToken, {
    method: 'POST',
      body: {
      assetSymbol,
      network,
      amount,
      toAddress: withdrawalAddress,
    },
  });
    await api(`/admin/withdrawals/${withdrawal.id}/approve`, adminToken, {
    method: 'POST',
    body: { reason: 'Gated Arbitrum Sepolia E2E' },
  });
    const confirmedWithdrawal = await poll(
    '/withdrawals',
    userToken,
    (items) =>
      Array.isArray(items) &&
      items.some((item) => item.id === withdrawal.id && item.status === 'CONFIRMED'),
    (items) => items.find((item: Json) => item.id === withdrawal.id),
  );

    const [ledgerReconciliation, treasuryReconciliation, after] = await Promise.all([
    api<Json>('/admin/reconciliation/ledger', adminToken, { method: 'POST' }),
    api<Json>('/admin/reconciliation/treasury', adminToken, { method: 'POST' }),
    api<Json>('/account/overview', userToken),
  ]);
    if (
    ledgerReconciliation.status !== 'PASSED' ||
    treasuryReconciliation.status !== 'PASSED'
  ) {
    throw new Error('Reconciliation did not pass after the on-chain round trip');
  }

    stdout.write(
    `${JSON.stringify(
      {
        depositAddressId: depositAddress.id,
        network,
        assetSymbol,
        depositId: creditedDeposit.id,
        depositTxHash: txHash,
        sweepTxHash: confirmedSweep?.txHash,
        withdrawalId: withdrawal.id,
        withdrawalTxHash: confirmedWithdrawal.txHash,
        reconciliation: {
          ledger: ledgerReconciliation.status,
          treasury: treasuryReconciliation.status,
        },
        balances: { before: before.balances, after: after.balances },
      },
      null,
      2,
    )}\n`,
    );
  } finally {
    prompt.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function poll(
  path: string,
  token: string,
  complete: (value: any) => boolean,
  select: (value: any) => any = (value) => value,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await api<any>(path, token);
    if (complete(value)) {
      return select(value);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function api<T = Json>(
  path: string,
  token: string,
  options: { method?: string; body?: Json } = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} failed: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
