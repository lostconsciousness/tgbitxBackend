# Frontend Integration: Testnet Networks

The API now supports network-aware ERC-20 deposits and withdrawals for multiple
EVM testnets at the same time. Do not treat `ONCHAIN_CHAIN_ID` as the active UI
network. It is only a backend default for legacy requests that omit `network`.

## Supported Testnet Network Keys

Use these exact `network` values in requests and route/state params:

| UI name | `network` | Chain ID | Native gas token |
| --- | --- | ---: | --- |
| Ethereum Sepolia | `ethereum-sepolia` | `11155111` | ETH |
| Base Sepolia | `base-sepolia` | `84532` | ETH |
| OP Sepolia | `optimism-sepolia` | `11155420` | ETH |
| Polygon Amoy | `polygon-amoy` | `80002` | POL |
| BNB Testnet | `bnb-testnet` | `97` | BNB |
| Avalanche Fuji | `avalanche-fuji` | `43113` | AVAX |

Solana devnet and Bitcoin Signet may appear in backend seed data as disabled
adapter targets. Do not show them as supported deposit/withdrawal networks until
the backend exposes native adapters for them.

## Source Of Truth

Use backend data to decide which networks/assets are enabled. Do not hardcode an
asset as enabled just because it is listed above.

Recommended startup fetches:

```http
GET /assets
GET /account/overview
GET /wallets/capabilities
```

`GET /assets` returns assets with `tokenContracts[]`. Each token contract
contains its `network` object and flags:

```ts
type NetworkKey =
  | "ethereum-sepolia"
  | "base-sepolia"
  | "optimism-sepolia"
  | "polygon-amoy"
  | "bnb-testnet"
  | "avalanche-fuji";

interface TokenContract {
  id: string;
  standard: "ERC20";
  address: `0x${string}` | null;
  decimals: number;
  depositEnabled: boolean;
  withdrawalEnabled: boolean;
  contractVerifiedAt: string | null;
  verifiedChainId: number | null;
  network: {
    chainKey: NetworkKey;
    displayName: string;
    caip2: `eip155:${number}`;
    chainId: number;
    depositEnabled: boolean;
    withdrawalEnabled: boolean;
  };
}
```

Show a network as available for deposit only when:

```ts
tokenContract.standard === "ERC20" &&
tokenContract.address &&
tokenContract.depositEnabled &&
tokenContract.network.depositEnabled
```

Show a network as available for withdrawal only when:

```ts
tokenContract.standard === "ERC20" &&
tokenContract.address &&
tokenContract.withdrawalEnabled &&
tokenContract.network.withdrawalEnabled
```

Use `/account/overview` as the exchange balance source of truth. Wallet balances
in MetaMask/Trust Wallet are not exchange balances.

## Overview Page

The overview page can be built from `GET /account/overview` alone. Each
`balances[]` item includes the exchange balance, USDC valuation and the
network-level availability for that asset:

```ts
interface OverviewBalance {
  asset: {
    id: string;
    symbol: string;
    name: string;
    decimals: number;
    networks: Array<{
      network: NetworkKey;
      displayName: string;
      caip2: `eip155:${number}` | null;
      chainId: number | null;
      tokenStandard: "ERC20";
      tokenAddress: `0x${string}` | null;
      decimals: number;
      depositEnabled: boolean;
      withdrawalEnabled: boolean;
      contractVerified: boolean;
      verifiedChainId: number | null;
      requiredConfirmations: number;
    }>;
  };
  balance: string;
  available: string;
  total: string;
  priceUsdc: string | null;
  valueUsdc: string | null;
  balanceUsdc: string | null;
  balanceValueUsdc: string | null;
  availableValueUsdc: string | null;
  totalValueUsdc: string | null;
  priceStatus: "AVAILABLE" | "UNAVAILABLE";
}
```

For the main overview:

- render every `balances[]` row as a supported exchange asset;
- show `balanceUsdc ?? valueUsdc ?? "N/A"` for the USDC estimate;
- show deposit network buttons from `asset.networks.filter(n => n.depositEnabled)`;
- show withdraw network buttons from `asset.networks.filter(n => n.withdrawalEnabled)`;
- optionally show disabled networks from `asset.networks` with a "Coming soon" badge.

If an asset has zero balance but enabled networks, still show it in the asset
list if the product wants all supported assets visible.

`portfolio` is only the summary for the header card:

```ts
interface OverviewPortfolio {
  currency: "USDC";
  totalUsdc: string;
  priceStatus: "AVAILABLE" | "PARTIAL";
}
```

Do not expect `portfolio.assets[]`; per-asset rows live in `balances[]`.

## Wallets Page

Use two endpoints:

```http
GET /wallets/capabilities
GET /wallets
```

`GET /wallets/capabilities` returns the currently supported EVM network list for
wallet/deposit UI:

```ts
interface WalletCapabilities {
  chain: {
    name: string;
    chainId: number;
  };
  networks: Array<{
    network: NetworkKey;
    displayName: string;
    caip2: `eip155:${number}` | null;
    chainId: number | null;
    depositEnabled: boolean;
    withdrawalEnabled: boolean;
    mainnet: boolean;
  }>;
  external: {
    enabled: boolean;
    provider: "SIWE";
  };
  embedded: {
    enabled: boolean;
    provider: "PRIVY";
  };
}
```

`GET /wallets` returns wallets already linked to the exchange account. A wallet
record is not a list of all supported chains; it is the chain where the wallet
was linked/synced. Use `capabilities.networks` to render all network tabs or
filters, and use `/account/overview.onChainBalances` to show on-chain balances
for already linked wallets/deposit addresses.

## Deposit Address Flow

For a CEX-style deposit address, send the selected network:

```http
POST /deposits/address
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "assetSymbol": "USDC",
  "network": "base-sepolia"
}
```

Response:

```ts
interface PersonalDepositAddress {
  id: string;
  network: NetworkKey;
  caip2: `eip155:${number}`;
  chainId: number;
  address: `0x${string}`;
  asset: {
    symbol: "USDC";
    tokenAddress: `0x${string}`;
    tokenStandard: "ERC20";
    decimals: 6;
  };
  requiredConfirmations: number;
  status: "ACTIVE";
  memo: null;
  tag: null;
  acceptsFromAnyAddress: true;
}
```

Show:

- selected network name;
- chain ID;
- token contract address;
- deposit address QR;
- warning to send only that token on that network.

Users may send from MetaMask, Trust Wallet, exchange wallets or any compatible
source. Deposits are matched by token contract plus destination address.

## Deposit From Connected Wallet

If the user clicks "Deposit from wallet", create a deposit intent:

```http
POST /deposits/intents
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "assetSymbol": "USDC",
  "network": "base-sepolia",
  "amount": "10",
  "walletId": "connected-wallet-id"
}
```

The backend returns exact transfer details:

```ts
interface DepositIntentResponse {
  id: string;
  status: "PENDING" | "SUBMITTED" | "DETECTED" | "CONFIRMED" | "CREDITED";
  transfer: {
    chainId: number;
    caip2: `eip155:${number}`;
    tokenAddress: `0x${string}`;
    tokenStandard: "ERC20";
    recipient: `0x${string}`;
    amount: string;
    rawAmount: string;
    decimals: number;
    assetSymbol: "USDC";
    fromAddress: `0x${string}`;
  };
}
```

Before sending, switch the connected wallet to `transfer.chainId`.

Use viem/wagmi ERC-20 `transfer`:

```ts
writeContract({
  address: intent.transfer.tokenAddress,
  abi: erc20Abi,
  functionName: "transfer",
  args: [intent.transfer.recipient, BigInt(intent.transfer.rawAmount)],
  chainId: intent.transfer.chainId,
});
```

After the wallet returns a transaction hash:

```http
POST /deposits/intents/:id/submit
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "txHash": "0x..."
}
```

Poll every **1 second** until `status === "CREDITED"`:

```http
GET /deposits/intents/:id
GET /deposits
```

Use `progressStep` (1–4) for the deposit stepper UI instead of guessing from
`status` alone:

| `progressStep` | UI step | `status` (typical) |
|----------------|---------|-------------------|
| 1 | Ожидание перевода | `PENDING`, `SUBMITTED` |
| 2 | Перевод найден | `DETECTED` — show `confirmations` / `requiredConfirmations` |
| 3 | Подтверждён в сети | `CONFIRMED` |
| 4 | Зачислено на баланс | `CREDITED` |

```ts
interface DepositIntentPollResponse {
  status: "PENDING" | "SUBMITTED" | "DETECTED" | "CONFIRMED" | "CREDITED";
  progressStep: 1 | 2 | 3 | 4;
  confirmations: number;
  requiredConfirmations: number;
  isConfirmed: boolean;
  isCredited: boolean;
}
```

Only `CREDITED` / `progressStep === 4` means the exchange ledger balance has increased.
Do not mark the flow complete on `DETECTED` alone.

## Withdrawals

Withdrawals work like a CEX: the user has **one exchange balance per asset**
(`USDC`), regardless of which network they deposited on. When withdrawing, the
user picks the destination network.

Fetch network options for the withdraw modal:

```http
GET /withdrawals/networks?assetSymbol=USDC
Authorization: Bearer <accessToken>
```

```ts
interface WithdrawalNetworksResponse {
  asset: {
    id: string;
    symbol: "USDC";
    name: string;
    decimals: number;
  };
  availableBalance: string;
  balanceScope: "EXCHANGE_LEDGER";
  networks: Array<{
    network: NetworkKey;
    displayName: string;
    caip2: `eip155:${number}` | null;
    chainId: number | null;
    tokenAddress: `0x${string}` | null;
    nativeGasSymbol: "ETH" | "POL" | "BNB" | "AVAX";
    withdrawalEnabled: boolean;
    withdrawalFeeAmount: string;
    minWithdrawalAmount: string;
    contractVerified: boolean;
  }>;
}
```

Use `availableBalance` for the amount input max. Deduct
`withdrawalFeeAmount` from the same asset balance when validating
`amount + fee <= availableBalance`.

`nativeGasSymbol` is informational for the selected network. On-chain gas for
broadcast is paid by the exchange hot wallet. Users do not need native gas in
their exchange ledger to withdraw USDC.

Withdrawals are network-aware. Always include the selected network:

```http
POST /withdrawals
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "assetSymbol": "USDC",
  "network": "base-sepolia",
  "amount": "5",
  "toAddress": "0x1111111111111111111111111111111111111111"
}
```

The backend validates:

- asset/network support;
- internal exchange balance;
- withdrawal limits;
- new-address cooldown;
- token contract verification;
- custody readiness for that network.

Status lifecycle:

```text
PENDING_APPROVAL -> APPROVED -> BROADCASTING -> BROADCASTED -> CONFIRMED
```

Only `CONFIRMED` is final. Do not display `APPROVED` or `BROADCASTED` as
completed.

Fetch user withdrawals:

```http
GET /withdrawals
```

Response is intentionally compact for frontend history:

```ts
interface WithdrawalHistoryItem {
  id: string;
  status:
    | "REQUESTED"
    | "PENDING_APPROVAL"
    | "APPROVED"
    | "BROADCASTING"
    | "BROADCASTED"
    | "CONFIRMED"
    | "FAILED"
    | "CANCELLED"
    | "REJECTED";
  asset: {
    id: string;
    symbol: string;
    name: string;
    type: string;
    decimals: number;
  };
  network: {
    network: NetworkKey;
    displayName: string;
    caip2: `eip155:${number}` | null;
    chainId: number | null;
    tokenStandard: "ERC20" | null;
    tokenAddress: `0x${string}` | null;
  };
  toAddress: `0x${string}`;
  amount: string;
  feeAmount: string;
  txHash: `0x${string}` | null;
  adminApprovalRequired: boolean;
  failureReason: string | null;
  requestedAt: string;
  approvedAt: string | null;
  broadcastedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
}
```

This endpoint is history. Use `/account/overview.balances[].asset.networks` to
render all networks available for creating a new withdrawal.

Cancel before approval/broadcast when allowed:

```http
POST /withdrawals/:id/cancel
```

## Network Switching UX

Frontend should keep a selected network per deposit/withdrawal form. The user can
select `base-sepolia`, deposit, then select `polygon-amoy` without reloading the
app. The backend workers run per network.

For connected-wallet deposits:

1. User selects network.
2. Fetch/create deposit intent.
3. Switch wallet to returned `chainId`.
4. Send ERC-20 transfer.
5. Submit tx hash.
6. Poll until `CREDITED`.

For withdrawals:

1. User selects network.
2. Show available exchange balance from `/account/overview`.
3. Submit `POST /withdrawals` with `network`.
4. Show status until `CONFIRMED`.

## Errors To Surface

Map these backend errors to clear UI messages:

| Backend message | UI hint |
| --- | --- |
| `Unsupported network` | This network is not supported by the exchange. |
| `Deposits are disabled for this network` | Deposits are not enabled on this network yet. |
| `ERC20 deposits are disabled for this asset on this network` | USDC is not enabled on this network yet. |
| `Withdrawals are disabled for this asset on this network` | Withdrawals are not enabled on this network yet. |
| `Active deposit wallet was not found` | Connect or sync the selected wallet first. |
| `Insufficient available balance` | The exchange balance is too low. |
| `New withdrawal address is in cooldown` | This address must wait before withdrawal is allowed. |

## Admin/Readiness References

These are admin-only but useful for support dashboards:

```http
GET /admin/onchain/readiness/networks
GET /admin/onchain/readiness?network=base-sepolia
POST /admin/assets/USDC/verify-contract?network=base-sepolia
PATCH /admin/assets/USDC/transfers?network=base-sepolia
```

The frontend user UI should not call admin endpoints.
