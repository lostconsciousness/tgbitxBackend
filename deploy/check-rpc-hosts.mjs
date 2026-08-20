const keys = [
  'ARBITRUM_RPC_PRIMARY_URL', 'ARBITRUM_RPC_FALLBACK_URL',
  'BNB_RPC_PRIMARY_URL', 'BNB_RPC_FALLBACK_URL',
  'BASE_RPC_PRIMARY_URL', 'BASE_RPC_FALLBACK_URL',
  'OPTIMISM_RPC_PRIMARY_URL', 'OPTIMISM_RPC_FALLBACK_URL',
  'ETHEREUM_RPC_PRIMARY_URL', 'ETHEREUM_RPC_FALLBACK_URL',
];

for (const key of keys) {
  const value = (process.env[key] ?? '').trim();
  console.log(JSON.stringify({ key, configured: Boolean(value), host: safeHost(value) }));
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
