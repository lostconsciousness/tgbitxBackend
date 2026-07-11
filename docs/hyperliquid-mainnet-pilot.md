# Hyperliquid mainnet A-book pilot

Keep trading paused until the canary is reconciled. B-book remains present in
the codebase but must stay disabled without separately funded platform and
insurance capital.

## 1. Configuration

Create two separate restrictive policies in Privy, one for the master wallet
and one for the agent wallet. Put their IDs and the existing Privy
authorization key in the secret manager; never commit them.

Required non-secret/secret variable names:

```env
MAINNET_ENABLED=true
HYPERLIQUID_TESTNET=false
HYPERLIQUID_EXECUTION_ENABLED=false
MARKET_DATA_PROVIDER=HYPERLIQUID
MARKET_DATA_FALLBACK_TO_MOCK=false
TRADING_PAUSED=true
BBOOK_ENABLED=false

PRIVY_APP_ID=
PRIVY_APP_SECRET=
PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64=
PRIVY_HYPERLIQUID_MASTER_POLICY_ID=
PRIVY_HYPERLIQUID_AGENT_POLICY_ID=
```

Pilot limits default to 10-100 USDC notional, 10x leverage and minimum 25 USDC
Hyperliquid account value.

## 2. Provision wallets and agent

From the repository root:

```powershell
npm run privy:provision-hyperliquid
```

The command is idempotent. It creates/reuses the two wallets, registers the
named agent with `approveAgent`, and prints only public wallet IDs and
addresses. Store those public values as:

```env
PRIVY_HYPERLIQUID_MASTER_WALLET_ID=
HYPERLIQUID_MASTER_ADDRESS=
PRIVY_HYPERLIQUID_AGENT_WALLET_ID=
PRIVY_HYPERLIQUID_AGENT_ADDRESS=
```

Fund the Hyperliquid master account manually with at least 25 USDC. Deposits may
land on the Hyperliquid spot balance first; the provisioning command moves spot
USDC to perps automatically via `usdClassTransfer` when needed. You can also run
`npm run hyperliquid:spot-to-perp` separately. The regular EVM treasury/hot
wallet balance is not Hyperliquid collateral.

The master Privy policy needs a second ALLOW rule for
`HyperliquidTransaction:UsdClassTransfer` (same domain constraints as
`ApproveAgent`: chain ID 1, verifying contract zero, `hyperliquidChain=Mainnet`).

## 3. Database and readiness

```powershell
npm run migrate:deploy
```

Then set `HYPERLIQUID_EXECUTION_ENABLED=true`, restart the API and check:

```http
GET /orders/readiness
```

Readiness verifies Privy wallet/address matches, named-agent registration,
provider market data and the minimum account value. It returns reason codes,
not secrets.

Run admin reconciliation while trading remains paused:

```http
POST /admin/reconciliation/provider-orders
POST /admin/reconciliation/provider-positions
```

For a stuck internal order:

```http
POST /admin/reconciliation/provider-orders/:orderId
```

The backend resolves it by `cloid`. Ambiguous `unknownOid`/timeout results keep
margin reserved and eventually become `RECONCILIATION_REQUIRED`.

## 4. Canary

Temporarily unpause through the existing admin risk setting, open and fully
close one 10 USDC BTC-PERP order, then pause again. Verify the Hyperliquid
order/fill, internal order/trade/position and ledger postings match. Run both
provider reconciliations again. Only then leave trading unpaused.

Any aggregate position mismatch automatically sets `trading:paused=true`.
