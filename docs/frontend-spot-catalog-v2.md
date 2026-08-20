# Frontend: Spot catalog v2

## Source of truth

Frontend must not contain a hard-coded Spot symbol list. Load the catalog from:

- `GET /convert/spot-assets`
- `GET /convert/spot-tickers`
- `GET /convert/orderbook/:pair`

`/convert/spot-assets` returns only currently executable pairs. A network or pair disappears when the dedicated `SPOT_LIQUIDITY` reserve has less than the backend-configured stablecoin threshold (currently `10 USDC` in production), insufficient native gas, no live price, no two-way 1inch quote, or no order book. Frontend must not hard-code this threshold.

Use `catalogVersion` to invalidate the local market list and `asOf` to detect a stale response. Do not re-add legacy `SPOT` markets or rows with missing ticker/order-book data.

The current production catalog version is `spot-liquidity-v3`. A version change
must clear any persisted pair order, ticker cache, selected pair snapshot, and
order-book subscription before rendering the new catalog.

## Rendering

1. Render the asset selector from `assets` and the market selector from `pairs`.
2. Use `pair.symbol` as the key and `pair.preferredNetwork` for informational routing metadata. Network selection is automatic and must not be user-editable.
3. Join ticker data by exact pair symbol. Do not substitute a PERP, TradingView, CoinGecko, or unrelated exchange price.
4. Load the book from `/convert/orderbook/${encodeURIComponent(pair.symbol)}`. If the pair disappears from a later catalog response, close its order form and select the first available pair.
5. Refresh catalog every 60 seconds and tickers every 15 seconds. Bootstrap the
   order book once over REST, then use the Spot websocket events below. Do not
   add a second 5–12 second frontend polling loop. Keep the last valid snapshot
   during a transient request failure, but mark it stale and disable order
   submission.
6. After a conversion commit, consume the private `balances` event and refresh the selected ticker/book. Do not wait for a page reload.

### Price and 24h fields

Use `pair.ticker.lastPrice` (or the exact-symbol entry returned by
`GET /convert/spot-tickers`) as the current Spot price.

The executable price remains the 1inch Spot price. When the same underlying is
available as a Hyperliquid perpetual, the backend enriches the ticker with
reference statistics and sets
`statsProvider: "HYPERLIQUID_PERP_REFERENCE"`. `priceChangePct24h`,
`volume24h`, and `notional24h` are reference-market statistics, not the
execution price. Assets without an exact reference match keep these fields
nullable.

Frontend must:

- render `—` when a field is `null`, `undefined`, an empty string, or not finite;
- never call `Number(null)` and never render `NaN%`;
- label or treat enriched metrics as reference statistics;
- treat an external/TradingView chart as a reference chart only, not as the
  source for the Spot ticker or executable price.
- preserve the backend pair order, which is descending by `notional24h`;
- when client-side re-sorting is required, sort numerically by
  `notional24h` descending and put nullable values last. Do not sort by raw
  `volume24h`, because base-token quantities are not comparable across assets.

Example guard:

```ts
function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
```

### Spot order book

Bootstrap the selected pair with:

```text
GET /convert/orderbook/AXS-USDC
```

The response contains `bids` and `asks`; render these arrays directly. Do not
call `/market-data/orderbook/:symbol` for Spot because that endpoint is the
PERP/Hyperliquid book.

The first response is a 12-level `quality: "REFERENCE_SEED"` snapshot generated
from the current 1inch Spot ticker and should render immediately. The websocket
then replaces it with a 12-level `quality: "ONEINCH_QUOTED"` snapshot built from
real 1inch depth anchors. Both are explicitly `indicative: true`; order
execution still obtains a fresh conversion quote.

For realtime updates, reuse the Socket.IO `/market-data` namespace but use the
Spot-specific events:

```ts
socket.emit('subscribeConvertOrderbook', { pair: selectedPair.symbol });
socket.on('convertOrderbook', (snapshot) => {
  if (snapshot.symbol === selectedPair.symbol) {
    setOrderbook(snapshot);
  }
});

// Before switching pair or unmounting:
socket.emit('unsubscribeConvertOrderbook', { pair: selectedPair.symbol });
socket.off('convertOrderbook');
```

Do not use `subscribeOrderbook` or listen to `orderbook` for a Spot market.

## No availability banner

Remove the yellow “trading unavailable”, readiness, liquidity, reconciliation,
or provider-status banner from the public trading screen in both Spot and PERP
modes. Do not leave an empty yellow container behind.

`GET /convert/spot-assets` is already the Spot availability gate: render only
returned pairs. Operational readiness reasons belong in admin tooling and must
not be shown to users. A submit failure may be shown as a contextual toast next
to the order form, but it must not create a persistent global banner.

## Empty and unauthenticated states

The public catalog, ticker, and order-book requests do not require a connected wallet. Show markets in both authenticated and unauthenticated states. Authentication is required only when the user submits a quote/order.

If no pair is executable, show a neutral empty state such as “Spot markets are temporarily unavailable”. Do not show internal readiness reasons, wallet IDs, reserve balances, provider errors, or “Checking PERP availability”.

## Order flow

Use the existing conversion quote and execution endpoints. Submit only symbols present in the latest catalog. Treat provider-pending responses as pending and reconcile by conversion ID; never create a second conversion with a new client id while the first is unresolved.

## Acceptance checklist

- No frontend Spot symbol hard-code remains.
- Every rendered pair has a ticker and a non-empty executable order book.
- Selecting an asset never opens an empty market.
- A committed buy/sell updates balances without refresh.
- Removing liquidity from a network removes its pairs on the next catalog refresh.
- Unauthenticated users can browse the same executable catalog.
