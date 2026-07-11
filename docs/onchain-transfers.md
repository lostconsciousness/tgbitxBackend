# Arbitrum Sepolia Transfers

## Safety boundary

- Chain: Arbitrum Sepolia (`421614`) only.
- Token for the first E2E: Circle USDC at
  `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`.
- Deposit and withdrawal workers remain disabled until readiness passes.
- `PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64` is accepted only with
  `NODE_ENV=development`, chain `421614`, and `MAINNET_ENABLED=false`.
- Rotate the Privy authorization key after testnet validation.

## Required local configuration

Set these values locally. Do not send them in chat or commit them:

```env
PRIVY_APP_ID=
PRIVY_APP_SECRET=
PRIVY_SERVER_WALLET_ID=
PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64=
PRIVY_WEBHOOK_SIGNING_SECRET=
DEPOSIT_TREASURY_ADDRESS=
WITHDRAWAL_HOT_ADDRESS=
```

Create active `DEPOSIT_TREASURY` and `WITHDRAWAL_HOT` custody accounts for
`ARBITRUM_SEPOLIA`. The hot account must contain the same Privy wallet ID and
address as the environment configuration.

## Enable USDC

Use an admin access token:

```http
POST /admin/assets/USDC/verify-contract
PATCH /admin/assets/USDC/transfers
Content-Type: application/json

{
  "depositEnabled": true,
  "withdrawalEnabled": true
}
```

Then check:

```http
GET /admin/onchain/readiness
```

Only after both workers report `ready: true`, enable:

```env
DEPOSIT_INDEXER_ENABLED=true
WITHDRAWAL_WORKER_ENABLED=true
```

## Privy webhook

Configure Privy to send transaction events to:

```text
https://YOUR_PUBLIC_API/webhooks/privy
```

The endpoint requires valid `svix-id`, `svix-timestamp`, and `svix-signature`
headers. Duplicate event IDs are accepted without applying state twice.

## Real round-trip E2E

Start the API, export the gated test values, then run:

```powershell
$env:E2E_ONCHAIN_ENABLED='true'
$env:E2E_USER_ACCESS_TOKEN='...'
$env:E2E_ADMIN_ACCESS_TOKEN='...'
$env:E2E_WALLET_ID='...'
$env:E2E_USDC_AMOUNT='1'
npm run test:e2e:onchain
```

The runner prints exact transfer parameters, waits for the Trust Wallet tx
hash, polls until the deposit is credited, requests and approves the return
withdrawal, then requires ledger and treasury reconciliation to pass.
