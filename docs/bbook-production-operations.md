# B-book production operations

## Safety state

B-book is hybrid and must remain paused until all funding gates pass. A failed gate routes new exposure to Hyperliquid; existing B-book positions always close on their original route.

Required minimums:

```env
BBOOK_ENABLED=true
BBOOK_PAUSED=true
PLATFORM_CAPITAL_USDC=0
INSURANCE_CAPITAL_USDC=0
BBOOK_MIN_PLATFORM_CAPITAL_USDC=500
BBOOK_MIN_INSURANCE_CAPITAL_USDC=100
```

Do not set configured capital above independently verified native USDC held by the dedicated custody wallets.

## Hyperliquid bridge

The master address must hold native Circle USDC and ETH for gas on Arbitrum One. The bridge command has an exact-balance guard and sends only to the official Bridge2 contract.

```bash
npm run hyperliquid:bridge-deposit -- --amount=248.744945
npm run hyperliquid:spot-to-perp
```

If the bridge directly credits Perps, the second command safely reports that Spot USDC is zero. Never run the bridge command with a rounded amount or a different USDC contract.

## Custody provisioning

Create separate restrictive Privy policies, then set:

```env
PRIVY_PLATFORM_CAPITAL_POLICY_ID=
PRIVY_INSURANCE_POLICY_ID=
```

Run `npm run privy:provision-wallets`, store the returned public wallet IDs/addresses, seed custody accounts, fund native USDC on Arbitrum, capture balances, and only then set the configured capital amounts to the verified values.

## Activation

1. Keep `bbook:paused=true`.
2. Run ledger, treasury and B-book reconciliation.
3. Check `GET /admin/risk/bbook/status` and `GET /orders/execution-readiness`.
4. Canary BTC/ETH open and close with small notional.
5. Unpause via `PATCH /admin/risk/pause/bbook` with `{ "enabled": false }`.

Activation is rejected unless the global flag and minimum configured funds pass. The risk monitor automatically pauses on insufficient insurance, insufficient capital or 15% drawdown.

## Frontend/admin behavior

- Use `perp.bBook.ready`, `funded`, `reasons`, `capital`, `insurance`, `availableRiskCapital`, `totalNetExposure` and `unrealizedPlatformPnl`.
- Do not expose route selection or platform balances to normal users.
- Admin UI must show the pause state and reason codes.
- User orders require no B-book-specific request fields; routing remains server-controlled.
