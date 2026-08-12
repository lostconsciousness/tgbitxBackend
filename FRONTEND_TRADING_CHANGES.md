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
