# Alchemy RPC cost controls

## Production safeguards

- `RPC_RETRY_ATTEMPTS=2`: retry transient RPC failures once, then fail over.
- `DEPOSIT_INDEXER_MAX_BLOCK_RANGE=1000`: use efficient ranges on EVM networks.
- BNB ranges remain capped at 10 blocks in code because of provider limits.
- Stale cursors are processed in bounded chunks. The chain tip is scanned separately so new deposits are not delayed by historical catch-up.
- Cursor advancement uses the last block actually scanned, never the provider's latest block across an unscanned gap.
- Latest block reads are coalesced for two seconds per network.
- Personal deposit scans and global scans are awaited; timeout wrappers must not use `Promise.race` without cancelling the underlying request.
- Connected-wallet balance results are cached for 120 seconds.
- Treasury safety reconciliation runs every two minutes. Withdrawals still fund the hot wallet on demand.

## Monitoring

Check every deployment for:

```bash
docker stats --no-stream backend_api_1
docker logs --since 15m backend_api_1 2>&1 | grep -E 'timed out after|RPC HTTP 429|rate limit|Deposit indexer skipped'
```

In Alchemy, split production and development into different apps/keys and set both a usage alert and a hard monthly usage limit. Never expose a key in frontend code.

## Event-driven phase

The backend accepts Alchemy Address Activity Webhooks for each enabled EVM mainnet and retains polling only as a five-minute reconciliation fallback once the webhook gate is enabled. The signed endpoint is:

```text
POST https://tgbitx.online/webhooks/alchemy/address-activity
```

Required production configuration:

```text
ALCHEMY_ADDRESS_ACTIVITY_ENABLED=true
ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON={"wh_ethereum":"secret","wh_arbitrum":"secret","wh_base":"secret","wh_optimism":"secret","wh_bnb":"secret"}
ALCHEMY_WEBHOOK_AUTH_TOKEN=<Webhooks dashboard Auth Token>
ALCHEMY_WEBHOOK_IDS_JSON={"ethereum":"wh_ethereum","arbitrum":"wh_arbitrum","base":"wh_base","optimism":"wh_optimism","bnb":"wh_bnb"}
DEPOSIT_EVM_FALLBACK_SCAN_MS=300000
DEPOSIT_EVM_BALANCE_RECONCILE_ENABLED=false
```

Use real webhook IDs as JSON keys. Store signing keys only in the server secret. A single
`ALCHEMY_WEBHOOK_SIGNING_KEY` is supported for installations where every network uses the same
signing key, but a per-webhook map is preferred.

Required external setup:

1. Create one Address Activity webhook for Ethereum, Arbitrum, Base, Optimism and BNB mainnet in the Alchemy dashboard.
2. Point every webhook at the endpoint above.
3. Add all active personal EVM deposit addresses to each webhook for the corresponding network.
4. Store every webhook ID/signing-key pair in `ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON`,
   the network-to-ID map in `ALCHEMY_WEBHOOK_IDS_JSON`, and the Webhooks dashboard
   Auth Token in `ALCHEMY_WEBHOOK_AUTH_TOKEN`.
5. Leave `ALCHEMY_ADDRESS_ACTIVITY_ENABLED=false`, use Dashboard `Test Webhook`, and confirm that the endpoint rejects the event only because the gate is disabled.
6. Enable the gate, restart API, repeat the signed test, and verify that `provider_webhook_events` records the event once.
7. Send a small real deposit on every configured network. Verify detection, confirmations, credit, sweep and realtime balance update.
8. Only after all canaries pass, keep the five-minute fallback and the EVM balance-delta reconciler disabled.

The backend adds a newly provisioned EVM deposit address to its network webhook
idempotently and reconciles all active address subscriptions every ten minutes.
The Notify API token is never logged. Missing or failed webhook synchronization
does not fail address provisioning; the fallback block scanner remains the safety
path.

The fallback scanner groups all ERC20 contracts that share a network and cursor
into one `eth_getLogs` request. Providers that reject an address-array filter
automatically fall back to isolated contract scans without advancing failed
cursors.

`GET /convert/readiness` is cached for 120 seconds by default
(`CONVERT_READINESS_CACHE_MS`) so public readiness checks do not repeatedly query
gas and USDC balances on every EVM network.

The receiver verifies `X-Alchemy-Signature` over the unmodified raw request body with HMAC-SHA256
and a constant-time comparison. It ignores outgoing, removed, unsupported-token and non-deposit-address
activity, then performs a canonical one-block scan for the exact verified token/network. Webhook event IDs
and normal deposit transaction/log identifiers provide two layers of idempotency.

Do not lower polling frequency until signing keys are installed and webhook delivery/retries have been verified in production.
