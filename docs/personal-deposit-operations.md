# Personal Deposit Address Operations

## Required Privy Configuration

Create two policies and one server wallet:

1. Deposit sweep policy: personal deposit wallets may only call verified
   ERC-20 `transfer(address,uint256)` contracts, with the active deposit
   treasury as recipient and native value `0`.
2. Sweep gas policy: the gas wallet may only send small native transfers to
   active personal deposit addresses and active deposit treasury addresses on
   enabled EVM networks. Treasury recipients are required so treasury-to-hot
   rebalances can pay network fees.
3. Sweep gas wallet: a Privy Ethereum server wallet funded with the native gas
   asset on every enabled EVM network (for example ETH, BNB, POL or AVAX).

Configure:

```env
PRIVY_DEPOSIT_SWEEP_POLICY_ID=
PRIVY_SWEEP_GAS_WALLET_ID=
SWEEP_GAS_ADDRESS=
PRIVY_SWEEP_GAS_POLICY_ID=
DEPOSIT_SWEEP_ENABLED=false
SWEEP_GAS_TOPUP_WEI=
SWEEP_GAS_MAX_TOPUP_WEI=
DEPOSIT_ADDRESS_SCAN_BATCH_SIZE=100
```

Run `npm run seed` after configuring the gas wallet so the `SWEEP_GAS`
custody account is registered. Check `GET /admin/onchain/readiness` before
enabling either worker.

## Safe Enablement Order

1. Keep `DEPOSIT_SWEEP_ENABLED=false`.
2. Provision a user address with `POST /deposits/address`.
3. Send test USDC to it and enable `DEPOSIT_INDEXER_ENABLED=true`.
4. Confirm the deposit becomes `CREDITED` exactly once.
5. Fund the sweep gas wallet with testnet ETH.
6. Verify readiness and `GET /admin/treasury/operational-status`.
7. Enable `DEPOSIT_SWEEP_ENABLED=true`.
8. Confirm the sweep reaches `CONFIRMED` and reconciliation passes.

Blocked sweeps are never retried automatically when the provider result is
ambiguous. Inspect `GET /admin/deposits/sweeps?status=BLOCKED` and Privy/RPC
records before any manual action.
