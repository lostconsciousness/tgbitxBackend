import { NestFactory } from '@nestjs/core';
import {
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
  OrderSide,
  OrderType,
} from '@prisma/client';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { PrismaService } from '../src/database/prisma.service';

type Json = Record<string, unknown>;

const apiUrl = process.env.CANARY_API_URL ?? 'http://localhost:3000';
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? '';
const traderEmail = process.env.CANARY_TRADER_EMAIL ?? 'canary-trader@example.com';
const traderPassword = process.env.CANARY_TRADER_PASSWORD ?? 'canary-trader-password-123456';
const canarySize = process.env.CANARY_BTC_SIZE ?? '0.0002';

loadEnv(resolve(process.cwd(), '.env'));

async function main(): Promise<void> {
  if (!adminPassword) {
    throw new Error('SEED_ADMIN_PASSWORD is required');
  }

  await waitForApi();

  const adminToken = await login(adminEmail, adminPassword);
  let traderToken = await tryLogin(traderEmail, traderPassword);
  if (!traderToken) {
    await register(traderEmail, traderPassword);
    traderToken = await login(traderEmail, traderPassword);
  }
  await ensureTraderBalance(traderEmail);

  const readinessBefore = await api<Json>('/orders/readiness', adminToken);
  console.log('Readiness before canary:', JSON.stringify(readinessBefore, null, 2));
  const aBook = ((readinessBefore.perp as Json)?.aBook ?? {}) as Json;
  if (!aBook.ready) {
    throw new Error(`A-book not ready: ${JSON.stringify(aBook.reasons ?? [])}`);
  }

  console.log('Running provider reconciliation (pre-canary)...');
  console.log(await api('/admin/reconciliation/provider-orders', adminToken, { method: 'POST' }));
  console.log(await api('/admin/reconciliation/provider-positions', adminToken, { method: 'POST' }));

  console.log('Unpausing trading...');
  console.log(await api('/admin/risk/pause/trading', adminToken, {
    method: 'PATCH',
    body: { enabled: false },
  }));

  const openClientOrderId = `canary-open-${Date.now()}`;
  console.log(`Opening BTC-PERP canary: size=${canarySize}`);
  const openOrder = await api<Json>('/orders', traderToken, {
    method: 'POST',
    body: {
      symbol: 'BTC-PERP',
      clientOrderId: openClientOrderId,
      side: OrderSide.BUY,
      type: OrderType.MARKET,
      size: canarySize,
      leverage: 10,
    },
  });
  console.log('Open order response:', JSON.stringify(openOrder, null, 2));

  const filledOpen = await pollOrder(traderToken, adminToken, openOrder.id as string);
  console.log('Open order final:', JSON.stringify({
    id: filledOpen.id,
    status: filledOpen.status,
    route: filledOpen.route,
    filledSize: filledOpen.filledSize,
    providerOrder: filledOpen.providerOrder,
  }, null, 2));

  const closeSize = String(filledOpen.filledSize ?? filledOpen.size ?? canarySize);
  const closeClientOrderId = `canary-close-${Date.now()}`;
  console.log(`Closing BTC-PERP canary: size=${closeSize}`);
  const closeOrder = await api<Json>('/orders', traderToken, {
    method: 'POST',
    body: {
      symbol: 'BTC-PERP',
      clientOrderId: closeClientOrderId,
      side: OrderSide.SELL,
      type: OrderType.MARKET,
      size: closeSize,
      leverage: 10,
      reduceOnly: true,
    },
  });
  console.log('Close order response:', JSON.stringify(closeOrder, null, 2));
  const filledClose = await pollOrder(traderToken, adminToken, closeOrder.id as string);
  console.log('Close order final:', JSON.stringify({
    id: filledClose.id,
    status: filledClose.status,
    route: filledClose.route,
    filledSize: filledClose.filledSize,
    providerOrder: filledClose.providerOrder,
  }, null, 2));

  console.log('Running provider reconciliation (post-canary)...');
  console.log(await api('/admin/reconciliation/provider-orders', adminToken, { method: 'POST' }));
  console.log(await api('/admin/reconciliation/provider-positions', adminToken, { method: 'POST' }));

  const readinessAfter = await api<Json>('/orders/readiness', adminToken);
  console.log('Readiness after canary:', JSON.stringify(readinessAfter, null, 2));
  console.log(JSON.stringify({
    canaryCompleted: true,
    openOrderId: filledOpen.id,
    closeOrderId: filledClose.id,
    tradingPaused: readinessAfter.tradingPaused,
    aBookReady: ((readinessAfter.perp as Json)?.aBook as Json)?.ready ?? false,
  }, null, 2));
}

async function ensureTraderBalance(email: string): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const ledger = app.get(LedgerService);
    const usdc = await prisma.asset.findUniqueOrThrow({ where: { symbol: 'USDC' } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const balance = await ledger.getUserMainnetSpotBalance({
      userId: user.id,
      assetId: usdc.id,
    });
    if (balance.greaterThanOrEqualTo(100)) {
      console.log(`Trader ${email} already has ${balance.toString()} USDC`);
      return;
    }
    await ledger.postTransaction({
      type: LedgerTransactionType.ADMIN_ADJUSTMENT,
      idempotencyKey: `canary-credit:${user.id}:usdc`,
      referenceType: 'User',
      referenceId: user.id,
      description: 'Credit canary trader USDC for Hyperliquid pilot',
      metadata: { reason: 'HYPERLIQUID_CANARY' },
      entries: [
        {
          accountType: LedgerAccountType.PLATFORM_RISK,
          assetId: usdc.id,
          direction: LedgerEntryDirection.DEBIT,
          amount: '100',
        },
        {
          accountType: LedgerAccountType.USER_SPOT,
          userId: user.id,
          assetId: usdc.id,
          direction: LedgerEntryDirection.CREDIT,
          amount: '100',
        },
      ],
    });
    console.log(`Credited ${email} with 100 USDC for canary`);
  } finally {
    await app.close();
  }
}

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch (_error) {
      // retry
    }
    await sleep(2_000);
  }
  throw new Error(`API not reachable at ${apiUrl}`);
}

async function login(email: string, password: string): Promise<string> {
  const body = await api<Json>('/auth/login', undefined, {
    method: 'POST',
    body: { email, password },
  });
  const token = body.accessToken;
  if (typeof token !== 'string') {
    throw new Error(`Login failed for ${email}`);
  }
  return token;
}

async function tryLogin(email: string, password: string): Promise<string | null> {
  try {
    return await login(email, password);
  } catch (_error) {
    return null;
  }
}

async function register(email: string, password: string): Promise<void> {
  await api('/auth/register', undefined, {
    method: 'POST',
    body: { email, password },
  });
  console.log(`Registered ${email}`);
}

async function pollOrder(
  traderToken: string,
  adminToken: string,
  orderId: string,
): Promise<Json> {
  const okStatuses = ['FILLED', 'PARTIALLY_FILLED'];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await api('/admin/reconciliation/provider-orders', adminToken, { method: 'POST' }).catch(() => undefined);
    const orders = await api<Json[]>('/orders', traderToken);
    const order = orders.find((item) => item.id === orderId);
    if (order && okStatuses.includes(String(order.status))) {
      return order;
    }
    if (order && ['FAILED', 'REJECTED', 'CANCELLED'].includes(String(order.status))) {
      throw new Error(`Order ${orderId} ended in ${String(order.status)}: ${JSON.stringify(order)}`);
    }
    await sleep(3_000);
  }
  throw new Error(`Timed out waiting for order ${orderId}`);
}

async function api<T = unknown>(
  path: string,
  token?: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function loadEnv(path: string): void {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : 'Hyperliquid canary failed');
  try {
    const adminToken = await login(adminEmail, adminPassword);
    await api('/admin/risk/pause/trading', adminToken, {
      method: 'PATCH',
      body: { enabled: true },
    });
    console.log('Trading re-paused after canary failure');
  } catch (_pauseError) {
    // best effort
  }
  process.exitCode = 1;
});
