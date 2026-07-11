# Mainnet Readiness

Status: **PILOT IMPLEMENTED — MANUAL PROVISIONING REQUIRED**

The Hyperliquid mainnet A-book path is guarded by strict startup validation,
readiness checks and reconciliation. Follow
`docs/hyperliquid-mainnet-pilot.md`; do not enable execution before provisioning,
funding and the paused canary procedure are complete.

## Completed

- Database migration and Prisma schema.
- Atomic deposit credit, withdrawal reserve/release and margin settlement.
- Deposit intent verification and reorg-aware scanner.
- Privy custody and Hyperliquid agent adapters.
- B-book capital/exposure gates.
- Isolated positions, PnL and liquidation fee settlement.
- Treasury, provider and B-book reconciliation endpoints.
- Authenticated private WebSocket.
- Build, unit tests, PostgreSQL integration tests and production dependency
  audit.
- Local API bootstrap and health smoke test.

## Required Before Testnet E2E

- Arbitrum Sepolia primary/fallback RPC URLs.
- Test ERC-20 contract addresses and balances.
- Privy server wallet, policy and authorization configuration.
- Deposit treasury and withdrawal hot-wallet public addresses.
- Hyperliquid testnet master/agent wallets and funded collateral.
- Safe test multisig owners and address.
- Monitoring alert destination.

## Required Before Mainnet Approval

- At least seven continuous days without unresolved reconciliation mismatch.
- Review of Privy policies and Safe signer quorum.
- Emergency pause and provider outage drills.
- Withdrawal duplicate/ambiguous-broadcast recovery drill.
- External security review of custody, ledger and trading flows.
- Legal/custody/risk approval.
- Explicit production capital and insurance limits.
- Separate explicit approval to set `MAINNET_ENABLED=true`.
