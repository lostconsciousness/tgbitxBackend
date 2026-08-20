# Frontend: строгий каталог доступных Spot-монет

## Что изменилось

Для вкладки Spot единственным источником списка монет и пар является публичный
backend endpoint:

```http
GET /convert/spot-assets
```

Он доступен без авторизации и возвращает только реально подключённые к
production Convert/1inch активы, у которых есть подтверждённый контракт и общая
разрешённая Spot-сеть с USDC или USDT, достаточный стабильный резерв и нативный
газ. Сейчас этим условиям соответствуют Arbitrum и BNB Chain. Backend проверяет
все настроенные сети с минутным кешем, поэтому профинансированная сеть появляется
автоматически без frontend-релиза. Недоступных элементов в ответе нет.

Нельзя строить Spot-список из `GET /assets`, `GET /markets?type=SPOT`, PERP-маркетов,
TradingView symbols или локального массива. Эти справочники содержат активы,
которые используются для депозитов, PERP или исторических mock Spot-рынков и не
обязательно доступны для Spot-исполнения.

## Формат ответа

```ts
type SpotCatalog = {
  execution: 'CONVERT';
  provider: 'ONEINCH';
  assets: Array<{
    symbol: string;
    name: string;
    iconUrl: string | null;
    decimals: number;
    provider: 'ONEINCH';
    networks: string[];
    tradable: true;
  }>;
  pairs: Array<{
    pairKey: `convert:${string}-${string}`;
    symbol: `${string}-${string}`;
    baseAsset: string;
    quoteAsset: 'USDC' | 'USDT';
    provider: 'ONEINCH';
    execution: 'CONVERT';
    preferredNetwork: string;
    networks: string[];
    ticker: SpotTicker | null;
  }>;
  tickers: SpotTicker[];
};

type SpotTicker = {
  symbol: string;
  provider: 'ONEINCH_SPOT_PRICE';
  network: string;
  lastPrice: string;
  markPrice: string;
  priceChange24h: null;
  priceChangePct24h: null;
  volume24h: null;
  notional24h: null;
  time: number;
};
```

Пример:

```json
{
  "execution": "CONVERT",
  "provider": "ONEINCH",
  "assets": [
    {
      "symbol": "WBTC",
      "name": "Wrapped BTC",
      "iconUrl": "https://...",
      "decimals": 8,
      "provider": "ONEINCH",
      "networks": ["arbitrum"],
      "tradable": true
    },
    {
      "symbol": "USDC",
      "name": "USDCoin",
      "iconUrl": "https://...",
      "decimals": 6,
      "provider": "ONEINCH",
      "networks": ["arbitrum"],
      "tradable": true
    }
  ],
  "pairs": [
    {
      "pairKey": "convert:WBTC-USDC",
      "symbol": "WBTC-USDC",
      "baseAsset": "WBTC",
      "quoteAsset": "USDC",
      "provider": "ONEINCH",
      "execution": "CONVERT",
      "preferredNetwork": "arbitrum",
      "networks": ["arbitrum"]
    }
  ]
}
```

## Обязательная логика frontend

1. При открытии Spot один раз запросить `/convert/spot-assets`.
2. Селектор пары строить только из `response.pairs`.
3. Карточки/поиск монет строить только из `response.assets`.
4. Для React keys и хранения выбранной пары использовать `pairKey`, не id из
   `/markets`.
5. BUY: `fromAsset = pair.quoteAsset`, `toAsset = pair.baseAsset`.
6. SELL: `fromAsset = pair.baseAsset`, `toAsset = pair.quoteAsset`.
7. Исполнение только через `POST /convert/quote`, затем `POST /convert/execute`.
8. Не вызывать `POST /orders` для этих пар.
9. Если ранее выбранной пары больше нет в свежем каталоге, молча выбрать первую
   пару; не оставлять недоступную карточку и не показывать readiness-banner.
10. Каталог можно кешировать на клиенте 60 секунд, но при каждом новом открытии
    приложения нужно фоновое обновление.
11. Доступные сети брать только из `pair.networks`. Не хранить локальный список
    сетей и не показывать сеть, отсутствующую у выбранной пары.
12. Цена пары берётся из `pair.ticker.lastPrice`. Для отдельного фонового
    обновления всех цен можно вызывать `GET /convert/spot-tickers` раз в 15 секунд.
    Не использовать PERP ticker, TradingView last price или локальный mock.

## Spot-стакан

Для выбранного `pair.symbol` начальный snapshot:

```http
GET /convert/orderbook/USDT-USDC
```

Ответ содержит `bids`, `asks`, `spreadBps`, `time`, `network` и
`indicative: true`. Это исполнимая агрегированная ликвидность 1inch, а не
внутренний лимитный стакан. На публичном Socket.IO namespace `/market-data`:

```ts
socket.emit('subscribeConvertOrderbook', { symbol: pair.symbol });
socket.on('convertOrderbook', replaceBookSnapshot);

// при смене пары или unmount
socket.emit('unsubscribeConvertOrderbook', { symbol: oldPair.symbol });
```

Нужно целиком заменять snapshot по событию, не смешивать его с PERP-событием
`orderbook`. Для `USDT-USDC` используется именно дефисный symbol, без ручной
перестановки base/quote.

Если `pair.ticker === null`, пару нельзя показывать в селекторе до следующего
успешного обновления каталога: это означает отсутствие текущих market-data, а
не нулевую цену.

### Multi-network поведение

- `pair.networks` — маршруты, которые backend считает профинансированными прямо
  сейчас.
- `preferredNetwork` — первый автоматический маршрут backend.
- Не добавлять обязательный network selector: exchange ledger общий, а backend
  может перейти на следующий маршрут, если на первом недостаточно inventory для
  конкретного amount.
- Если сеть всё же показывается в UI, это только информационный badge. Не
  передавать `chainId` или `network` в `/convert/quote`: текущий API выбирает
  маршрут самостоятельно.
- При обновлении каталога заменять `pairs` и `assets` целиком. Если сеть исчезла
  из ответа из-за gas/inventory, её badge должен исчезнуть без reload страницы.

## BTC и WBTC

Нативный `BTC` сейчас не имеет production Spot-маршрута в custody/1inch, поэтому
его нет в `/convert/spot-assets` и frontend не должен его показывать во вкладке
Spot. Доступен `WBTC` в Arbitrum — это отдельный актив, и переименовывать его в
`BTC` нельзя.

## Добавленные монеты

Backend onboarding добавляет в Arbitrum Spot-каталог только после трёх проверок:
токен находится в allowlist 1inch, on-chain symbol/decimals/bytecode совпадают и
1inch отдаёт исполнимую котировку USDC → token. Добавлены:

- LINK;
- UNI;
- AAVE;
- PENDLE;
- GMX;
- DAI;
- CRV;
- LDO;
- GRT;
- SUSHI.

Их не нужно прописывать во frontend вручную. Новые активы в дальнейшем появятся
автоматически после backend onboarding.

## Состояния интерфейса

- До загрузки каталога показывать skeleton селектора, без текста
  «торговля недоступна» или «проверка доступности».
- Пустой ответ означает пустой список, а не разрешение использовать локальные
  fallback-монеты.
- HTTP ошибка каталога: сохранить последний успешный кеш; если кеша нет —
  показать обычную ошибку загрузки с Retry, не подставлять BTC или mock markets.
- Авторизация не влияет на видимость каталога. Токен нужен только для quote и
  execute.

## Acceptance checklist

- В Spot нет `BTC`, но есть `WBTC`.
- Нет ни одной монеты, которой нет в `/convert/spot-assets.assets`.
- Нет ни одной пары, которой нет в `/convert/spot-assets.pairs`.
- LINK/UNI/AAVE/PENDLE/GMX/DAI/CRV/LDO/GRT/SUSHI появляются без frontend-констант.
- BUY/SELL используют Convert API, а не `/orders`.
- Список одинаковый до и после авторизации.
