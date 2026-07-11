# Frontend Withdrawals Guide

This document describes how to integrate **exchange withdrawals** (CEX-style) against
the Dream Exchange API. Use it when building the withdraw modal, asset/network
pickers, history, and status polling.

Related docs:

- [Multi-testnet overview](./frontend-testnet-networks.md) — networks, deposits, shared types
- [Wallets & balances](./frontend-wallets.md) — connected wallet vs exchange ledger

---

## Mental model (CEX)

| Concept | Meaning |
| --- | --- |
| **Exchange balance** | Ledger balance per asset (`ETH`, `USDC`, …). One balance per symbol across all networks. |
| **Withdraw network** | User picks **where** tokens are sent on-chain (`arbitrum-sepolia`, `base-sepolia`, …). |
| **Hot wallet** | Backend broadcasts from custody hot wallet (user does not sign). |
| **Network fee** | Deducted from the **same asset** balance (`withdrawalFeeAmount`). User pays — not subsidized by the exchange. |
| **Total debit** | `amount + withdrawalFeeAmount <= availableBalance`. |

Deposits credit the ledger; withdrawals debit the ledger and broadcast on-chain from
custody. Do not confuse exchange balance with connected-wallet on-chain balance.

---

## Supported assets (testnet, current seed)

Show a network in the withdraw picker only when `withdrawalEnabled === true`.

| Asset | Type | Networks (testnet) | Notes |
| --- | --- | --- | --- |
| **ETH** | Native | `arbitrum-sepolia`, `ethereum-sepolia`, `base-sepolia`, `optimism-sepolia` | Native gas coin on each EVM testnet |
| **USDC** | ERC-20 | `arbitrum-sepolia` | Other testnets appear with `withdrawalEnabled: false` until admin enables + verifies |
| **BNB** | Native | `bnb-testnet` | |
| **POL** | Native | `polygon-amoy` | |
| **AVAX** | Native | `avalanche-fuji` | |
| **WETH, WBTC, USDT, ARB** | ERC-20 | Mostly disabled in seed | Shown in options with `withdrawalEnabled: false` until enabled |

Always drive UI from API responses — do not hardcode this table.

---

## API flow (recommended)

```text
1. GET /withdrawals/options          → asset list + all networks + balances
2. User picks asset + network + amount + destination address
3. POST /withdrawals                 → create withdrawal, reserve ledger
4. Poll GET /withdrawals             → track status until CONFIRMED / FAILED
5. Refresh GET /account/overview     → updated balances
```

Alternative (single asset already selected):

```text
GET /withdrawals/networks?assetSymbol=ETH
POST /withdrawals
GET /withdrawals
```

---

## Endpoints

### 1. List all withdrawable assets — `GET /withdrawals/options`

Primary endpoint for the **withdraw coin picker**.

```http
GET /withdrawals/options
Authorization: Bearer <accessToken>
```

```ts
type NetworkKey =
  | "arbitrum-sepolia"
  | "ethereum-sepolia"
  | "base-sepolia"
  | "optimism-sepolia"
  | "polygon-amoy"
  | "bnb-testnet"
  | "avalanche-fuji";

type NativeGasSymbol = "ETH" | "POL" | "BNB" | "AVAX";

interface WithdrawalOptionsResponse {
  balanceScope: "EXCHANGE_LEDGER";
  assets: Array<{
    id: string;
    symbol: string;          // "ETH" | "USDC" | ...
    name: string;
    iconUrl: string | null;
    type: string;            // "CRYPTO" | "STABLECOIN"
    decimals: number;
    availableBalance: string; // ledger spot balance for this asset
    priceUsdc: string | null; // mid price vs USDC
    balanceValueUsdc: string | null; // availableBalance converted to USDC
    networks: Array<{
      network: NetworkKey;
      displayName: string;
      iconUrl: string | null;
      caip2: `eip155:${number}` | null;
      chainId: number | null;
      tokenStandard: "NATIVE" | "ERC20";
      tokenAddress: `0x${string}` | null; // null for native
      nativeGasSymbol: NativeGasSymbol;
      withdrawalEnabled: boolean;       // show only if true
      withdrawalFeeAmount: string;      // network fee (same asset), paid by user
      estimatedNetworkCostUsd: string | null;
      gasPaidByExchange: false;         // always false — show as "Network fee"
      minWithdrawalAmount: string;
      contractVerified: boolean;
    }>;
  }>;
}
```

**UI rules:**

- Assets are sorted by `balanceValueUsdc` descending (largest USDC equivalent first).
- Show asset if `availableBalance > 0` **or** user opened withdraw for that asset.
- Filter networks: `networks.filter(n => n.withdrawalEnabled)`.
- Max amount: `availableBalance - withdrawalFeeAmount` (both same asset).
- Min amount: `minWithdrawalAmount`.
- Show fee as **Network fee** (e.g. `0.8 USDT` on BNB). Do **not** show "Gas paid by exchange" when `gasPaidByExchange === false`.
- Total deducted from balance: `amount + withdrawalFeeAmount`.

---

### 2. Single asset networks — `GET /withdrawals/networks?assetSymbol=ETH`

Use when asset is already selected (e.g. withdraw from portfolio row).

```http
GET /withdrawals/networks?assetSymbol=USDC
Authorization: Bearer <accessToken>
```

```ts
interface WithdrawalNetworksResponse {
  asset: {
    id: string;
    symbol: string;
    name: string;
    decimals: number;
  };
  availableBalance: string;
  balanceScope: "EXCHANGE_LEDGER";
  networks: WithdrawalOptionsResponse["assets"][number]["networks"];
}
```

---

### 3. Create withdrawal — `POST /withdrawals`

```http
POST /withdrawals
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "assetSymbol": "ETH",
  "network": "arbitrum-sepolia",
  "amount": "0.05",
  "toAddress": "0x1111111111111111111111111111111111111111"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `assetSymbol` | yes | Uppercase, e.g. `ETH`, `USDC` |
| `network` | recommended | `chainKey`, e.g. `arbitrum-sepolia`. Omit → default from `ONCHAIN_CHAIN_ID` |
| `amount` | yes | Decimal string, excludes fee |
| `toAddress` | yes | Checksummed `0x` address |

**Response** (`WithdrawalHistoryItem` — same shape as list items):

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
    tokenStandard: "NATIVE" | "ERC20" | null;
    tokenAddress: `0x${string}` | null;
  };
  toAddress: `0x${string}`;
  amount: string;
  feeAmount: string;
  txHash: `0x${string}` | null;
  adminApprovalRequired: boolean;
  failureReason: string | null; // set when status === FAILED
  requestedAt: string;
  approvedAt: string | null;
  broadcastedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
}
```

---

### 4. History — `GET /withdrawals`

```http
GET /withdrawals
Authorization: Bearer <accessToken>
```

Returns `WithdrawalHistoryItem[]`, newest first.

---

### 5. Cancel — `POST /withdrawals/:id/cancel`

Only before approval/broadcast (`REQUESTED`, `PENDING_APPROVAL`).

```http
POST /withdrawals/{id}/cancel
Authorization: Bearer <accessToken>
```

---

## Status lifecycle & UI

```text
REQUESTED → PENDING_APPROVAL → APPROVED → BROADCASTING → BROADCASTED → CONFIRMED
                ↓                ↓              ↓
            REJECTED         CANCELLED       FAILED
```

| Status | User-facing label | Final? |
| --- | --- | --- |
| `REQUESTED` | Submitted | no |
| `PENDING_APPROVAL` | Awaiting approval | no |
| `APPROVED` | Approved, queued | no |
| `BROADCASTING` | Sending on-chain | no |
| `BROADCASTED` | Tx sent, confirming | no |
| `CONFIRMED` | Completed | **yes** |
| `FAILED` | Failed (show `failureReason`) | **yes** |
| `CANCELLED` | Cancelled | **yes** |
| `REJECTED` | Rejected | **yes** |

**Polling:** after `POST /withdrawals`, poll `GET /withdrawals` every **3–5 s** until
terminal state. Show `txHash` link when present (explorer per network).

**Balance refresh:** after `CONFIRMED`, refetch `GET /account/overview` or
`GET /withdrawals/options`.

Only **`CONFIRMED`** means funds left the exchange successfully.

---

## Validation (frontend)

```ts
function validateWithdrawal(input: {
  amount: string;
  availableBalance: string;
  feeAmount: string;
  minAmount: string;
  networkEnabled: boolean;
  toAddress: string;
}) {
  if (!input.networkEnabled) return "Withdrawals disabled on this network";
  const amount = Number(input.amount);
  const fee = Number(input.feeAmount);
  const available = Number(input.availableBalance);
  const min = Number(input.minAmount);
  if (amount <= 0) return "Amount must be positive";
  if (amount < min) return `Minimum withdrawal is ${input.minAmount}`;
  if (amount + fee > available) return "Insufficient balance (amount + fee)";
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.toAddress)) return "Invalid address";
  return null;
}
```

---

## Overview integration

`GET /account/overview` returns `balances[].asset.networks[]` with the same
`withdrawalEnabled`, `withdrawalFeeAmount`, `minWithdrawalAmount` flags (native
coins included after backend fix).

Use either:

- `overview.balances` for portfolio + per-asset network flags, or
- `GET /withdrawals/options` for dedicated withdraw screen.

Prefer **`/withdrawals/options`** for the withdraw modal — it is the canonical
withdraw-specific payload with `availableBalance` per asset.

---

## Common errors

| HTTP / message | Cause | UI action |
| --- | --- | --- |
| `Withdrawals are disabled for this asset` | Network or asset not enabled | Hide network or show "coming soon" |
| `Withdrawal amount is below minimum` | `< minWithdrawalAmount` | Show min from options |
| `Insufficient available balance` | `amount + fee > balance` | Reduce amount |
| `Cannot withdraw to your own exchange deposit address` | Internal address | Ask for external wallet |
| `New withdrawal address is in cooldown` | Address cooldown env | Show wait time |
| `Daily withdrawal limit exceeded` | Limit hit | Show limit message |
| `failureReason` on FAILED | Hot wallet / on-chain issue | Show reason + support hint |

Large testnet amounts may stay in `PENDING_APPROVAL` until admin approves
(`WITHDRAWAL_MANUAL_APPROVAL_THRESHOLD`). Small amounts auto-approve.

---

## Example: withdraw modal (React pseudo-code)

```tsx
const { data: options } = useQuery(["withdrawals", "options"], () =>
  api.get("/withdrawals/options"),
);

const [symbol, setSymbol] = useState("USDC");
const [network, setNetwork] = useState<NetworkKey>("arbitrum-sepolia");

const asset = options.assets.find((a) => a.symbol === symbol);
const net = asset?.networks.find((n) => n.network === network && n.withdrawalEnabled);

async function submit(amount: string, toAddress: string) {
  const created = await api.post("/withdrawals", {
    assetSymbol: symbol,
    network,
    amount,
    toAddress,
  });
  await pollUntilFinal(created.id);
  await refetchOverview();
}

async function pollUntilFinal(id: string) {
  for (let i = 0; i < 120; i++) {
    const list = await api.get("/withdrawals");
    const item = list.find((w) => w.id === id);
    if (!item) return;
    if (["CONFIRMED", "FAILED", "CANCELLED", "REJECTED"].includes(item.status)) return item;
    await sleep(4000);
  }
}
```

---

## Native vs ERC-20

| | Native (`ETH`, `BNB`, `POL`, `AVAX`) | ERC-20 (`USDC`, …) |
| --- | --- | --- |
| `tokenStandard` | `"NATIVE"` | `"ERC20"` |
| `tokenAddress` | `null` | contract address |
| On-chain tx | Native transfer | `transfer(to, amount)` |
| User network fee | Included in `withdrawalFeeAmount` (native asset) | Flat fee in token (e.g. 0.8 USDT on BSC) |
| User gas wallet | Not required | Not required |

No wallet connect needed for withdrawal — user only provides **destination address**.

---

## Test checklist

- [ ] `/withdrawals/options` lists ETH, USDC, BNB, POL, AVAX with correct flags
- [ ] Only `withdrawalEnabled: true` networks are selectable
- [ ] Amount validation includes fee
- [ ] POST creates withdrawal; balance decreases immediately (reserved)
- [ ] Poll until `CONFIRMED`; show explorer link from `txHash`
- [ ] `FAILED` shows `failureReason`
- [ ] Cancel works in `PENDING_APPROVAL`
- [ ] Overview balance updates after `CONFIRMED`

---

## Backend notes (for debugging)

Withdrawals require custody pipeline:

1. **Sweep** — deposit address → treasury (`DEPOSIT_SWEEP_ENABLED`)
2. **Rebalance** — treasury → hot wallet (`TREASURY_REBALANCE_ENABLED`)
3. **Broadcast** — hot wallet → user `toAddress` (`WITHDRAWAL_WORKER_ENABLED`)

First withdrawal after deposit may take **30–60 s** while sweep/rebalance runs.
If stuck in `FAILED` with insufficient balance, treasury/hot wallet needs funding —
not a frontend bug.
