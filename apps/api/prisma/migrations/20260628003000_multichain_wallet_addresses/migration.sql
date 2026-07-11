ALTER TABLE "wallets"
  DROP CONSTRAINT IF EXISTS "wallets_address_lowercase_check";

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_address_lowercase_check"
  CHECK (
    "chain" IN ('SOLANA', 'SOLANA_DEVNET', 'TRON', 'TRON_NILE', 'TRON_SHASTA')
    OR "address" = lower("address")
  );
