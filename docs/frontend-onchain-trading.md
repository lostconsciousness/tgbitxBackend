# Frontend Integration: On-chain Funds And Trading

The current environment is testnet-only:

```ts
const chainId = 421614; // Arbitrum Sepolia
```

Mainnet startup is blocked unless the backend explicitly enables it.

For multi-testnet deposit/withdrawal integration, use
`docs/frontend-testnet-networks.md`. It documents the current network-aware API
for Base Sepolia, OP Sepolia, Polygon Amoy, BNB Testnet, Avalanche Fuji and
Ethereum Sepolia.

## CEX-style Deposit From Any Source

```http
POST /deposits/address
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "assetSymbol": "USDC" }
```

Response:

```ts
interface PersonalDepositAddress {
  id: string;
  network: "ARBITRUM_SEPOLIA";
  chainId: 421614;
  address: `0x${string}`;
  asset: {
    symbol: "USDC";
    tokenAddress: `0x${string}`;
    decimals: 6;
  };
  requiredConfirmations: number;
  status: "ACTIVE";
  acceptsFromAnyAddress: true;
}
```

Show the address and QR. No connected wallet and no amount are required.
Deposits are matched by token contract plus destination address, so Bybit,
MetaMask, Trust Wallet, or another compatible source can send funds.

## Deposit From A Connected Web3 Wallet

Trust Wallet is opened by Reown AppKit/WalletConnect on the frontend. The
backend never opens a wallet app and never signs a user transaction.

This optional flow powers the "Transfer to exchange" button in the personal
Web3 wallet view.

### 1. Create intent

```http
POST /deposits/intents
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "assetSymbol": "USDC",
  "amount": "100.25",
  "walletId": "connected-wallet-id"
}
```

Response:

```ts
interface DepositIntentResponse {
  id: string;
  status: "PENDING";
  expiresAt: string;
  transfer: {
    chainId: 421614;
    tokenAddress: `0x${string}`;
    recipient: `0x${string}`;
    amount: string;
    rawAmount: string;
    decimals: number;
    assetSymbol: string;
    fromAddress: `0x${string}`;
  };
}
```

### 2. Send ERC-20 transfer

Use Wagmi/Viem `writeContract` with the ERC-20 `transfer` function. Pass
`transfer.recipient` and `BigInt(transfer.rawAmount)`. Do not calculate token
decimals again on the frontend.

WalletConnect opens Trust Wallet on mobile and returns the transaction hash.

### 3. Submit transaction

```http
POST /deposits/intents/:id/submit
```

```json
{
  "txHash": "0x..."
}
```

The backend independently verifies:

- network and token contract;
- connected sender address;
- the user's personal custody deposit recipient;
- exact raw amount;
- successful ERC-20 Transfer log;
- confirmations and duplicate protection.

Poll `GET /deposits/intents/:id` or listen to the private socket. A submitted
hash is not proof of payment until status becomes `CREDITED`.

## Withdrawals

```http
POST /withdrawals
```

```json
{
  "assetSymbol": "USDC",
  "amount": "50",
  "toAddress": "0x..."
}
```

Lifecycle:

```text
PENDING_APPROVAL -> APPROVED -> BROADCASTING -> BROADCASTED -> CONFIRMED
```

Before approval:

```http
POST /withdrawals/:id/cancel
```

The requested amount and fee are reserved immediately in the internal ledger.
Never display `APPROVED` or `BROADCASTED` as completed; only `CONFIRMED` is
final.

## Orders

```http
POST /orders
```

```json
{
  "symbol": "BTC-PERP",
  "clientOrderId": "frontend-uuid",
  "side": "BUY",
  "type": "MARKET",
  "size": "0.001",
  "leverage": 5,
  "reduceOnly": false
}
```

Supported types:

```ts
type OrderType = "MARKET" | "LIMIT" | "STOP_LOSS" | "TAKE_PROFIT";
type OrderSide = "BUY" | "SELL";
type ExecutionRoute = "A_BOOK_HYPERLIQUID" | "B_BOOK_INTERNAL";
```

For `LIMIT`, send `price`. For stop-loss/take-profit, send `triggerPrice`.
`clientOrderId` must be stable across retries.

Endpoints:

```text
GET    /orders
DELETE /orders/:id
GET    /positions
POST   /positions/:id/close
```

Only isolated margin is currently supported. The backend validates leverage,
market status, mark freshness, balance and exposure limits.

## Trading UI Mini-Spec

The frontend trading terminal should treat `/account/overview` and private
WebSocket events as the source of truth. Do not calculate exchange balances from
wallet balances.

### Provider And Readiness Status

Use these endpoints for status banners and admin diagnostics:

```text
GET /health/ready
GET /health/provider-status
GET /admin/provider/status
GET /admin/reconciliation/runs
```

If `marketDataProvider` is `MOCK`, show a clear demo/degraded label. Production
backend rejects mock market data configuration. If `oneInchEnabled` or
`hyperliquidExecutionEnabled` is false, hide real external execution actions or
show them as disabled.

### Terminal Market Data

REST endpoints for initial terminal load:

```text
GET /market-data/orderbook/:symbol
GET /market-data/ticker/:symbol
GET /market-data/trades/:symbol?take=50
GET /market-data/candles/:symbol?interval=1m&limit=200
```

Candles and recent trades are currently built from internal `Trade` records.
The market-data socket remains the source for live orderbook updates.

```ts
const marketSocket = io(`${API_URL}/market-data`);
marketSocket.emit("subscribeOrderbook", { symbol: "BTC-PERP" });
marketSocket.on("orderbook", renderOrderbook);
```

Supported candle intervals:

```text
1m 5m 15m 1h 4h 1d
```

### Spot Order Form

Spot symbols use the `BASE-QUOTE` format, for example `BTC-USDC`.

There are two spot paths:

- Internal exchange order: `POST /orders`.
- Wallet-signed 1inch swap: `/spot/quote` and `/spot/swap/build`.

Market buy/sell:

```json
{
  "symbol": "BTC-USDC",
  "clientOrderId": "frontend-uuid",
  "side": "BUY",
  "type": "MARKET",
  "size": "0.001"
}
```

Limit buy/sell:

```json
{
  "symbol": "BTC-USDC",
  "clientOrderId": "frontend-uuid",
  "side": "BUY",
  "type": "LIMIT",
  "size": "0.001",
  "price": "65000"
}
```

Frontend requirements:

- Show available base and quote balances from `/account/overview`.
- For spot `BUY`, estimate required quote as `size * price + fee`.
- For spot `SELL`, estimate required base as `size`.
- Show taker fee estimate; current default backend fee is `5 bps` unless admin
  config changes it.
- Display open spot limit orders as reserved funds. Reserved funds should not be
  shown as freely spendable.
- Allow cancel for `OPEN` spot limit orders via `DELETE /orders/:id`.
- Do not show stop-loss/take-profit controls for spot yet; backend rejects them.

### 1inch Wallet-Signed Spot Swap

The backend does not sign swaps. It only returns quote/swap payloads. The
frontend sends the transaction with the user's wallet.

Quote:

```http
GET /spot/quote?fromTokenAddress=0x...&toTokenAddress=0x...&amount=1000000
Authorization: Bearer <accessToken>
```

Build swap transaction:

```http
POST /spot/swap/build
Authorization: Bearer <accessToken>
Content-Type: application/json
```

```json
{
  "fromTokenAddress": "0x...",
  "toTokenAddress": "0x...",
  "amount": "1000000",
  "walletAddress": "0x...",
  "slippage": "0.5"
}
```

Frontend requirements:

- Use raw token units for `amount`.
- If response status is `DISABLED`, show provider unavailable instead of an
  error toast loop.
- The returned swap transaction must be signed and broadcast by the user's
  wallet.
- After broadcast, use normal deposit/indexer/account flows to reflect exchange
  balances; do not credit internal balances directly from the 1inch response.

### Perp Order Form

Perp symbols use the `BASE-PERP` format, for example `BTC-PERP`.

Open position:

```json
{
  "symbol": "BTC-PERP",
  "clientOrderId": "frontend-uuid",
  "side": "BUY",
  "type": "MARKET",
  "size": "0.001",
  "leverage": 5,
  "reduceOnly": false
}
```

Close position:

```json
{
  "symbol": "BTC-PERP",
  "clientOrderId": "frontend-uuid",
  "side": "SELL",
  "type": "MARKET",
  "size": "0.001",
  "leverage": 5,
  "reduceOnly": true
}
```

Frontend requirements:

- Show isolated margin mode only.
- Require leverage for new perp positions.
- Show estimated notional, margin, fee, liquidation price and route after the
  order is returned.
- For reduce-only close, side must be opposite to the position:
  - LONG closes with `SELL`;
  - SHORT closes with `BUY`.
- Position state comes from `GET /positions` and private `positions` events.

### Stop-Loss And Take-Profit

Stop-loss and take-profit are currently backend-managed B-book trigger orders.
They are not sent to Hyperliquid yet.

```json
{
  "symbol": "BTC-PERP",
  "clientOrderId": "frontend-uuid",
  "side": "SELL",
  "type": "STOP_LOSS",
  "size": "0.001",
  "leverage": 5,
  "reduceOnly": true,
  "triggerPrice": "62000"
}
```

Rules the frontend must enforce before submit:

- Trigger orders are PERP-only.
- Always send `reduceOnly: true`.
- Require an open position.
- Size cannot exceed open position size.
- LONG trigger side is `SELL`; SHORT trigger side is `BUY`.
- `STOP_LOSS` and `TAKE_PROFIT` require `triggerPrice`.
- Trigger orders appear as `OPEN` until the backend matcher fires them.

Trigger display:

- Show open stop-loss/take-profit orders in the same open orders table.
- Show `triggerPrice`, `reduceOnly`, `side`, `size`, and `status`.
- Allow cancel while status is `OPEN`.
- When triggered, status moves through `ROUTED` to `FILLED`; then a trade and
  position update arrive over the private socket.

### Order Statuses

Use these status meanings in UI:

```text
OPEN              waiting; cancellable
ROUTED            backend claimed the order for execution
PROVIDER_PENDING  external provider accepted/pending
PARTIALLY_FILLED  partially executed
FILLED            completed
CANCELLED         cancelled or no longer valid
FAILED            execution failed
REJECTED          validation/risk rejected
```

For MVP:

- Internal spot market orders normally return `FILLED`.
- Internal spot limit orders start as `OPEN`.
- PERP stop-loss/take-profit start as `OPEN`.
- Do not display `ROUTED` as final; wait for `FILLED`, `OPEN`, `FAILED`, or
  `CANCELLED` after resync.

### Balances, Fees And Reserved Funds

Frontend should display three separate concepts:

- `available`: spendable exchange spot balance from `/account/overview`.
- open order reserve: funds locked by `OPEN` spot limit orders.
- perp margin: funds moved from spot into isolated margin for open positions.

Fee display:

- Trading fee is charged in quote asset for spot.
- Perp close/trigger fees are settled from isolated margin/PnL.
- Show fee estimates as estimates; final fee comes from the returned order/trade.

### Private WebSocket Usage

Subscribe once after login:

```ts
const socket = io(`${API_URL}/private`, {
  auth: { token: accessToken },
});
```

Required handling:

- On `connect` and `reconnect`, emit `resync`.
- Replace local `balances`, `orders`, `trades`, and `positions` with socket
  payloads. Replace liquidation history only from `liquidations_snapshot`.
- `liquidations_snapshot` is always an array and is not a notification. Never
  show a toast merely because this event was received, including for `[]`.
- Show a liquidation toast only for a singular `liquidation` occurrence event
  (or after detecting a previously unseen completed event by its `id`).
- If a mutation succeeds, still wait for socket/resync before final UI state.
- Use `provider_status` to show degraded external execution status.
- Use `risk_alert` to highlight near-liquidation positions.

### Frontend Acceptance Checklist

- User can switch between spot and perp markets.
- Spot form hides leverage and trigger controls.
- Perp form shows leverage, reduce-only, SL/TP controls.
- Terminal loads ticker, recent trades, candles and orderbook for selected symbol.
- Open orders table includes spot limits and perp trigger orders.
- Positions table shows side, size, entry, mark, margin, unrealized PnL,
  liquidation price, route and close action.
- Balance panel separates wallet funds, exchange available funds, reserved spot
  funds and perp margin.
- All order submissions use a stable `clientOrderId` across retries.
- Cancel buttons are shown only for `OPEN` or provider-pending cancellable
  orders.
- UI never treats wallet balance as exchange balance.
- Provider status banners show mock/degraded/disabled external providers.

## Private WebSocket

```ts
const socket = io(`${API_URL}/private`, {
  auth: { token: accessToken },
});
```

Events:

```text
balances
deposits
withdrawals
orders
trades
positions
liquidations_snapshot
liquidation
provider_status
risk_alert
```

Emit `resync` after reconnect. The namespace rejects missing, expired or
revoked-session JWTs.

## Important Balance Distinction

- Wallet balance: assets in Trust Wallet/Privy.
- Exchange spot balance: internal double-entry ledger.
- Perp margin: spot funds reserved for an isolated position.
- Treasury/provider balances: platform custody and liquidity, never a user UI
  balance.

Frontend must use `/account/overview` as the exchange account source of truth.
