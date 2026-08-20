# Required frontend changes: deposits for new accounts and multiple chains

This document is mandatory for the deposit UI. It fixes the current behavior
where new users receive a Privy session but are never synchronized with the
backend, and where an EVM wallet can be incorrectly selected for a Tron
deposit.

## 1. Two different deposit flows

The UI must expose two explicit flows. Do not mix them.

### A. Deposit by personal exchange address (recommended/default)

This flow does not require a connected external or embedded wallet. It works
for every authenticated account, including a brand-new user.

1. Load available choices:

```http
GET /deposits/options
Authorization: Bearer <access-token>
```

2. After the user chooses asset + network, provision the address:

```http
POST /deposits/address
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "assetSymbol": "USDC",
  "network": "arbitrum"
}
```

3. Display the returned address, QR code, exact network name, asset, token
contract (when present), minimum amount and warning not to use another network.

4. Poll `GET /deposits` every 15 seconds only while this screen is open, or use
the private socket `deposits` and `balances` events. Stop polling after leaving
the screen.

This must be the primary Deposit button behavior. It prevents new accounts
from being blocked by wallet initialization.

### B. Deposit directly from a connected wallet

Use this only when a compatible active wallet is present and the user chooses
`Deposit from wallet`.

1. Synchronize embedded wallets as described below.
2. Select a wallet compatible with the chosen network family.
3. Create an intent.
4. Send the on-chain transaction from that exact wallet.
5. Submit the resulting transaction hash to backend.

## 2. Mandatory Privy initialization for every login/new account

The current frontend calls only `/wallets/embedded/session`. That is
insufficient. Implement the complete sequence once after authentication:

```ts
const session = await api.post('/wallets/embedded/session');
await privy.initializeWithCustomToken(session.token);
await privy.ready();
await api.post('/wallets/embedded/sync');
const wallets = await api.get('/wallets');
walletStore.replace(wallets);
```

Requirements:

- `/wallets/embedded/sync` must be called after Privy reports ready.
- Do not open wallet-deposit UI until sync finishes.
- Retry sync once for transient 502/503/timeout.
- If sync fails, keep personal-address deposit available.
- Repeat sync after the user creates/restores an embedded wallet.
- Invalidate wallet and wallet-balance queries after sync.

## 3. Wallet/network compatibility

Use backend `GET /wallets` plus `GET /wallets/capabilities`.

Compatibility rules:

| Network family | Allowed wallet chain |
| --- | --- |
| EVM | Any EVM wallet (Ethereum, Arbitrum, Base, BNB, Polygon, etc.) |
| TVM / Tron | `TRON`, `TRON_NILE` or `TRON_SHASTA` only |
| SVM / Solana | `SOLANA` or `SOLANA_DEVNET` only |
| UTXO / Bitcoin | `BITCOIN` or `BITCOIN_SIGNET` only |

Never select the primary wallet blindly. Filter by family first:

```ts
function compatibleWallets(wallets, network) {
  return wallets.filter((wallet) => {
    if (wallet.status !== 'ACTIVE') return false;
    if (network.family === 'EVM') return EVM_CHAINS.has(wallet.chain);
    if (network.family === 'TVM') return TRON_CHAINS.has(wallet.chain);
    if (network.family === 'SVM') return SOLANA_CHAINS.has(wallet.chain);
    if (network.family === 'UTXO') return BITCOIN_CHAINS.has(wallet.chain);
    return false;
  });
}
```

If there is no compatible wallet:

- keep `Deposit by address` enabled;
- disable `Deposit from wallet`;
- show `Create/connect a <network family> wallet to send directly`.

Backend now returns HTTP 400 with:

```json
{
  "code": "DEPOSIT_WALLET_NETWORK_MISMATCH",
  "message": "Selected wallet does not support TVM deposits"
}
```

On this error refresh wallets, return to wallet selection and do not retry with
the same wallet.

## 4. Wallet-deposit intent sequence

Create the intent only after a compatible wallet is selected:

```http
POST /deposits/intents
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "assetSymbol": "USDT",
  "network": "tron",
  "amount": "10",
  "walletId": "<compatible-active-wallet-id>"
}
```

Use only the returned `transfer` object. Do not rebuild recipient, token
address, decimals, raw amount or chain ID in frontend.

### EVM

- Switch wallet to `transfer.chainId`.
- Native: send `transfer.rawAmount` to `transfer.recipient`.
- ERC20: call `transfer(token).transfer(recipient, rawAmount)`.
- Wait for wallet submission and capture transaction hash.

### Tron

- Use the synced Tron wallet matching `transfer.fromAddress`.
- Native TRX: send `rawAmount` SUN to `recipient`.
- TRC20: call the returned `tokenAddress` and send `rawAmount`.
- Never pass an `0x...` address to TronWeb.

### Solana

- Use a Solana wallet matching `transfer.fromAddress`.
- For SPL use the returned mint/token metadata and recipient.

Immediately after wallet submission:

```http
POST /deposits/intents/:intentId/submit
Authorization: Bearer <access-token>
Content-Type: application/json

{ "txHash": "<wallet-returned-hash>" }
```

If the wallet rejects/cancels, do not call submit. Show `Transaction cancelled`
and allow the user to create a fresh intent. Intents expire after 15 minutes;
backend now marks unsubmitted expired intents automatically.

## 5. Required UI states

Use these explicit states:

- `PREPARING_WALLET`: Privy session/sync in progress.
- `READY`: compatible wallet or personal-address flow available.
- `CREATING_INTENT`: POST intent in progress.
- `AWAITING_WALLET`: wallet confirmation dialog is open.
- `SUBMITTING_HASH`: tx hash is being verified by backend.
- `PENDING_CONFIRMATION`: submitted and waiting for blocks.
- `CREDITED`: balance event received.
- `FAILED`: show backend code/message and retry action.

Never leave a global spinner after wallet rejection. Every asynchronous step
must have a timeout and a visible retry/back action.

## 6. Data refresh and polling

- Listen to private Socket.IO events `deposits`, `balances`, and `portfolio`.
- Poll `GET /deposits` at most every 15 seconds as disconnected fallback.
- Stop polling when the socket is connected and events are arriving.
- Do not poll `/wallets/balances` while performing a deposit.
- After `CREDITED`, immediately replace balances from the `balances` event.

The current frontend performs `GET /deposits` every 15 seconds even when no
deposit mutation was sent. Fix the action handler so the selected flow always
calls either `POST /deposits/address` or `POST /deposits/intents`.

## 7. Error mapping

| Backend response | Frontend action |
| --- | --- |
| `DEPOSIT_WALLET_NETWORK_MISMATCH` | Return to compatible wallet selection |
| `Active deposit wallet was not found` | Run embedded sync; offer address deposit |
| `Deposit intent has expired` | Create a new intent |
| `Deposit transaction reverted` | Show failed chain transaction |
| `ERC20 transfer does not match deposit intent` | Do not retry hash; create fresh intent |
| HTTP 502/503 | Keep last state and offer retry |
| Wallet rejected request | Return to READY, no backend submit |

## 8. Acceptance tests

1. A brand-new account can obtain a personal deposit address without any
   connected wallet.
2. After login, embedded session is followed by embedded sync and `GET /wallets`
   contains all Privy chains.
3. An Ethereum wallet cannot be selected for Tron or Solana.
4. Tron deposit uses a base58 `T...` sender and recipient.
5. Clicking Deposit always produces a POST request visible in network tools.
6. Successful wallet submission always calls `/submit` with the returned hash.
7. Expired/rejected intent does not leave the UI spinning.
8. Credited deposit updates trading balance from realtime without reload.
