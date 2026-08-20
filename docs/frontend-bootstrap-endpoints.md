# Frontend migration: split account bootstrap

`GET /account/overview` remains available for backward compatibility, but is deprecated.
New clients must load independent resources in parallel and fetch on-chain/history data lazily.

## Initial authenticated screen

Start these requests in parallel:

```text
GET /auth/me
GET /wallets
GET /ledger/balances
GET /positions?status=OPEN
GET /orders/open              # only on trading screens
GET /portfolio                # optional aggregate
```

Recommended React Query policy:

| Query | queryKey | staleTime |
| --- | --- | ---: |
| `/auth/me` | `['auth', 'me']` | 60 seconds |
| `/wallets` | `['wallets']` | 60 seconds |
| `/ledger/balances` | `['balances']` | 5-15 seconds; update from private socket |
| `/portfolio` | `['portfolio']` | 5-15 seconds; update from private socket |
| `/orders/open` | `['orders', 'open']` | socket-first, REST fallback |
| `/positions?status=OPEN` | `['positions', 'open']` | socket-first, REST fallback |

`/auth/me` keeps the existing top-level user fields and adds `environment`, so the migration is backward compatible.

## Lazy resources

Only request these when their page, tab, or modal is opened:

```text
GET /deposits/addresses
GET /deposits/intents
GET /wallets/onchain-balances
GET /wallets/connected-balances
GET /positions/history?limit=20&cursor=<opaque-position-id>
GET /positions/{positionId}/liquidations
```

History response:

```json
{
  "items": [],
  "nextCursor": null
}
```

Pass `nextCursor` unchanged to the next request. `limit` defaults to 20 and cannot exceed 50.
Position list responses never contain `liquidations`; fetch them only for position details.

## Asset/network metadata

Use these public cacheable endpoints as the metadata source:

```text
GET /assets
GET /assets/{symbol}
```

`/ledger/balances` only contains compact asset identity fields and amounts. It does not repeat token contracts or network metadata. Map metadata by `asset.symbol` or `asset.id`.

`/wallets/onchain-balances` and `/wallets/connected-balances` return `network` as a stable network key, not a duplicated network descriptor. Resolve its display name/icon from the assets/network catalog already held by the client.

## Realtime invalidation

Keep the private socket as the primary update path:

- `balances` invalidates/replaces `['balances']` and `['portfolio']`;
- `orders` invalidates/replaces `['orders', 'open']`;
- `positions` invalidates/replaces `['positions', 'open']`;
- wallet changes invalidate `['wallets']` and lazy connected balances.

Do not refetch `/account/overview` after an order, deposit, conversion, or wallet event.

## Compatibility and removal

The legacy overview now returns only open positions and no nested liquidation history. Remove all frontend reads of `/account/overview`, then the backend can delete its remaining expensive on-chain composition in a later release without affecting users.
