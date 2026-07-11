# Dream Crypto Exchange Backend

Backend-only MVP foundation for the hybrid crypto exchange.

## Current Scope

Phase 1 implements the backend foundation and money-safety layer:

- user registration and login;
- JWT access tokens;
- opaque refresh tokens with rotation;
- logout/session revocation;
- authenticated `/auth/me`;
- PostgreSQL schema via Prisma;
- Redis connection wrapper prepared for later modules;
- wallet connect with SIWE-style nonce/signature verification;
- user-controlled Privy embedded wallet integration;
- assets and markets configuration;
- double-entry ledger accounts, transactions, and entries;
- Arbitrum ERC-20 deposit instructions and indexer foundation;
- verified deposit intents for Trust Wallet/Reown transfers;
- automated withdrawal broadcast/confirmation through Privy custody;
- custody account registry, snapshots and approval-only treasury transfers;
- Hyperliquid A-book adapter and transactional B-book exposure;
- isolated-margin orders, positions, PnL and liquidation foundation;
- authenticated private account WebSocket;
- admin RBAC foundation and audit logs;
- RPC adapter foundation for Arbitrum;
- ledger reconciliation job foundation;
- health endpoints and Swagger.

## Main Endpoints

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`
- `POST /wallets/siwe/nonce`
- `POST /wallets/connect`
- `GET /wallets/capabilities`
- `POST /wallets/embedded/session`
- `POST /wallets/embedded/sync`
- `PATCH /wallets/:id/primary`
- `DELETE /wallets/:id`
- `GET /.well-known/jwks.json`
- `GET /assets`
- `GET /markets`
- `GET /market-data/orderbook/:symbol`
- WebSocket namespace `/market-data`
- `GET /ledger/balances`
- `GET /account/overview`
- `GET /deposits/options`
- `GET /deposits/instructions/:assetSymbol?network=arbitrum`
- `POST /deposits/address`
- `POST /deposits/intents`
- `POST /deposits/intents/:id/submit`
- `GET /deposits/intents/:id`
- `POST /withdrawals`
- `POST /withdrawals/:id/cancel`
- `POST /orders`
- `DELETE /orders/:id`
- `GET /positions`
- `POST /positions/:id/close`
- `POST /admin/assets`
- `POST /admin/markets`
- `POST /admin/deposits/indexer/scan`
- `POST /admin/withdrawals/:id/approve`
- `POST /admin/withdrawals/:id/reject`
- `POST /admin/reconciliation/ledger`
- `GET /admin/treasury/accounts`
- `POST /admin/treasury/snapshots`
- `POST /admin/treasury/transfers`
- `GET /admin/risk/overview`

Private WebSocket namespace: `/private`.

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy environment variables:

   ```bash
   cp .env.example .env
   ```

3. Start infrastructure:

   ```bash
   docker compose up -d postgres redis
   ```

4. Generate Prisma client and run migrations:

   ```bash
   npm run prisma:generate
   npm run migrate:dev
   npm run seed
   ```

5. Start API:

   ```bash
   npm run start:dev
   ```

Swagger is available at `http://localhost:3000/docs`.

The seed creates a dev admin user:

```text
admin@example.com / admin-secure-password
```

The seed also creates order-book markets:

```text
BTC-PERP -> BTC -> TradingView BINANCE:BTCUSDT
ETH-PERP -> ETH -> TradingView BINANCE:ETHUSDT
SOL-PERP -> SOL -> TradingView BINANCE:SOLUSDT
```

## Market Data

Order book snapshot:

```bash
curl http://localhost:3000/market-data/orderbook/BTC-PERP
```

Frontend WebSocket:

```text
namespace: /market-data
emit: subscribeOrderbook { "symbol": "BTC-PERP" }
listen: orderbook
emit: unsubscribeOrderbook { "symbol": "BTC-PERP" }
```

The frontend contract is provider-neutral. Local development defaults to mock
data; set `MARKET_DATA_PROVIDER=HYPERLIQUID` to use the real provider with the
configured fallback:

```ts
type OrderBookData = {
  symbol: string;
  provider: 'MOCK';
  providerSymbol: string;
  time: number;
  bids: { price: string; size: string; orders: number }[];
  asks: { price: string; size: string; orders: number }[];
};
```

WebSocket subscriptions emit an initial snapshot immediately, then one snapshot
per subscribed symbol every second until `unsubscribeOrderbook` or disconnect.

## Hybrid Wallets

The exchange account uses the existing email/password JWT authentication.
Users can connect external EVM wallets through SIWE and can optionally create a
user-controlled Privy embedded wallet. Private keys are never stored or exposed
to the backend.

Privy is disabled until its credentials and JWT signing key are configured.
External SIWE wallets continue to work while Privy is disabled.

Frontend integration and API contracts:

```text
docs/frontend-wallets.md
docs/frontend-withdrawals.md
docs/frontend-testnet-networks.md
docs/frontend-onchain-trading.md
```

## Testnet Safety

The on-chain and trading stack defaults to Arbitrum Sepolia and Hyperliquid
testnet. Mainnet startup is blocked unless `MAINNET_ENABLED=true`.

Custody execution, deposit indexing, withdrawal broadcasting, Hyperliquid
execution and B-book routing are independently disabled by default. Configure
testnet RPC/token addresses and Privy wallet IDs before enabling their workers.

Deposits are network-aware. Use `network` keys such as `arbitrum-sepolia`,
`arbitrum`, `ethereum`, `base`, `optimism`, `polygon`, `bnb`, `avalanche`,
`solana`, or `bitcoin`; only enabled `Network` + `TokenContract` allowlist rows
can accept funds. EVM/ERC-20 is implemented first. Solana/SPL and Bitcoin/UTXO
are seeded as disabled network candidates until their dedicated adapters pass a
canary flow.

## Run Checks

```bash
npm run prisma:generate
npm run build
npm test
npm run test:integration
npm audit --omit=dev
```

`test:integration` uses the PostgreSQL database from `DATABASE_URL` and clears
only records created with its dedicated `integration-wallets-*` test prefix.

Multi-network testnet setup and canary flow:

```text
docs/testnet-network-testing.md
docs/token-allowlist-deposits.md
```

## Quick Auth Smoke Test

Register:

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "content-type: application/json" \
  -d "{\"email\":\"trader@example.com\",\"password\":\"very-secure-password\"}"
```

Login:

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "content-type: application/json" \
  -d "{\"email\":\"trader@example.com\",\"password\":\"very-secure-password\"}"
```

Use the returned `accessToken`:

```bash
curl http://localhost:3000/auth/me \
  -H "authorization: Bearer <accessToken>"
```

Refresh:

```bash
curl -X POST http://localhost:3000/auth/refresh \
  -H "content-type: application/json" \
  -d "{\"refreshToken\":\"<refreshToken>\"}"
```

Logout:

```bash
curl -X POST http://localhost:3000/auth/logout \
  -H "content-type: application/json" \
  -d "{\"refreshToken\":\"<refreshToken>\"}"
```

## Safety Notes

- User balances are rebuilt from ledger entries; no balance column is mutated directly.
- Deposit credits use idempotency key `deposit-credit:<depositId>`.
- Withdrawal reserves use idempotency key `withdrawal-reserve:<withdrawalId>`.
- Rejected withdrawals release the reserved ledger balance with `withdrawal-release:<withdrawalId>`.
- Embedded wallets are user-controlled through Privy; the backend does not store private keys.
