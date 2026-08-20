const apiKey = (process.env.ONEINCH_API_KEY ?? '').trim();
const configured = (process.env.ONEINCH_BASE_URL ?? 'https://api.1inch.com').replace(/\/$/, '');
const base = configured.includes('/swap/') ? configured : `${configured}/swap/v6.1`;

for (const chainId of [1, 56, 8453, 42161, 10]) {
  const response = await fetch(`${base}/${chainId}/approve/spender`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
  });
  const body = await response.text();
  console.log(JSON.stringify({
    chainId,
    status: response.status,
    baseHost: safeHost(base),
    responsePreview: body.slice(0, 240),
  }));
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
