import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeFunctionData, erc20Abi, formatEther, formatUnits, parseUnits } from 'viem';

const ARBITRUM_CHAIN_ID = 42161;
const NATIVE_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const HYPERLIQUID_BRIDGE = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
const DEFAULT_RPC = 'https://arb1.arbitrum.io/rpc';

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '../../.env'));

async function main(): Promise<void> {
  const amountArg = process.argv.find((value) => value.startsWith('--amount='))?.split('=')[1];
  if (!amountArg || !/^\d+(?:\.\d{1,6})?$/.test(amountArg)) {
    throw new Error('Usage: npm run hyperliquid:bridge-deposit -- --amount=<USDC>');
  }
  if (process.env.MAINNET_ENABLED !== 'true' || process.env.HYPERLIQUID_TESTNET !== 'false') {
    throw new Error('Hyperliquid mainnet bridge deposit requires explicit mainnet flags');
  }

  const appId = required('PRIVY_APP_ID');
  const appSecret = required('PRIVY_APP_SECRET');
  const authorizationKey = required('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64');
  const walletId = required('PRIVY_HYPERLIQUID_MASTER_WALLET_ID');
  const masterAddress = required('HYPERLIQUID_MASTER_ADDRESS').toLowerCase();
  const rpcUrl = process.env.ARBITRUM_RPC_URL || DEFAULT_RPC;
  const amount = parseUnits(amountArg, 6);
  if (amount < parseUnits('5', 6)) throw new Error('Hyperliquid bridge minimum is 5 USDC');

  const privyModule = await dynamicImport('@privy-io/node') as typeof import('@privy-io/node');
  const apiUrl = (process.env.PRIVY_API_URL ?? 'https://api.privy.io/v1').replace(/\/v1\/?$/, '');
  const privy = new privyModule.PrivyClient({ appId, appSecret, apiUrl });
  const custodyAddress = (await privy.wallets().get(walletId)).address.toLowerCase();
  if (custodyAddress !== masterAddress) throw new Error('Privy master wallet/address mismatch');

  const [usdcRaw, ethRaw, perpsBefore] = await Promise.all([
    rpc<string>(rpcUrl, 'eth_call', [{
      to: NATIVE_USDC,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [masterAddress as `0x${string}`] }),
    }, 'latest']),
    rpc<string>(rpcUrl, 'eth_getBalance', [masterAddress, 'latest']),
    hyperliquidState(masterAddress),
  ]);
  const usdcBalance = BigInt(usdcRaw);
  const ethBalance = BigInt(ethRaw);
  if (usdcBalance === 0n) {
    console.log(JSON.stringify({ alreadyBroadcastOrDeposited: true, masterAddress, perpsAccountValue: perpsBefore }, null, 2));
    return;
  }
  if (usdcBalance !== amount) {
    throw new Error(`Exact-balance guard failed: requested ${amountArg}, onchain ${formatUnits(usdcBalance, 6)} USDC`);
  }
  if (ethBalance === 0n) throw new Error('Arbitrum ETH is required for bridge gas');

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [HYPERLIQUID_BRIDGE, amount],
  });
  const response = await privy.wallets().ethereum().sendTransaction(walletId, {
    caip2: `eip155:${ARBITRUM_CHAIN_ID}`,
    idempotency_key: `hyperliquid-bridge:${masterAddress}:${amount.toString()}`,
    reference_id: `hyperliquid-bridge:${amount.toString()}`,
    authorization_context: { authorization_private_keys: [authorizationKey] },
    params: {
      transaction: {
        chain_id: ARBITRUM_CHAIN_ID,
        to: NATIVE_USDC,
        value: '0x0',
        data,
      },
    },
  });
  const txHash = response.hash.toLowerCase();
  await waitForReceipt(rpcUrl, txHash);
  const perpsAfter = await waitForHyperliquidCredit(masterAddress, Number(perpsBefore), Number(amountArg));
  console.log(JSON.stringify({
    masterAddress,
    txHash,
    amountUsdc: amountArg,
    gasBalanceBeforeEth: formatEther(ethBalance),
    perpsAccountValueBefore: perpsBefore,
    perpsAccountValueAfter: perpsAfter,
  }, null, 2));
}

async function waitForReceipt(rpcUrl: string, txHash: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const receipt = await rpc<{ status?: string } | null>(rpcUrl, 'eth_getTransactionReceipt', [txHash]);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`Bridge transaction reverted: ${txHash}`);
      return;
    }
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for bridge transaction receipt: ${txHash}`);
}

async function waitForHyperliquidCredit(address: string, before: number, amount: number): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await hyperliquidState(address);
    if (Number(current) >= before + amount * 0.95) return current;
    await delay(2_000);
  }
  throw new Error('Bridge transaction confirmed but Hyperliquid credit was not observed');
}

async function hyperliquidState(user: string): Promise<string> {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user }),
  });
  if (!response.ok) throw new Error(`Hyperliquid info HTTP ${response.status}`);
  const state = await response.json() as { marginSummary?: { accountValue?: string } };
  return state.marginSummary?.accountValue ?? '0';
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json() as { result?: T; error?: { message?: string } };
  if (!response.ok || body.error || body.result === undefined) throw new Error(body.error?.message ?? `RPC ${method} failed`);
  return body.result;
}

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
function dynamicImport(specifier: string): Promise<unknown> { return new Function('m', 'return import(m)')(specifier) as Promise<unknown>; }
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('='); if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(separator + 1).trim();
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : 'Bridge deposit failed'); process.exitCode = 1; });
