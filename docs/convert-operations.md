# Convert operations: EVM + Solana + Tron

Bitcoin is intentionally excluded. EVM execution uses 1inch Classic Swap on
the provider-supported mainnets configured in `CONVERT_EVM_NETWORKS`. Solana
native SOL and Tron native TRX use the exchange reserve against USDC/USDT.

## Safety and liquidity model

- Quotes are exact-input and expire after 20 seconds.
- User funds are reserved before execution.
- EVM output is credited only after a successful receipt and custody balance reconciliation.
- An ambiguous confirmed swap is not auto-released; it requires reconciliation.
- Every route checks source inventory, gas and RPC chain ID before quoting/execution.
- Reserve routes require actual custody assets above user liabilities plus the configured coverage buffer.
- Mainnet starts with a 100 USDC per-order and 1,000 USDC daily limit.

Existing Privy treasury/hot wallets can be used. A separate wallet is not
required, but conversion inventory must be funded in addition to user
liabilities and the withdrawal operating buffer. Keep cold reserves outside
the online conversion wallet.

## Required configuration

Create restrictive policies in Privy Dashboard. Never paste authorization
material into logs or commit it to the repository.

```powershell
$env:PRIVY_CUSTODY_ENABLED='true'
$env:PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64='<secret-manager-value>'
$env:PRIVY_PRODUCTION_SIGNING_ENABLED='true'
$env:PRIVY_ENV_AUTHORIZATION_MAINNET_ENABLED='true'

$env:ONEINCH_ENABLED='true'
$env:ONEINCH_API_KEY='<secret-manager-value>'
$env:CONVERT_EVM_NETWORKS='arbitrum,base,optimism,polygon,bnb,avalanche,ethereum,zksync,linea'

$env:SOLANA_RPC_PRIMARY_URL='<solana-mainnet-rpc>'
$env:PRIVY_SOLANA_POLICY_ID='<policy-id>'

$env:TRON_RPC_PRIMARY_URL='<tron-mainnet-rpc>'
$env:PRIVY_TRON_POLICY_ID='<policy-id>'
$env:PRIVY_TRON_RESERVE_POLICY_ID='<policy-id>'
```

The EVM policy must allow only the enabled chain IDs and current 1inch
spender/router. Use exact ERC-20 approvals. The Solana and Tron policies must
limit destinations and transaction values.

The free 1inch plan is rate-limited. Keep the built-in request pacing enabled:

```powershell
$env:ONEINCH_MIN_REQUEST_INTERVAL_MS='1100'
$env:ONEINCH_MAX_RETRIES='2'
$env:ONEINCH_SPENDER_CACHE_MS='300000'
```

The limiter is process-local. A multi-instance deployment needs a shared Redis
rate limiter or a paid 1inch plan with an appropriate RPS allowance.

Provision the non-EVM wallets and store only their returned public wallet IDs
and addresses in the secret manager/configuration:

```powershell
npm run privy:provision-solana
npm run privy:provision-tron
```

Set `PRIVY_SOLANA_WALLET_ID`, `SOLANA_WITHDRAWAL_HOT_ADDRESS`,
`PRIVY_TRON_WALLET_ID`, and `TRON_WITHDRAWAL_HOT_ADDRESS` from the provisioning
results. Do not store raw private keys for these mainnet wallets.

Apply migrations and seed networks/contracts/markets:

```powershell
npm run migrate:deploy
npm run seed
```

For every enabled EVM network, configure its primary RPC and include its key in
`MAINNET_ENABLED_NETWORKS`. Verify each token contract through the admin API
for that network before enabling Convert. Unverified contracts stay absent.

Fund the wallets with:

- EVM: source USDC/USDT inventory plus each network's native gas coin.
- Solana: SOL reserve and SOL for fees.
- Tron: TRX reserve/energy and, when selling TRX, stablecoin reserve elsewhere in custody.

Then enable routes:

```powershell
$env:CONVERT_ENABLED='true'
$env:CONVERT_EVM_ENABLED='true'
$env:CONVERT_SOL_ENABLED='true'
$env:CONVERT_TRON_ENABLED='true'
```

## Readiness and canary

Call `GET /convert/readiness` with an authenticated access token. Enable only
networks reporting `ready: true` and with verified assets. Run one minimum-size
conversion per funded network and one SOL/TRX reserve conversion. Confirm:

1. Provider/Privy transaction activity.
2. Custody balances and gas buffers.
3. Internal ledger and `GET /convert/:id` status.

## Public API

- `GET /convert/assets`
- `GET /convert/readiness`
- `POST /convert/quote`
- `POST /convert/execute`
- `GET /convert`
- `GET /convert/:id`

`POST /convert/execute` is idempotent by `(userId, clientConversionId)`.
