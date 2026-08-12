# Frontend: TRON deposit и моментальное обновление баланса

Backend самостоятельно индексирует TRX/TRC20 и после подтверждения публикует
события приватного Socket.IO namespace `/private`:

- `deposits` — заменить список депозитов;
- `balances` — заменить биржевые балансы;
- `portfolio` — заменить summary портфеля.

После логина private socket должен подключаться с действующим access JWT в
`handshake.auth.token`. При обновлении JWT старое соединение нужно закрыть и
создать новое с новым токеном. После каждого `connect` backend сам отправляет
полный initial snapshot, поэтому не требуется reload страницы.

Для USDT TRON использовать только пару из `GET /deposits/options`, где network
равен `tron`, затем получить персональный адрес через:

```http
POST /deposits/address
Authorization: Bearer <access-token>
Content-Type: application/json

{ "assetSymbol": "USDT", "network": "tron" }
```

Не путать этот адрес с EVM-адресом, не заменять сеть на BNB/Arbitrum и не
пересчитывать decimals на клиенте. Пока socket отключён, разрешён fallback
`GET /deposits` раз в 15 секунд и однократный `GET /account/overview` после
перехода депозита в `CREDITED`. При подключённом socket polling отключается.

Acceptance:

- перевод USDT TRC20 появляется в `deposits` без reload;
- при `CREDITED` новый USDT сразу виден из события `balances`;
- повторное socket-событие не прибавляет сумму локально: массив/баланс всегда
  заменяется данными backend;
- истёкший JWT обновляется до reconnect, иначе socket не оставляется в вечном
  состоянии «подключение».
