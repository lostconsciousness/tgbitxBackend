# Spot: подключение и финансирование сетей

## Назначение

Spot работает через custody master wallet и 1inch Convert. Наличие записи в
таблице `networks` само по себе не означает, что сеть готова к Spot-торговле.
Backend добавляет сеть в публичный каталог только при одновременном выполнении
всех условий:

1. сеть включена в `CONVERT_EVM_NETWORKS` и `CONVERT_SPOT_NETWORKS`;
2. RPC отвечает правильным mainnet chain ID;
3. 1inch настроен;
4. в сети есть подтверждённый USDC или USDT contract;
5. на custody master есть не меньше минимального stablecoin-резерва;
6. на том же wallet есть нативная монета для газа;
7. у base asset и stablecoin есть подтверждённые контракты в одной сети.

Проверка выполняется backend автоматически и кешируется на 60 секунд.
Frontend не должен самостоятельно определять доступность сети.

## Текущее production-состояние

| Сеть | Chain ID | Stablecoin reserve | Native gas | Spot |
| --- | ---: | ---: | ---: | --- |
| Arbitrum | 42161 | 11.726432 USDC, 0.70503 USDT | 0.0017207 ETH | подключена |
| BNB Chain | 56 | 95.000122985 USDC, 2.985 USDT | 0.0006716 BNB | подключена |
| Avalanche | 43114 | 0 USDC | 0 AVAX | ожидает финансирования |
| Base | 8453 | 0 USDC | 0 ETH | ожидает финансирования |
| Ethereum | 1 | 0 USDC | 0 ETH | ожидает финансирования |
| Optimism | 10 | 0 USDC | 0 ETH | ожидает финансирования |
| Polygon | 137 | 0 USDC | 0 POL | ожидает финансирования |
| Linea | 59144 | нет подтверждённых Spot-токенов | 0 ETH | ожидает contracts и funding |
| zkSync | 324 | нет подтверждённых Spot-токенов | 0 ETH | ожидает contracts и funding |

Celo, Mantle и Scroll присутствуют в общем network registry, но не входят в
текущий `ONEINCH_EVM_NETWORKS` backend. Их нельзя добавлять в frontend до
реализации и проверки provider route в backend.

## Конфигурация

```env
CONVERT_ENABLED=true
CONVERT_EVM_ENABLED=true
ONEINCH_ENABLED=true
CONVERT_EVM_NETWORKS=arbitrum,base,optimism,polygon,bnb,avalanche,ethereum,zksync,linea
CONVERT_SPOT_NETWORKS=arbitrum,base,optimism,polygon,bnb,avalanche,ethereum,zksync,linea
CONVERT_SPOT_CATALOG_CACHE_MS=60000
CONVERT_SPOT_CATALOG_MIN_STABLE_BALANCE=0.1
CONVERT_EVM_GAS_RESERVE=0.00015
```

API key, Privy wallet IDs, authorization keys и RPC URLs в документацию и логи
не выводить.

## Как подключить следующую сеть

### 1. Проверить network и RPC

- network должна быть `mainnet=true`;
- chain ID RPC должен совпадать с таблицей выше;
- RPC URL хранится только в production environment;
- fallback RPC рекомендуется настроить до финансирования.

Публичный provider readiness:

```http
GET /convert/readiness
```

`ready=true` здесь означает исправный RPC/custody/provider, но ещё не означает
наличие торгового резерва. Итоговый источник доступности — только
`GET /convert/spot-assets`.

### 2. Добавить и проверить contracts

Для USDC/USDT и каждой Spot-монеты нужны `TokenContract`:

- правильный network;
- `ERC20` или `NATIVE`;
- on-chain bytecode;
- совпадающие symbol и decimals;
- `contractVerifiedAt` и `verifiedChainId`;
- положительная 1inch quote;
- fee-on-transfer и blacklisted токены запрещены.

Административный порядок:

```http
POST /admin/assets/:symbol/contracts
POST /admin/assets/:symbol/verify-contract?network=<chain-key>
```

Добавление Spot contract не должно автоматически включать депозиты или выводы.
Это отдельное решение и отдельные transfer flags.

### 3. Профинансировать gas

Отправлять нативную монету строго на EVM custody master address в выбранной
сети. Рекомендуемые рабочие резервы выше минимального программного порога:

| Сеть | Native token | Рекомендуемый начальный gas reserve |
| --- | --- | ---: |
| Arbitrum | ETH | 0.002 ETH |
| BNB Chain | BNB | 0.003 BNB |
| Avalanche | AVAX | 0.1 AVAX |
| Base | ETH | 0.002 ETH |
| Optimism | ETH | 0.002 ETH |
| Polygon | POL | 1 POL |
| Ethereum | ETH | 0.005 ETH |
| Linea | ETH | 0.002 ETH |
| zkSync | ETH | 0.002 ETH |

Перед переводом обязательно сверить chain ID и custody address. Нативные монеты
нельзя отправлять через token contract.

### 4. Профинансировать stablecoin inventory

Отправить native/официальный USDC или поддерживаемый USDT на тот же custody
master в нужной сети. Минимум `0.1` позволяет сети появиться в каталоге, но для
реальной торговли нужен рабочий резерв. Рекомендуемый стартовый резерв — не
меньше `100 USDC` на сеть плюс ожидаемый дневной оборот.

Нельзя использовать для inventory:

- непроверенный bridged token с тем же symbol;
- USDC.e вместо native USDC, если в БД настроен native contract;
- средства, необходимые для pending withdrawals;
- B-book insurance и platform capital;
- Hyperliquid collateral.

### 5. Проверить автоматическое появление

Подождать до 60 секунд и запросить:

```http
GET /convert/spot-assets
```

Сеть должна появиться в `pairs[].networks`. Если не появилась, проверить:

- gas balance;
- USDC/USDT balance именно настроенного contract;
- contract verification;
- RPC chain ID;
- 1inch quote;
- backend logs `Spot catalog excluded <network>`.

Перезапуск API для подключения профинансированной сети не требуется.

## Исполнение и лимиты

- Каталог означает наличие минимального рабочего маршрута, а не гарантию
  исполнения любого размера.
- При quote backend проверяет inventory повторно для конкретного `amount`.
- Если первая сеть пары не покрывает amount, backend пробует следующую сеть.
- Network routing выполняет backend. Frontend не передаёт chain ID и не должен
  обещать пользователю исполнение в вручную выбранной сети.
- Балансы пользователей остаются единым exchange ledger; сети являются
  внутренними маршрутами treasury/custody.

## Проверка после подключения

1. `GET /health` возвращает `200`.
2. `GET /convert/spot-assets` содержит новую сеть и не содержит неподдерживаемые
   монеты.
3. Quote `1 USDC -> base asset` успешна.
4. Canary conversion минимального размера получает terminal `FILLED`.
5. Receipt и фактический token delta совпадают.
6. Ledger/custody reconciliation не имеет mismatch.
7. Realtime `balances` и `portfolio` приходят после commit.

## Отключение сети

Для немедленного отключения удалить network из `CONVERT_SPOT_NETWORKS` и
перезапустить API. При исчерпании gas или stablecoin backend автоматически
перестаёт публиковать сеть после истечения кеша, даже если она осталась в env.

