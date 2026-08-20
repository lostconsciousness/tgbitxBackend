const key = (process.env.TRON_PRO_API_KEY ?? '').trim();
const rpcUrl = process.env.TRON_RPC_PRIMARY_URL ?? '';
const account = process.argv[2];
if (!account) throw new Error('Usage: node check-tron-provider.mjs <base58-address>');

const response = await fetch(
  `https://api.trongrid.io/v1/accounts/${encodeURIComponent(account)}/transactions/trc20?only_confirmed=true&only_to=true&limit=1`,
  { headers: key ? { 'TRON-PRO-API-KEY': key } : {} },
);
const body = await response.text();

console.log(JSON.stringify({
  keyPresent: Boolean(key),
  keyLength: key.length,
  keyHasWhitespace: /\s/.test(key),
  keyStartsWithBearer: /^Bearer\s/i.test(key),
  rpcHost: safeHost(rpcUrl),
  tronGridStatus: response.status,
  responsePreview: body.slice(0, 240),
}));

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
