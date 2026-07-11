# Изменения frontend: плечо, MAX и мобильные позиции

Backend уже возвращает торговые ограничения в обоих публичных запросах:

- `GET /markets`
- `GET /markets/:symbol`

Новые поля каждого рынка:

```json
{
  "symbol": "ETH-PERP",
  "maxLeverage": 10,
  "takerFeeBps": 5
}
```

## 1. Индивидуальное максимальное плечо

1. Добавить в frontend-тип `Market`:

```ts
maxLeverage?: number
takerFeeBps?: number
```

2. Загружать метаданные при каждой смене `backendSymbol`.
3. Для leverage slider использовать `market.maxLeverage`, а не общую константу.
4. Если сохранённое плечо выше нового лимита, уменьшить его до `maxLeverage`.
5. Не разрешать отправлять ордер до получения метаданных рынка либо использовать безопасный fallback `1x`.

## 2. MAX/100% с учётом комиссии

Backend при открытии perpetual-позиции требует:

```text
required = notional / leverage + notional * takerFeeBps / 10000
```

Поэтому максимальный notional:

```ts
const feeRate = takerFeeBps / 10_000
const safeBalance = availableBalance * (1 - 1e-9)
const maxNotional = safeBalance / (1 / leverage + feeRate)
const rawSize = maxNotional / markPrice
const size = Math.floor(rawSize * 10 ** sizePrecision) / 10 ** sizePrecision
```

Для положения ползунка `percent`:

```ts
const selectedNotional = maxNotional * percent / 100
```

Важно:

- округлять размер только вниз по `sizePrecision`;
- использовать цену limit-ордера для limit, mark price для market;
- одинаковую формулу применить к кнопке MAX, процентным кнопкам и draggable slider;
- показывать комиссию из `takerFeeBps`, не хардкодить `5 bps`.

Для spot BUY формула другая:

```ts
const maxNotional = safeBalance / (1 + feeRate)
```

Для spot SELL размер считается от доступного баланса базовой монеты.

## 3. Мобильные позиции и ордера

Сейчас мобильный `MobileBottomPanel` всегда показывает заглушку для вкладок Positions и Orders. Он должен читать те же `positions` и `orders`, которые заполняются private WebSocket и используются desktop-версией.

Для позиций показывать минимум:

- symbol;
- long/short;
- size;
- leverage;
- entry price;
- unrealized PnL.

Фильтр открытых позиций: `status === 'OPEN'`.

Для открытых ордеров использовать тот же набор открытых статусов, что и desktop (`OPEN_ORDER_STATUSES`).

Проверенный случай аккаунта ZA:

- `ETH-PERP`: `LONG`, размер `0.0069`, статус `OPEN`;
- `PENGU-PERP`: `LONG`, размер `2119`, статус `OPEN`.

Ордера частично исполнены, позиции в БД существуют. Причина отсутствия на мобильном — frontend-заглушка, а не списание без открытия позиции.

## 4. Проверка

1. Открыть рынки с разным `maxLeverage` и проверить границы slider.
2. При балансе USDC нажать MAX и открыть long и short без ошибки insufficient balance.
3. Повторить через draggable slider на 100%.
4. Проверить market и limit ордера.
5. На мобильном войти в ZA и увидеть ETH/PENGU в Positions.
6. После reload убедиться, что позиции снова приходят через initial private WebSocket snapshot.
# Required market list, order entry and order book fixes

## Market list

- Load the full price table with one `GET /market-data/tickers` request. Do not call
  `GET /market-data/ticker/:symbol` once per row.
- Join ticker rows to `GET /markets` by exact `symbol`. Render `markPrice`,
  `priceChangePct24h` and `notional24h` from the ticker response.
- Do not sort by price or by the order in which individual requests finish.
- Market capitalization is not the same as 24-hour volume and is not currently
  supplied by this API. Mobile and desktop must use the same explicit market-cap
  rank source. Until that source is added, preserve the product's configured rank;
  do not label volume sorting as capitalization sorting.

## Order book

The `orderbook` Socket.IO event is a complete snapshot, not a delta.

```ts
socket.on('orderbook', (next) => {
  if (next.symbol !== selectedSymbol) return;
  setOrderbook({
    ...next,
    bids: [...next.bids], // replace the old arrays
    asks: [...next.asks],
  });
});
```

- Never merge levels by their array index and never keep an old price while only
  replacing its size.
- Best bid is `bids[0]`, best ask is `asks[0]`; center display price should be
  `(bestBid + bestAsk) / 2` from the same snapshot.
- Render asks above the center with the best ask nearest the center; render bids
  below it with the best bid nearest the center.
- On market change, unsubscribe the old symbol, clear the old book, subscribe the
  new symbol, and ignore events whose `symbol` differs from `selectedSymbol`.

## TradingView price source

Render Hyperliquid perpetuals as `BASE/USDC`. Use `market.quoteAsset.symbol` as
the quote label and `market.tradingViewSymbol` such as
`HYPERLIQUID:FILUSDC` only as the custom-datafeed identifier. Do not convert the
pair to USDT and do not resolve it through Binance.

Use a TradingView Charting Library custom datafeed backed by:

```http
GET /market-data/candles/FIL-PERP?interval=1m&limit=500
```

The endpoint accepts up to 5000 candles and TradingView-compatible Unix seconds:

```http
GET /market-data/candles/BTC-PERP?interval=1h&limit=5000&from=1700000000&to=1718000000
```

Request older ranges when the user scrolls left. Hyperliquid exposes only its most
recent 5000 candles for each interval, so switch to a larger interval for a longer
historical window.

For configured PERP markets this endpoint returns Hyperliquid candles, so chart,
ticker, order book and execution share the same `providerSymbol`. The latest
unfinished candle may be updated from the midpoint of each full `orderbook`
snapshot. Do not combine Binance candles with a Hyperliquid live price.

## Reduce Only and TP/SL

`Reduce Only` means the order may only decrease an existing PERP position. The
client must send the opposite side, a size no greater than the open position, and
`reduceOnly: true`. It cannot be used to open or reverse a position.

TP/SL are separate reduce-only trigger orders created only after the opening order
is filled. Both `B_BOOK_INTERNAL` and `A_BOOK_HYPERLIQUID` are supported. A-book
TP/SL must use the full position size. The backend treats TP and SL for the same
position as OCO siblings: when one triggers, the other is cancelled before one
market close is routed to Hyperliquid.
