# Frontend: закрытие PERP-позиций и execution readiness

## Что произошло

Закрывающий пользовательский ордер имеет `reduceOnly: true`, но A-book исполняется через общий Hyperliquid omnibus-счёт. Для сохранения общей хедж-позиции backend может отправлять провайдеру обычный delta-order. Если collateral omnibus-счёта недостаточен, Hyperliquid возвращает `Insufficient margin`.

Backend сначала сверяет общую внутреннюю A-book позицию с фактической позицией omnibus-счёта. Если уже существующий provider hedge полностью или частично покрывает закрытие и его использование не увеличивает расхождение, эта часть закрывается сразу без лишнего provider-order. Остаток отправляется в Hyperliquid. После commit через realtime отправляются свежие `balances`, `orders`, `positions` и производный `portfolio`.

## Readiness

Перед показом формы и непосредственно перед отправкой нового PERP-ордера запрашивать:

```http
GET /orders/execution-readiness
Authorization: Bearer <access-token>
```

Backend также сохраняет прежний `GET /orders/readiness` как совместимый alias. Новый frontend может использовать `GET /orders/execution-readiness`; оба маршрута возвращают один и тот же ответ и требуют Bearer token.

Если `perp.aBook.reasons` содержит `COLLATERAL_INSUFFICIENT`:

- запретить открытие новых A-book позиций;
- показать «Торговая ликвидность временно недоступна»;
- не трактовать `accountValue` как баланс пользователя — это collateral провайдера;
- закрытие существующей позиции можно отправить, но необходимо корректно показать окончательный `FAILED`, если провайдер его отклонит.

`perp.aBook.withdrawable` — свободный collateral провайдера. Нулевое значение блокирует новый A-book риск даже при положительном `accountValue`.

Если `perp.aBook.reasons` содержит `PROVIDER_POSITION_MISMATCH`, новые открытия остановлены автоматической reconciliation-защитой. Существующие позиции по-прежнему можно закрывать.

Важно: `perp.ready=false` блокирует только создание нового риска (`Buy`/`Sell` для открытия). Кнопку `Close` у уже открытой позиции нельзя отключать по общему readiness; для неё backend применяет отдельную reduce-only/netting логику.

Не показывать пользователю внутренние термины `A_BOOK`, `omnibus`, `asset=0` или исходный текст SDK.

## Закрытие позиции

Отправлять уникальный `clientOrderId` на каждую попытку:

```json
{
  "symbol": "BTC-PERP",
  "clientOrderId": "close-<uuid>",
  "side": "SELL",
  "type": "MARKET",
  "size": "0.00024",
  "leverage": 10,
  "reduceOnly": true
}
```

После ответа API использовать возвращённый `status`:

- `FILLED` — закрытие завершено;
- `PARTIALLY_FILLED` — показать исполненный объём, дождаться terminal-события;
- `PROVIDER_PENDING` — показать «Отправлено провайдеру», кнопку повторного закрытия заблокировать;
- `FAILED` — снова разрешить кнопку закрытия и показать нормализованную причину;
- `CANCELLED` — убрать ордер из активных и снова разрешить действие.

Нельзя оптимистично удалять позицию до `FILLED`. При `FAILED` позиция всё ещё открыта.

У `FILLED` A-book закрытия поле `providerOrder` может быть `null`, если backend полностью исполнил его через уже существующий omnibus hedge. Это нормальный terminal-результат, его нельзя считать ошибкой.

## Realtime

Подписаться на приватные события:

- `balances`;
- `orders`;
- `positions`;
- `portfolio`.

После terminal-события заменить соответствующие локальные коллекции данными события. Fallback polling — раз в 15–30 секунд и после reconnect, а не каждую секунду.

Если realtime временно недоступен, после ответа на закрытие выполнить параллельно:

```http
GET /orders
GET /positions
GET /account/overview
```

## Account overview

Маршрут существует:

```http
GET /account/overview
Authorization: Bearer <access-token>
Cache-Control: no-store
```

Не добавлять второй `/api`, если он уже входит в настроенный API base URL. При `404` логировать полный итоговый URL. При `401` обновить access token и повторить запрос один раз.

## Отображение ошибок

Рекомендуемое сопоставление:

| Backend/provider reason | Сообщение пользователю |
| --- | --- |
| `Insufficient margin` / `HYPERLIQUID_COLLATERAL_INSUFFICIENT` | «Торговая ликвидность временно недоступна. Позиция не была закрыта.» |
| `PERP_EXECUTION_UNAVAILABLE` | «Торговля фьючерсами временно недоступна.» |
| `PROVIDER_POSITION_MISMATCH` | «Новые позиции временно недоступны: выполняется синхронизация ликвидности.» |
| `Reduce-only order requires an open position` | «Позиция уже закрыта или изменилась. Обновите данные.» |
| network/timeout при `PROVIDER_PENDING` | «Проверяем состояние ордера…» — не создавать дубликат автоматически |

## Acceptance criteria

1. Окончательно отклонённый ордер исчезает из списка активных и отображается в истории как `FAILED`.
2. После `FAILED` кнопка закрытия снова доступна, позиция остаётся на экране.
3. После `FILLED` позиция и баланс обновляются realtime-событиями без ручного refresh.
4. При `COLLATERAL_INSUFFICIENT` новые открытия заблокированы понятным сообщением.
5. `GET /account/overview` вызывается по корректному base URL и с Bearer token.
6. Повторная попытка закрытия всегда получает новый `clientOrderId`.
