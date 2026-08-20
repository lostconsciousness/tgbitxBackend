# Backend handoff: A-book, B-book custody and private realtime

Production status as of 2026-07-13.

## A-book reconciliation incident

The user BTC position was correctly stored as `-0.00159 BTC`. Hyperliquid held
`-0.00156 BTC` because the omnibus master account already had a legacy
`+0.00003 BTC` residual before the two user SELL fills. The first SELL crossed
that residual (`Long > Short`) before increasing the provider short.

Do not reduce the user position to the provider size. The residual is platform
inventory and is now stored separately as:

```text
abook:provider-position-offset:BTC = 0.00003
```

Provider reconciliation compares:

```text
expected provider size = aggregate open A-book user size + provider residual
```

The offset can be changed only through the audited admin endpoint:

```http
PATCH /admin/reconciliation/provider-position-offsets/BTC
Content-Type: application/json

{ "size": "0.00003" }
```

After deployment the scheduled reconciliation passed with no mismatches and
`abook:reconciliation-paused=false`. `/orders/execution-readiness` returned
`perp.aBook.ready=true` with no reason codes.

## Private Socket.IO incident

There were two independent Socket.IO servers attached to the same HTTP server
and `/socket.io` path. The manual market-data server conflicted with Nest's
private gateway. In addition, WebSocket packages were declared only inside the
API npm workspace, so hoisted Nest core could not dynamically resolve its
SocketModule.

The backend now:

- uses one explicit Nest `IoAdapter`;
- registers both `/private` and `/market-data` as Nest gateways;
- declares the Socket.IO Nest packages at the workspace root;
- keeps an authenticated private socket connected when an initial/fallback
  snapshot fails and emits `snapshot_error` instead;
- logs private connect/disconnect and snapshot failures separately.

Production canary confirmed both namespaces and these private events:

```text
balances, portfolio, orders, positions, deposits, withdrawals,
trades, liquidations, provider_status
```

Frontend must connect with `auth: { token }`. A retryable `snapshot_error`
must not log the user out; request `resync` or let reconnect/fallback polling
recover it.

## B-book custody

Two separate Privy Arbitrum custody wallets and separate owner-bound policies
are configured. Policies contain no allow rules, so all signing/export methods
default to DENY while the accounts are receive-only and unfunded.

```text
PLATFORM_CAPITAL
0xd6672108d108b9e936e2d181ec8637c4201d84af

INSURANCE
0x03bd284d256a2d70449bc0294b85d578ae32035d
```

Both custody records are `ACTIVE` with `fundingStatus=UNFUNDED`. Verified native
Circle USDC balance is currently `0` on each address. Therefore the safe state
is intentionally:

```text
BBOOK_ENABLED=true
BBOOK_PAUSED=true
PLATFORM_CAPITAL_USDC=0
INSURANCE_CAPITAL_USDC=0
```

To fund B-book, send separate platform-owned native Circle USDC on Arbitrum One
(contract `0xaf88d065e77c8cc2239327c5edb3a432268e5831`):

- at least `500 USDC` to `PLATFORM_CAPITAL`;
- at least `100 USDC` to `INSURANCE`.

Do not use user deposit treasury balances or Hyperliquid A-book collateral.
Receiving USDC does not require ETH. Any future outbound custody operation
requires both Arbitrum gas and a separately reviewed Privy allow rule.

After funding, the backend team must verify both transaction hashes and on-chain
balances, capture custody snapshots, record the capital contributions in the
ledger/audit trail, set configured capital no higher than verified balances,
restart API, run ledger/treasury/B-book reconciliation, and only then unpause
through the audited admin endpoint.

## Frontend readiness rule

Use `GET /orders/execution-readiness`. PERP trading is available when
`perp.ready=true`; do not require `perp.bBook.ready=true` when
`perp.aBook.ready=true`. Route selection remains backend-controlled. Open and
reduce-only close buttons can now use A-book while B-book remains safely paused.
