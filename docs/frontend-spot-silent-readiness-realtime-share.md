# Frontend: Spot, silent readiness, instant positions and share-price formatting

This document is the required frontend contract for the trading terminal. The
rules below apply to desktop, mobile web and the installed PWA.

## 1. Non-negotiable UI rules

The trading screen must not render any persistent availability/readiness text.
Remove these strings and every equivalent banner, placeholder or inline block:

- `Проверка доступности PERP…`;
- `Новые позиции временно недоступны…`;
- `Торговля недоступна`;
- `B-book приостановлен`;
- `Капитал платформы не настроен`;
- `Страховой капитал не настроен`;
- provider reconciliation/collateral/readiness reasons.

Do not render an empty banner container after removing its text. The order form
must keep the same layout and height in authenticated and unauthenticated mode.

`GET /orders/execution-readiness` is an authenticated operational signal. It may
be fetched silently after login, but its loading/error/reason state must never
be printed in the terminal. Never call it before authentication.

Readiness must not be the general `disabled` condition for Buy/Sell. A button is
disabled only while its own request is in flight or when the form is invalid
(zero size, invalid price, insufficient entered data). Backend validation on
submit remains authoritative.

If an authenticated submit is rejected, show a short action-scoped toast such
as `Не удалось отправить ордер. Попробуйте ещё раз.` Do not restore a persistent
availability banner and do not expose `A-book`, `B-book`, reconciliation,
capital or provider SDK messages.

### Authentication matrix

| State | Market data/order book | Form | Submit action |
| --- | --- | --- | --- |
| Unauthenticated | Fully visible and updating | Fully visible | `Войти` or `Подключить`, opens auth/wallet flow |
| Authenticated | Fully visible and updating | Fully visible with balance/MAX | Places the order |

Unauthenticated mode is not an error/degraded state. Do not show `Недоступно`,
`Проверка…` or a readiness spinner. Do not connect the private socket until an
access token exists; public market data remains available without a token.

## 2. Working Spot tab

Production Spot execution is the backend `convert` flow backed by 1inch/custody.
Do not use legacy `type=SPOT` rows from `GET /markets`: those rows currently
have no production order-book mapping. Backend now refuses to execute
`POST /orders` Spot orders against a mock book instead of trading at a fake
price.

Load the available Spot assets from this public endpoint in both authenticated
and unauthenticated states:

```http
GET /convert/spot-assets
```

Render exactly the returned `assets` and `pairs`; do not merge them with
`GET /assets`, `/markets` or a local fallback list. The strict catalog already
omits unavailable assets such as native BTC. This endpoint does not require a
token, so the asset selectors and Spot form must be fully rendered before
login. See `docs/frontend-spot-catalog.md` for the response contract. Use the
real TradingView Spot symbol already configured by the frontend for the chart;
never render a backend order book whose response says `provider: "MOCK"`.

The production Spot form is exact-input Market conversion. Hide Limit, TP/SL,
leverage and reduce-only controls completely; do not render them disabled and
do not show an unavailable message.

After authentication, request a short-lived quote:

```http
POST /convert/quote
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "fromAsset": "USDC",
  "toAsset": "WETH",
  "amount": "100",
  "slippageBps": 50
}
```

`amount` is always the exact input amount. BUY means stablecoin in and crypto
out; SELL means crypto in and stablecoin out. Use the returned
`expectedToAmount`, `minToAmount`, fee and expiry for the confirmation preview.

Execute the accepted quote once with a stable client id:

```http
POST /convert/execute
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "quoteId": "<quote-id>",
  "clientConversionId": "spot-<uuid>"
}
```

The execute response can be `PENDING`/`EXECUTING`. Track it with:

```http
GET /convert/:id
```

Stop when it becomes `FILLED`, `FAILED` or `CANCELLED`. Two-second polling is
allowed only for this conversion id and stops at terminal state. Backend emits
fresh `balances`/`portfolio` after reserve, successful settlement or released
failure, so balances must change without a page reload.

Spot UX rules:

- unauthenticated submit opens login; it does not show readiness text;
- request a new quote when the amount, pair or slippage changes;
- never execute an expired quote;
- MAX uses the available exact-input asset balance;
- never call `/spot/swap/build` for exchange balances; it is a separate
  external-wallet signing flow;
- never call `POST /orders` for Spot until backend market metadata explicitly
  reports a non-mock production order-book provider.

## 3. Position must appear immediately after opening

Connect the private namespace once after authentication and register listeners
before allowing an order submit:

```ts
const socket = io(`${API_ORIGIN}/private`, {
  transports: ['websocket'],
  withCredentials: true,
  auth: { token: accessToken },
});

socket.on('positions', (snapshot) => tradingStore.setPositions(snapshot));
socket.on('orders', (snapshot) => tradingStore.setOrders(snapshot));
socket.on('trades', (snapshot) => tradingStore.setTrades(snapshot));
socket.on('balances', (snapshot) => accountStore.setBalances(snapshot));
socket.on('portfolio', (snapshot) => accountStore.setPortfolio(snapshot));
```

The arrays are authoritative snapshots: replace the collection; do not append
an old local copy and do not wait for a page reload. Render open positions from:

```ts
positions.filter((position) => position.status === 'OPEN');
```

Backend behavior after this release:

- after the fill/ledger transaction commits, `positions`, `orders` and `trades`
  are emitted independently of the slower balance/overview calculation;
- the immediate position snapshot uses the committed database mark/entry price
  and does not wait for an external RPC or market-data request;
- `balances` and `portfolio` follow as soon as overview is ready;
- production Spot conversions emit balance/portfolio updates after reserve and
  terminal settlement; future provider-backed Spot order fills also emit
  orders/trades immediately after commit.

After an order HTTP response:

- keep the submit button busy only for that request;
- do not reload the page;
- `PROVIDER_PENDING` remains in Open Orders;
- when the `positions` event arrives, render the new position immediately;
- as a disconnected-socket fallback only, call `GET /positions`, `GET /orders`
  and `GET /account/overview` once. Do not add one-second polling.

On reconnect, emit `resync` once. The fallback poll while disconnected must not
run faster than every 15 seconds.

## 4. Entry/exit prices in Share Position

`GET /positions` and the realtime `positions` payload now include:

```ts
type Position = {
  entryPrice: string;
  exitPrice: string | null;
  markPrice: string;
  pricePrecision: number;
  sizePrecision: number;
  displayPricePrecision: number;
  // existing fields omitted
};
```

`exitPrice` is the committed final close price for a closed position. For an
open position it is `null`; show `Текущая цена` using `markPrice`, not a fake
exit price.

Always format Entry and Exit/Current using `displayPricePrecision`:

```ts
function formatPositionPrice(value: string, precision: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    useGrouping: true,
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(Number(value));
}

const entry = formatPositionPrice(
  position.entryPrice,
  position.displayPricePrecision,
  locale,
);
const exitOrCurrent = formatPositionPrice(
  position.exitPrice ?? position.markPrice,
  position.displayPricePrecision,
  locale,
);
```

Backend display policy:

- BTC: `0` decimal places, for example `64 810`;
- ETH and other high-priced markets: market precision, commonly `2`;
- markets priced at `0.001` or above: market precision capped at `5`, for
  example PENDLE `1.61625`;
- extremely low-priced markets preserve their market precision up to `8`, so
  PEPE-like prices do not collapse to zero;

Do not use one global `toFixed(2)` and do not infer precision from the length of
the current string. The same formatted values must be used in the share image,
share preview and downloaded image.

## 5. Acceptance checklist

1. Logged-out Perp and Spot screens contain no readiness/disabled-trading text.
2. Logged-in Perp and Spot screens contain no B-book/capital/reconciliation
   banner.
3. Public charts, order books and tickers work without authentication.
4. Logged-out submit opens login/connect instead of showing `Недоступно`.
5. Spot Market BUY/SELL uses `/convert/quote` + `/convert/execute` and updates
   balances without reload.
6. A mock Spot book is never used for an order; the frontend never renders
   `provider: "MOCK"` as real market data.
7. A newly filled Perp position appears from the next `positions` socket event
   without reload.
8. A slow/failing overview request cannot delay the `positions` event.
9. Share BTC Entry/Exit has no decimal part.
10. Share PENDLE Entry/Exit uses five decimals.
11. Closed position uses `exitPrice`; open position labels `markPrice` as current
    price.
