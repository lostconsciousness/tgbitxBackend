# Operations: Spot liquidity and Tron recovery

## Safety boundaries

The Spot reserve is a separate Privy EVM wallet with custody role `SPOT_LIQUIDITY`. Never fund it from user liabilities, B-book platform capital, insurance, or Hyperliquid collateral.

Production Spot activation requires all of the following:

- `PRIVY_SPOT_LIQUIDITY_POLICY_ID`
- `PRIVY_SPOT_LIQUIDITY_WALLET_ID`
- `SPOT_LIQUIDITY_ADDRESS`
- `SPOT_ONBOARDING_MIN_ASSETS=75` (operational floor; rejected, native-placeholder, and cross-asset alias contracts still fail individual safety checks)
- at least `200 USDC` on Ethereum, BNB, Base, Arbitrum, and Optimism
- at least `0.02 ETH` on Ethereum, `0.02 BNB` on BNB, and `0.005 ETH` on Base, Arbitrum, and Optimism

The policy updater pins the current 1inch spender returned by the authenticated 1inch API, permits approval only from verified `SPOT_CONVERT` token contracts, caps approval at 1000 token units, and permits router calls only on chain IDs `1`, `56`, `8453`, `42161`, and `10` with bounded native value.

## Spot rollout

1. Back up the database and production environment file.
2. Run migrations and deploy the backend with Spot still gated.
3. Run `npm run spot:onboard-assets` (dry-run). Do not apply unless `verified >= SPOT_ONBOARDING_MIN_ASSETS` (currently `75`).
4. Run `npm run spot:onboard-assets -- --apply`.
5. Create the Privy policy, set `PRIVY_SPOT_LIQUIDITY_POLICY_ID`, then run `npm run privy:update-spot-liquidity-policy`.
6. Run `npm run privy:provision-wallets`, save only the printed public wallet ID/address to server secrets, then run the seed to register custody rows.
7. Fund the wallet with separate capital and gas.
8. Enable networks in order: Arbitrum, BNB, Base, Optimism, Ethereum.
9. Verify `/convert/readiness`, `/convert/spot-assets`, tickers, books, and a buy/sell canary per network.

A network is excluded automatically below `100 USDC` or its configured gas floor.

## Tron scanner

Set `TRON_PRO_API_KEY` only in the server secret. Recommended runtime values:

```text
TRON_API_MAX_QPS=8
TRON_API_DAILY_BUDGET=80000
TRON_SCAN_TIMESTAMP_OVERLAP_MS=60000
```

The scanner reads confirmed inbound history in ascending order, follows every `fingerprint` page, and advances the address/stream cursor only after the complete fixed time window succeeds. Balance deltas never credit deposits.

## `a1009ae@icloud.com` recovery

Run dry-run first:

```bash
npm run tron:recover-deposits
```

The command refuses to proceed unless the confirmed transaction, official USDT contract, block, recipient, amount, receipt, internal TRX total, duplicate TRX total, and retained external dust match the immutable recovery manifest.

After reviewing the dry-run:

```bash
npm run tron:recover-deposits -- --apply
```

The apply is idempotent. It credits the real `100 USDT` tx once, reverses `35.999999 TRX` internal fee funding and `0.000002 TRX` duplicate records, retains `0.000006 TRX` external dust, closes the incorrect blocked sweep, and triggers the normal realtime balance/sweep path.

If the production API key has not yet been issued, the one-off immutable manifest check can be run explicitly with `--allow-public-verification`. This exception applies only to this recovery command; the continuous production scanner/readiness still requires `TRON_PRO_API_KEY`.

After apply, verify the user USDT ledger balance, the new sweep, treasury receipt, personal-address USDT balance, and ledger/custody reconciliation. Return only unused internal TRX after the USDT sweep is confirmed.
