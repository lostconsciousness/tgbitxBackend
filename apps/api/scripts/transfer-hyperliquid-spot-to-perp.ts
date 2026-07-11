import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '../../.env'));

const appId = required('PRIVY_APP_ID');
const appSecret = required('PRIVY_APP_SECRET');
const authorizationKey = required('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64');
const masterWalletId = required('PRIVY_HYPERLIQUID_MASTER_WALLET_ID');
const masterAddress = required('HYPERLIQUID_MASTER_ADDRESS').toLowerCase();
const configuredApiUrl = (process.env.PRIVY_API_URL ?? 'https://api.privy.io/v1').replace(/\/+$/, '');
const sdkApiUrl = configuredApiUrl.replace(/\/v1$/, '');

async function main(): Promise<void> {
  if (process.env.MAINNET_ENABLED !== 'true' || process.env.HYPERLIQUID_TESTNET !== 'false') {
    throw new Error('Mainnet transfer requires MAINNET_ENABLED=true and HYPERLIQUID_TESTNET=false');
  }

  const hl = await dynamicImport('@nktkas/hyperliquid') as typeof import('@nktkas/hyperliquid');
  const privyModule = await dynamicImport('@privy-io/node') as typeof import('@privy-io/node');
  const privyViem = await dynamicImport('@privy-io/node/viem') as typeof import('@privy-io/node/viem');
  const privy = new privyModule.PrivyClient({ appId, appSecret, apiUrl: sdkApiUrl });
  const transport = new hl.HttpTransport({ isTestnet: false });
  const info = new hl.InfoClient({ transport });
  const address = masterAddress as `0x${string}`;

  const custodyAddress = (await privy.wallets().get(masterWalletId)).address.toLowerCase();
  if (custodyAddress !== masterAddress) {
    throw new Error('PRIVY_HYPERLIQUID_MASTER_WALLET_ID does not match HYPERLIQUID_MASTER_ADDRESS');
  }

  const [perpsBefore, spotBefore] = await Promise.all([
    info.clearinghouseState({ user: address }),
    info.spotClearinghouseState({ user: address }),
  ]);
  const spotUsdc = spotBefore.balances.find((balance) => balance.coin === 'USDC');
  const spotTotal = spotUsdc?.total ?? '0';
  const perpsBeforeValue = perpsBefore.marginSummary.accountValue;

  if (Number(spotTotal) <= 0) {
    console.log(JSON.stringify({
      masterAddress,
      perpsAccountValue: perpsBeforeValue,
      spotUsdc: spotTotal,
      transferred: false,
      message: 'No spot USDC to transfer',
    }, null, 2));
    return;
  }

  const wallet = privyViem.createViemAccount(privy, {
    walletId: masterWalletId,
    address,
    authorizationContext: { authorization_private_keys: [authorizationKey] },
  });
  const exchange = new hl.ExchangeClient({ transport, wallet, signatureChainId: '0x1' });
  await exchange.usdClassTransfer({ amount: spotTotal, toPerp: true });

  const [perpsAfter, spotAfter] = await Promise.all([
    info.clearinghouseState({ user: address }),
    info.spotClearinghouseState({ user: address }),
  ]);
  console.log(JSON.stringify({
    masterAddress,
    transferred: true,
    amount: spotTotal,
    perpsAccountValueBefore: perpsBeforeValue,
    perpsAccountValueAfter: perpsAfter.marginSummary.accountValue,
    spotUsdcAfter: spotAfter.balances.find((balance) => balance.coin === 'USDC')?.total ?? '0',
  }, null, 2));
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
  const message = error instanceof Error ? error.message : 'Hyperliquid spot-to-perp transfer failed';
  if (/failed to sign the typed data/i.test(message)) {
    console.error(
      `${message}. Add a master Privy ALLOW rule for HyperliquidTransaction:UsdClassTransfer (chain ID 1, hyperliquidChain=Mainnet), then retry.`,
    );
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});
