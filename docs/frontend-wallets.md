# Frontend Integration: Hybrid Wallets

The exchange account remains authenticated with the existing email/password API
and exchange JWT. Wallets are linked to that account after login.

Users can:

- connect an external EVM wallet through Reown AppKit and SIWE;
- create one user-controlled embedded Ethereum wallet through Privy;
- keep both wallet modes linked to the same exchange account.

The backend never receives a seed phrase or private key.

## Prerequisites

All `/wallets/*` requests, except the public JWKS endpoint, require:

```http
Authorization: Bearer <exchangeAccessToken>
Content-Type: application/json
```

`GET /wallets/capabilities` returns the default SIWE chain, the full allowed
`siweChains[]` list, and the broader EVM/SVM/TVM network catalog. Register every
`siweChains[].chainId` in wagmi/Reown `chains`. Before SIWE, switch the wallet to
the chain the user selected (or `chain.chainId` as default). Bitcoin, Solana and
Tron are excluded from `siweChains` — external connect is EVM-only.

```ts
interface WalletCapabilities {
  chain: {
    name: string;
    chainId: number;
  };
  /** All EVM networks allowed for external SIWE connect (from MAINNET_ENABLED_NETWORKS). */
  siweChains: Array<{
    network: string;
    displayName: string;
    caip2: string | null;
    chainId: number;
    mainnet: boolean;
  }>;
  networks: Array<{
    network: string;
    displayName: string;
    caip2: string | null;
    chainId: number | null;
    depositEnabled: boolean;
    withdrawalEnabled: boolean;
    mainnet: boolean;
  }>;
  external: {
    enabled: true;
    provider: "SIWE";
  };
  embedded: {
    enabled: boolean;
    provider: "PRIVY";
  };
};
```

Frontend dependencies:

```bash
npm install @reown/appkit @reown/appkit-adapter-wagmi wagmi viem
npm install @privy-io/react-auth
```

A Reown Project ID is required only by the frontend. Privy App ID and Client ID
are public frontend configuration values; the Privy App Secret must never be
sent to the frontend.

## Public Types

```ts
type WalletType = "EXTERNAL" | "EMBEDDED";
type WalletProvider = "SIWE" | "PRIVY";
type WalletStatus = "ACTIVE" | "REVOKED";

interface ExchangeWallet {
  id: string;
  type: WalletType;
  provider: WalletProvider;
  address: `0x${string}`;
  chain: string;
  label: string | null;
  status: WalletStatus;
  isPrimary: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

```

Provider references and Privy user IDs are intentionally not returned.
Wallet addresses are stored and returned in lowercase; compare addresses
case-insensitively in the UI.

## Capabilities And Wallet List

```http
GET /wallets/capabilities
```

Use `embedded.enabled` to decide whether to show the "Create wallet" action.

```http
GET /wallets
```

Returns `ExchangeWallet[]`. The primary wallet is returned first.

## External Wallet Flow

### 1. Connect through Reown AppKit

Read the active network from `GET /wallets/capabilities`, then switch the
wallet to that chain before requesting the SIWE challenge. Use any entry from
`siweChains[]`; `chain` is the default when the user has not picked a network.

### 2. Request the SIWE message

```http
POST /wallets/siwe/nonce
```

The browser must send its normal `Origin` header. The backend builds `domain`
and `uri` from that origin and accepts it only when it is listed in
`SIWE_ALLOWED_ORIGINS`. Do not construct or modify the SIWE message on the
frontend.

```json
{
  "address": "0x1111111111111111111111111111111111111111",
  "chainId": 421614
}
```

Response:

```ts
interface SiweChallenge {
  address: `0x${string}`;
  nonce: string;
  message: string;
  domain: string;
  uri: string;
  chainId: 42161 | 421614;
  issuedAt: string;
  expiresAt: string;
}
```

The challenge expires after ten minutes by default.

### 3. Sign the exact returned message

```ts
const signature = await signMessageAsync({
  message: challenge.message,
});
```

Do not reconstruct or modify `message` on the frontend.

### 4. Connect the wallet

```http
POST /wallets/connect
```

```json
{
  "address": "0x1111111111111111111111111111111111111111",
  "nonce": "<challenge nonce>",
  "signature": "0x..."
}
```

Returns `ExchangeWallet`.

The nonce is single-use. A failed signature does not consume it, but a
successful request does. Replaying a successful request is rejected.

## Embedded Privy Wallet Flow

This flow uses Privy JWT-based authentication. The exchange remains the auth
provider; do not call Privy's normal login UI.

### 1. Configure `PrivyProvider`

Use the `appId` and optional `clientId` configured for the same Privy
application as the backend.

Mount a component below the exchange auth provider and `PrivyProvider`:

```tsx
import { useSubscribeToJwtAuthWithFlag } from "@privy-io/react-auth";

function PrivyExchangeAuthBridge() {
  const exchangeAuthenticated = Boolean(exchangeAccessToken);

  useSubscribeToJwtAuthWithFlag({
    isAuthenticated: exchangeAuthenticated,
    isLoading: false,
    getExternalJwt: async () => {
      if (!exchangeAuthenticated) return undefined;

      const response = await api.post<PrivySession>(
        "/wallets/embedded/session",
      );
      return response.token;
    },
  });

  return null;
}
```

Cache the session response until shortly before `expiresAt`. Do not persist this
short-lived token in local storage or logs.

Session endpoint:

```http
POST /wallets/embedded/session
```

```ts
interface PrivySession {
  token: string;
  appId: string;
  clientId?: string;
  expiresAt: string;
}
```

### 2. Create the user-owned wallet

```tsx
import { useCreateWallet } from "@privy-io/react-auth";

const { createWallet } = useCreateWallet();

await createWallet();
```

Do not pass `createAdditional: true`. The exchange supports one active embedded
Ethereum wallet per user.

Automatic Privy wallet creation on login can be enabled instead, but manual
creation is recommended for the first version because it matches an explicit
user choice.

### 3. Sync the verified wallet to the exchange

```http
POST /wallets/embedded/sync
```

No request body is required. The backend looks up the current exchange
`user.id` through Privy's custom-auth API and accepts only the embedded Ethereum
wallet returned by Privy.

The response is `ExchangeWallet`. Calling sync repeatedly is safe and does not
create duplicate database records.

## Primary And Revoke

Set an active wallet as primary:

```http
PATCH /wallets/:walletId/primary
```

Revoke the exchange connection:

```http
DELETE /wallets/:walletId
```

Revoking does not delete or disable the actual external/Privy wallet. It only
prevents that address from being used for new automatic deposit matching. If
the primary wallet is revoked, another active wallet becomes primary.

## Deposits

Exchange deposits and personal Web3 wallets are separate surfaces.

For the CEX-style deposit screen call:

```http
POST /deposits/address
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "assetSymbol": "USDC" }
```

The backend lazily creates one personal custody address per user and EVM
network. Show `address` as text and QR. The address accepts transfers from any
compatible source, including another exchange. Do not request a connected
wallet or amount on this screen.

`GET /deposits/address/USDC` returns an already-created address and never
creates one. The compatibility endpoint
`GET /deposits/instructions/USDC` returns the same personal address with
`acceptsFromAnyAddress: true`.

The separate "Transfer to exchange" button inside the Web3 wallet continues to
use `POST /deposits/intents`. Its recipient is now the same personal custody
address.

## Transfers

There are three different transfer surfaces. Keep them separate in the UI.

### Exchange withdrawal

Use this when the user wants to move funds from the exchange trading balance to
an external address.

```http
POST /withdrawals
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "assetSymbol": "USDC",
  "amount": "20",
  "toAddress": "0x..."
}
```

The backend reserves the user's ledger balance immediately. The withdrawal is
then approved by admin and broadcast by the configured Privy withdrawal hot
wallet worker. The frontend should poll `GET /withdrawals` or listen to the
private `withdrawals` socket event.

Use this flow for CEX-style withdrawals. It does not spend directly from the
user's embedded wallet.

### Personal Web3 wallet transfer

Use this when the user wants to send funds from their embedded or connected
wallet to another wallet address without moving funds through the exchange
ledger.

This is a frontend wallet transaction, not a backend withdrawal. The backend
does not receive private keys and does not broadcast this transaction for the
user.

Frontend flow:

1. Read the wallet from `GET /wallets` or `GET /account/overview`.
2. Ensure the wallet is on the configured chain from `GET /wallets/capabilities`.
3. For native ETH, call the wallet client's `sendTransaction`.
4. For ERC-20, call token contract `transfer(to, rawAmount)`.
5. Show the resulting transaction hash and track it with the chain explorer or
   RPC.

Do not change `overview.balances` after this transfer. It only changes
`overview.onChainBalances`.

### Deposit from wallet to exchange

Use this when the user wants to turn Web3 wallet funds into exchange trading
balance.

```http
POST /deposits/intents
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "assetSymbol": "USDC",
  "amount": "20",
  "walletId": "<connected-or-embedded-wallet-id>"
}
```

The response contains the token contract, recipient personal deposit address and
raw amount. The frontend signs an ERC-20 transfer from the user's wallet to that
recipient, then submits the transaction hash:

```http
POST /deposits/intents/:id/submit
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "txHash": "0x..."
}
```

Only after the indexer confirms and credits the deposit should the trading
balance in `overview.balances` increase.

Keep these values visually separate:

- **Trading balance**: internal double-entry ledger balance.
- **Personal Web3 wallet**: embedded/external wallet on-chain balance.
- **Exchange deposit address**: custody-only address for incoming transfers.

`GET /account/overview` returns this separation directly:

- `balances`: exchange trading ledger. Use this for orders, withdrawals and
  account equity.
- `portfolio`: USDC valuation of the exchange trading ledger. Use
  `portfolio.totalUsdc` for the big "My Assets" number.
- Per-asset valuation rows live in `balances[]`: use `priceUsdc`, `valueUsdc`
  and `priceStatus` there.
- `wallets`: connected external/embedded wallets known by backend.
- `depositAddresses`: personal custody deposit addresses created for exchange
  deposits.
- `onChainBalances`: live RPC balances for connected wallets only. These are
  display-only and are not exchange ledger balances.
- `depositAddresses`: personal custody deposit addresses for incoming transfers.
  Do not treat their on-chain token balance as the user's exchange balance.
  Use `balances[]` / `balanceUsdc` for credited exchange funds.
- `connectedWalletBalances`: preferred wallets-page source. Connected wallets
  grouped by wallet, then by network, with only non-zero on-chain assets and
  `balanceUsdc` per asset. Same shape as `GET /wallets/balances`.

Listen to private WebSocket events `deposits` and `balances`; use
`GET /deposits` and `GET /account/overview` as polling fallback. Only
`CREDITED` means the trading balance has been increased.

## Errors

Wallet domain errors use the HTTP status plus a stable body:

```ts
interface WalletError {
  code: string;
  message: string;
}
```

| Code | HTTP | Frontend meaning |
| --- | ---: | --- |
| `WALLET_ADDRESS_IN_USE` | 409 | Address belongs to another exchange account |
| `WALLET_LIMIT_REACHED` | 409 | Maximum active external wallets reached |
| `SIWE_NONCE_INVALID` | 401 | Challenge is invalid, changed, or already used |
| `SIWE_NONCE_EXPIRED` | 401 | Request a new SIWE challenge |
| `SIWE_SIGNATURE_INVALID` | 401 | User rejected signing or signature is invalid |
| `UNSUPPORTED_CHAIN` | 400 | Switch wallet to the chain returned by capabilities |
| `PRIVY_DISABLED` | 503 | Hide embedded-wallet creation; external mode still works |
| `PRIVY_UNAVAILABLE` | 503 | Show retry state without creating another wallet |
| `PRIVY_WALLET_NOT_READY` | 409 | Privy login/wallet creation has not completed |
| `WALLET_NOT_FOUND` | 404 | Refresh the wallet list |

Validation errors use the standard NestJS `400` response with a `message[]`
array.

## Security Rules

- Never send the exchange refresh token to Privy.
- Never log SIWE signatures, Privy JWTs, access tokens, or App Secret.
- Never request or display a seed phrase.
- Always sign the exact SIWE `message` returned by the backend.
- Always compare the wallet chain to `capabilities.chain.chainId`.
- Treat `PRIVY_DISABLED` as a feature state, not as an exchange login failure.
