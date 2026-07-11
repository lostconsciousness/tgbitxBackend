# Testnet Network Testing

## EVM testnet matrix

| Network key | Chain ID | RPC env | MockUSDC env |
| --- | ---: | --- | --- |
| `arbitrum-sepolia` | `421614` | `ARBITRUM_RPC_PRIMARY_URL` | `MOCK_USDC_ARBITRUM_SEPOLIA_ADDRESS` |
| `ethereum-sepolia` | `11155111` | `ETHEREUM_SEPOLIA_RPC_PRIMARY_URL` | `MOCK_USDC_ETHEREUM_SEPOLIA_ADDRESS` |
| `base-sepolia` | `84532` | `BASE_SEPOLIA_RPC_PRIMARY_URL` | `MOCK_USDC_BASE_SEPOLIA_ADDRESS` |
| `optimism-sepolia` | `11155420` | `OPTIMISM_SEPOLIA_RPC_PRIMARY_URL` | `MOCK_USDC_OPTIMISM_SEPOLIA_ADDRESS` |
| `polygon-amoy` | `80002` | `POLYGON_AMOY_RPC_PRIMARY_URL` | `MOCK_USDC_POLYGON_AMOY_ADDRESS` |
| `bnb-testnet` | `97` | `BNB_TESTNET_RPC_PRIMARY_URL` | `MOCK_USDC_BNB_TESTNET_ADDRESS` |
| `avalanche-fuji` | `43113` | `AVALANCHE_FUJI_RPC_PRIMARY_URL` | `MOCK_USDC_AVALANCHE_FUJI_ADDRESS` |

Additional EVM networks are seeded disabled-by-default for the next fast-path
rollout:

| Network key | Chain ID | RPC env |
| --- | ---: | --- |
| `zksync-sepolia` | `300` | `ZKSYNC_SEPOLIA_RPC_PRIMARY_URL` |
| `linea-sepolia` | `59141` | `LINEA_SEPOLIA_RPC_PRIMARY_URL` |
| `scroll-sepolia` | `534351` | `SCROLL_SEPOLIA_RPC_PRIMARY_URL` |
| `mantle-sepolia` | `5003` | `MANTLE_SEPOLIA_RPC_PRIMARY_URL` |
| `celo-alfajores` | `44787` | `CELO_ALFAJORES_RPC_PRIMARY_URL` |

Solana devnet, Bitcoin Signet, and Tron Nile are implemented as separate
testnet adapters. They must not be tested through the ERC-20 scanner.

| Network key | Family | Native asset | Token standard | RPC env |
| --- | --- | --- | --- | --- |
| `solana-devnet` | `SVM` | `SOL` | `NATIVE` / `SPL` | `SOLANA_DEVNET_RPC_PRIMARY_URL` |
| `bitcoin-signet` | `UTXO` | `BTC` | `BTC` | `BITCOIN_SIGNET_RPC_PRIMARY_URL` |
| `tron-nile` | `TVM` | `TRX` | `NATIVE` / `TRC20` | `TRON_NILE_RPC_PRIMARY_URL` |

The frontend/API shows these catalog rows with `family`, `tokenStandard`, and
`disabledReason`. Native `SOL`, `BTC`, and `TRX` are enabled by seed for their
testnets. TRON Nile `USDT` TRC-20 is enabled only when
`TRON_NILE_USDT_TRC20_ADDRESS` is configured before seeding.

Native testnet deposits are seeded as enabled for:

- `ETH` on `arbitrum-sepolia`, `ethereum-sepolia`, `base-sepolia`, `optimism-sepolia`
- `BNB` on `bnb-testnet`
- `POL` on `polygon-amoy`
- `AVAX` on `avalanche-fuji`

## Faucet starting points

- Ethereum Sepolia: https://cloud.google.com/application/web3/faucet/ethereum/sepolia
- Base Sepolia: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet
- OP Sepolia: https://app.optimism.io/faucet
- Polygon Amoy: https://faucet.polygon.technology/
- BNB Testnet: https://www.bnbchain.org/en/testnet-faucet
- Avalanche Fuji: https://core.app/tools/testnet-faucet/

## Per-network setup

Configure all RPC URLs that you want the API to serve. `ONCHAIN_CHAIN_ID` is
kept only as a default network for legacy requests that omit `network`; workers
and E2E flows use the per-request/per-row network key.

```env
ONCHAIN_CHAIN_ID=421614
SIWE_CHAIN_ID=421614
ARBITRUM_RPC_PRIMARY_URL=
ETHEREUM_SEPOLIA_RPC_PRIMARY_URL=
BASE_SEPOLIA_RPC_PRIMARY_URL=
OPTIMISM_SEPOLIA_RPC_PRIMARY_URL=
POLYGON_AMOY_RPC_PRIMARY_URL=
BNB_TESTNET_RPC_PRIMARY_URL=
AVALANCHE_FUJI_RPC_PRIMARY_URL=
ZKSYNC_SEPOLIA_RPC_PRIMARY_URL=
LINEA_SEPOLIA_RPC_PRIMARY_URL=
SCROLL_SEPOLIA_RPC_PRIMARY_URL=
MANTLE_SEPOLIA_RPC_PRIMARY_URL=
CELO_ALFAJORES_RPC_PRIMARY_URL=
SOLANA_DEVNET_RPC_PRIMARY_URL=
BITCOIN_SIGNET_RPC_PRIMARY_URL=
TRON_NILE_RPC_PRIMARY_URL=
TRON_NILE_USDT_TRC20_ADDRESS=
SOLANA_DEVNET_WITHDRAWAL_PRIVATE_KEY=
BITCOIN_SIGNET_WITHDRAWAL_WIF=
BITCOIN_SIGNET_WITHDRAWAL_FEE_SATS=1000
TRON_NILE_WITHDRAWAL_PRIVATE_KEY=
TRON_NILE_TRC20_FEE_LIMIT_SUN=150000000
PRIVY_CUSTODY_ENABLED=true
PRIVY_APP_ID=
PRIVY_APP_SECRET=
PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64=
PRIVY_WEBHOOK_SIGNING_SECRET=
DEPOSIT_TREASURY_ADDRESS=
WITHDRAWAL_HOT_ADDRESS=
PRIVY_SERVER_WALLET_ID=
PRIVY_DEPOSIT_SWEEP_POLICY_ID=
```

Readiness can be checked for one network or every enabled EVM network:

```http
GET /admin/onchain/readiness?network=base-sepolia
GET /admin/onchain/readiness/networks
GET /admin/onchain/adapters
```

`/admin/onchain/adapters` is the quick check for adapter family state. EVM
returns implemented. `SVM`, `UTXO`, and `TVM` also return implemented; network
readiness still depends on RPC URLs and hot wallet secrets.

Deploy MockUSDC after compiling `apps/api/contracts/MockUSDC.sol` with your
preferred Solidity toolchain:

```powershell
$env:MOCK_USDC_NETWORK='base-sepolia'
$env:MOCK_USDC_DEPLOYER_PRIVATE_KEY='0x...'
$env:MOCK_USDC_INITIAL_HOLDER='0x...'
$env:MOCK_USDC_ARTIFACT_PATH='path\to\MockUSDC.json'
npm --workspace @dream-exchange/api run mock-usdc:deploy
```

Copy the printed `MOCK_USDC_BASE_SEPOLIA_ADDRESS=...` into `.env`, then run:

```powershell
npm run seed
```

Verify and enable the token contract for that network:

```http
POST /admin/assets/USDC/verify-contract?network=base-sepolia
PATCH /admin/assets/USDC/transfers?network=base-sepolia
Content-Type: application/json

{
  "depositEnabled": true,
  "withdrawalEnabled": true
}
```

Native gas coins do not have token contracts to verify. After running seed,
provision the deposit address for the native asset, send the native testnet gas
coin to that address, then scan the block range:

```http
POST /admin/deposits/indexer/scan
Content-Type: application/json

{
  "assetSymbol": "ETH",
  "network": "ethereum-sepolia",
  "fromBlock": 123456,
  "toBlock": 123500
}
```

## E2E canary

Run the canary for one network at a time while the API remains configured for
all networks:

```powershell
$env:E2E_ONCHAIN_ENABLED='true'
$env:E2E_NETWORK='base-sepolia'
$env:E2E_ASSET_SYMBOL='USDC'
$env:E2E_AMOUNT='1'
$env:E2E_WALLET_ID='...'
$env:E2E_WITHDRAWAL_ADDRESS='0x...'
$env:E2E_USER_ACCESS_TOKEN='...'
$env:E2E_ADMIN_ACCESS_TOKEN='...'
npm run test:e2e:onchain
```

The runner provisions the deposit address, creates a network-aware deposit
intent, prints the exact ERC-20 transfer, accepts the tx hash, waits for credit,
requests a withdrawal on the same network, approves it, and requires ledger and
treasury reconciliation to pass.

Repeat the same canary for each EVM network before enabling it for users.

## Non-EVM adapter smoke checklist

Before testing withdrawals, create active `WITHDRAWAL_HOT` custody accounts for
`SOLANA_DEVNET`, `BITCOIN_SIGNET`, and `TRON_NILE`; their addresses must match
the configured hot private keys. The adapter uses:

- `SOLANA_DEVNET_WITHDRAWAL_PRIVATE_KEY`: JSON array, base64 secret key, or
  base58 secret key.
- `BITCOIN_SIGNET_WITHDRAWAL_WIF`: Signet/testnet WIF for a P2WPKH hot wallet.
- `TRON_NILE_WITHDRAWAL_PRIVATE_KEY`: Nile hot wallet private key.

Solana devnet:

- Provision a SOL deposit address through the SVM adapter.
- Send a small SOL transfer. For SPL mock-token testing, seed a `TokenContract`
  with the mint address and enable it.
- Scan signatures by address, parse transactions, and credit only matching
  recipient/mint transfers.
- Re-run the scanner and verify no duplicate ledger credit.
- Broadcast a small withdrawal, confirm the transaction, and run
  reconciliation.

Bitcoin Signet:

- Provision a BTC deposit address through the UTXO adapter.
- Send a transaction with multiple outputs and credit only the matching
  `txid:vout`.
- Wait the configured confirmations and re-run the scanner for idempotency.
- Build and broadcast a small UTXO withdrawal, then reconcile spent/unspent
  outputs.

Tron Nile:

- Provision a TRX deposit address through the TVM adapter.
- Send a small TRX transfer. For USDT TRC-20, configure
  `TRON_NILE_USDT_TRC20_ADDRESS`, run seed, then send a TRC-20 `Transfer`.
- Credit only the configured TRC-20 contract and ignore wrong contracts.
- Broadcast a small withdrawal through a TronWeb/TronGrid-compatible adapter,
  confirm it, and run reconciliation.
