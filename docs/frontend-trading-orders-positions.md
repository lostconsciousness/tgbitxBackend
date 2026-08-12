# Frontend mini-spec: trading, orders, positions and Convert

## 1. Trading mode must be explicit

The UI must keep `SPOT` and `PERP` as different modes.

- Spot BTC purchase sends `symbol: "BTC-USDC"`. It changes the BTC balance and never creates a leveraged position or PnL.
- Leveraged BTC Long/Short sends `symbol: "BTC-PERP"`. Only a filled PERP order creates a position.
- Never infer the API symbol from the displayed base asset alone.

Before enabling the PERP submit button call:

```http
GET /orders/readiness
Authorization: Bearer <access-token>
```

Disable Long/Short and display the returned reason when `perp.ready` is false.
Load symbols and `pricePrecision`, `sizePrecision`, `minOrderSize`, `type` from
`GET /markets`; do not hardcode them.

## 2. Order size

`POST /orders` always accepts `size` in base-asset units, not USDT.

If the input selector is USDT:

```text
baseSize = usdtAmount / markPrice
```

Round down to `market.sizePrecision`. The mainnet pilot accepts new-position
notional from 10 through 100 USDC. Preview and request payload must use the same
mark price.

## 3. Create order

```http
POST /orders
Content-Type: application/json
Authorization: Bearer <access-token>

{
  "symbol": "BTC-PERP",
  "clientOrderId": "<uuid-generated-once-per-click>",
  "side": "BUY",
  "type": "MARKET",
  "size": "0.0002",
  "leverage": 10,
  "reduceOnly": false
}
```

Generate one `clientOrderId` per user action and reuse it only when retrying the
same request after a network timeout.

Order states:

- `PROVIDER_PENDING`, `ROUTED`: accepted, awaiting provider reconciliation; show in Open Orders.
- `OPEN`, `PARTIALLY_FILLED`: show in Open Orders with Cancel when allowed.
- `FILLED`: remove from Open Orders; refresh Positions and Trades.
- `FAILED`, `REJECTED`: show in Order History with `rejectionReason`.
- `CANCELLED`, `EXPIRED`: show in Order History.

Do not show a success toast merely because HTTP returned an order ID. Use the
returned `status`: `FILLED` means executed; pending/open means accepted only.

## 4. Orders UI

Initial load and fallback polling:

```http
GET /orders
```

Required tabs:

- Open Orders: `ROUTED`, `PROVIDER_PENDING`, `OPEN`, `PARTIALLY_FILLED`.
- Order History: all terminal states.
- Trades: use the `trades` array returned with orders or the private socket event.

Columns: market, Spot/Perp, side, type, base size, filled size, requested/average
price, leverage, status, creation time, failure reason, Cancel action.

Cancel only `OPEN`, `PARTIALLY_FILLED` or `PROVIDER_PENDING`:

```http
DELETE /orders/:id
```

## 5. Positions, PnL and close

Initial load:

```http
GET /positions
```

Show only `status: "OPEN"` in the active positions table. Required columns:
market, Long/Short, base size, entry price, mark price, leverage, margin,
liquidation price, unrealized PnL, realized PnL and Close.

`size` is always in the market **base asset** (for `BTC-PERP`, BTC).
`notionalUsdc` is `size * markPrice` in quote asset (USDC). Render size as:

```text
{size} {baseAsset} (${notionalUsdc})
```

Example: `0.00021 BTC ($12.35)`.

PnL values are returned as `unrealizedPnl` and `realizedPnl` in `pnlCurrency`
(USDC for USDC-quoted perps). Do not recalculate the authoritative value on the
client. Color positive values green and negative values red.

Close the full position:

```http
POST /positions/:id/close
```

This creates a reduce-only market order. Keep the position visible as "Closing"
until the close order becomes `FILLED`; then refresh balances, positions and orders.

TP/SL is not part of the opening-order payload. After a position is filled,
create separate reduce-only `STOP_LOSS` and/or `TAKE_PROFIT` orders with the
opposite side, position size and `triggerPrice`.

## 6. Realtime updates

Connect Socket.IO namespace `/private` with:

```ts
io(`${API_URL}/private`, { auth: { token: accessToken } });
```

Consume `orders`, `trades`, `positions`, `balances`, `portfolio`,
`liquidations_snapshot`, `liquidation`, `provider_status` and `risk_alert`.
`liquidations_snapshot` is history/state and must never create a toast on its
own. Only the singular `liquidation` occurrence event may create a toast. The
server emits a fallback snapshot periodically. Emit `resync` immediately after
create, cancel or close. Poll `/orders` and `/positions` every 5-10 seconds if
the socket is disconnected.

## 7. Error rendering

Render `response.data.message`, then `response.data.code`; never replace it with
the generic word "Ошибка". Keep the technical detail in an expandable block.

Important codes/messages:

- `PERP_EXECUTION_UNAVAILABLE`: disable PERP submit and use `/orders/readiness`.
- `PERP_NOTIONAL_TOO_LOW` / `PERP_NOTIONAL_TOO_HIGH`: enforce the 10-100 USDC pilot range.
- `HYPERLIQUID_COLLATERAL_INSUFFICIENT`: master account value is below 25 USDC.
- `CONVERT_EVM_ROUTE_UNFUNDED`: show the safe `routes[]` reasons returned by the API.
- Insufficient balance/margin: refresh `/account/overview` before allowing retry.
- Duplicate client order ID: fetch `/orders` and locate the original request.

## 8. Convert flow

```text
GET  /convert/assets
GET  /convert/readiness
POST /convert/quote
POST /convert/execute
GET  /convert/:id
```

`CONVERT_EVM_ROUTE_UNFUNDED` means no common verified EVM network has both the
source token inventory and native gas in the exchange Privy treasury wallet.
The user's internal USDT balance does not itself fund the on-chain swap.

## Acceptance criteria

1. Spot and PERP cannot silently use each other's symbols.
2. USDT size is converted to base size before submission.
3. Every accepted order is visible immediately in Open Orders.
4. A PERP position appears only after a fill.
5. PnL updates without page reload and Close creates a visible reduce-only order.
6. Provider/configuration errors are shown verbatim and disable repeated submission.
