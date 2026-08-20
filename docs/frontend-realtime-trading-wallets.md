# Frontend integration: realtime trading, order actions and wallets

This document is the frontend contract for trading state after the backend
realtime/performance update. The frontend must treat REST responses as the
initial snapshot and private Socket.IO events as the authoritative incremental
refresh path.

## 1. Private realtime connection

Connect Socket.IO to namespace `/private` with the current access token:

```ts
import { io } from 'socket.io-client';

const socket = io(`${API_ORIGIN}/private`, {
  transports: ['websocket'],
  withCredentials: true,
  auth: { token: accessToken },
});
```

On connection the server sends a complete snapshot. Afterwards it sends only
data affected by committed changes. A full fallback snapshot is sent every 30
seconds by default.

Subscribe before rendering trading screens:

```ts
socket.on('balances', (balances) => accountStore.setBalances(balances));
socket.on('portfolio', (portfolio) => accountStore.setPortfolio(portfolio));
socket.on('orders', (orders) => tradingStore.setOrders(orders));
socket.on('positions', (positions) => tradingStore.setPositions(positions));
socket.on('trades', (trades) => tradingStore.setTrades(trades));
socket.on('deposits', (deposits) => accountStore.setDeposits(deposits));

socket.on('account_updated', ({ kinds, occurredAt }) => {
  // Optional telemetry only. The typed events above already contain fresh data.
  metrics.mark('account_updated', { kinds, occurredAt });
});
```

Do not wait for the 30-second fallback to update UI. Do not add a second
one-second polling loop. On reconnect emit `resync` once:

```ts
socket.on('connect', () => socket.emit('resync'));
```

## 2. Closing a position and immediate balance update

Endpoint:

```http
POST /positions/:positionId/close
Authorization: Bearer <access-token>
```

UX sequence:

1. Disable the Close button only for that position and show `Closing…`.
2. Send the request once. Keep one client idempotency action in flight.
3. The HTTP response may be `PROVIDER_PENDING`, `PARTIALLY_FILLED`, `FILLED` or
   `CANCELLED`. A pending response means accepted, not completed.
4. Keep the position visible until a `positions` event reports it `CLOSED` or
   reports a smaller remaining size.
5. Replace balances exclusively from the next `balances` event. The backend
   emits it immediately after the fill/ledger transaction commits, together
   with `portfolio`, `orders` and `positions`.
6. Remove the busy state when the matching position changes or a terminal order
   arrives. Show a retry action on request failure.

Never calculate the final balance in the browser. An optimistic visual hint is
allowed, but the authoritative value is the `balances` event.

Expected normal latency after provider fill is one network round trip plus the
configured 25 ms event coalescing window. Provider execution itself can take
longer and must remain visibly pending.

## 3. Open orders and Cancel button

Open Orders contains these statuses:

```ts
const OPEN_ORDER_STATUSES = new Set([
  'ROUTED',
  'PROVIDER_PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
]);
```

Show the Cancel button for:

```ts
const CANCELLABLE_ORDER_STATUSES = new Set([
  'PROVIDER_PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
]);
```

Component behavior:

```tsx
const cancellable = CANCELLABLE_ORDER_STATUSES.has(order.status);

<Button
  disabled={!cancellable || cancellingOrderIds.has(order.id)}
  onClick={() => cancelOrder(order.id)}
>
  {cancellingOrderIds.has(order.id) ? 'Cancelling…' : 'Cancel'}
</Button>
```

Cancellation request:

```http
DELETE /orders/:orderId
Authorization: Bearer <access-token>
```

Do not immediately remove the row after HTTP 200. Replace the order list from
the realtime `orders` event. A partially executed IOC/market order is terminal
when its unfilled remainder is cancelled; backend returns it as `CANCELLED`
while preserving `filledSize`, `averageFillPrice` and trades. Display it in
history as `Partially filled / remainder cancelled` when `filledSize > 0`.

Each open-order row must display:

- market and Spot/Perp type;
- side and order type;
- requested `size` and `filledSize`;
- requested/average fill price;
- leverage and `reduceOnly`;
- current status;
- `rejectionReason` or provider failure reason when present;
- creation time;
- Cancel action when allowed.

## 4. Positions

Render active positions from `positions.filter(p => p.status === 'OPEN')`.
Display market, side, size, entry/mark price, leverage, margin, liquidation
price, unrealized PnL, realized PnL and Close action.

If a close order is partially filled, the next `positions` event contains the
smaller position size and the next `balances` event contains the released
margin/PnL for the filled part. Do not hide the remaining open position.

### Liquidation events

Treat the two realtime messages differently:

```ts
socket.on('liquidations_snapshot', (events: LiquidationEvent[]) => {
  setLiquidationHistory(events); // state replacement only; never show a toast
});

socket.on('liquidation', (event: LiquidationEvent) => {
  upsertLiquidation(event);
  toast.warning('Liquidation', event.symbol ?? 'Position liquidated');
});
```

Do not attach a toast handler to the legacy plural `liquidations` event. An
empty array is not a liquidation, and historical rows must not be replayed as
new notifications after reconnect or fallback polling.

The `orders` and `positions` arrays are authoritative snapshots. Replace local
state rather than merging it by status, and derive open orders only from the
current cancellable/non-terminal statuses. In particular, a `FILLED`,
`CANCELLED`, `FAILED`, or `REJECTED` order must disappear from Open Orders even
if an older local copy was `PROVIDER_PENDING`.

## 5. Wallets page

Initial metadata:

```http
GET /wallets
GET /wallets/capabilities
```

Balances:

```http
GET /wallets/balances
```

The balance endpoint is cached server-side (30 seconds by default), scans only
enabled/supported networks, and uses EVM Multicall3 with an RPC fallback.
Render the previous successful value while refreshing; do not blank the whole
page. Suggested client policy:

```ts
staleTime: 30_000,
gcTime: 5 * 60_000,
refetchOnWindowFocus: false,
retry: 1,
```

Group the response by wallet, then network. Show per asset: symbol, balance,
USDC value, token standard and availability status. `PARTIAL` means at least
one RPC failed; keep successful balances visible and show a small warning for
the affected network.

Invalidate the wallets query after connect, revoke, set-primary or embedded
wallet sync. Do not poll this endpoint every second.

## 6. Loading and error states

- Use row-level pending states for Close and Cancel, never a page-wide spinner.
- Keep the last good snapshot during transient provider/RPC errors.
- Translate `WALLET_ADDRESS_IN_USE` to a clear ownership message.
- Translate provider pending states to `Awaiting execution confirmation`.
- For a terminal partial IOC show both executed and cancelled quantities.
- If the private socket is disconnected, show a reconnect indicator and use
  REST polling no faster than every 15 seconds until reconnected.

## 7. Acceptance checklist

- Closing a filled position changes balance without page reload immediately
  after the backend commit.
- A partial close updates both remaining position size and released balance.
- Cancel is visible for `OPEN`, `PARTIALLY_FILLED`, `PROVIDER_PENDING`.
- Terminal partial IOC orders leave Open Orders and retain their fills/history.
- Reconnecting the socket produces one complete consistent snapshot.
- Wallet page retains old data during refresh and does not issue per-second
  requests.
- Mobile layout exposes Close/Cancel actions without horizontal clipping.
