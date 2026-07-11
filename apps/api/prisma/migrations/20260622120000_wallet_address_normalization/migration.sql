DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "wallets"
    GROUP BY "chain", lower("address")
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Wallet address normalization blocked: case-insensitive duplicate addresses exist.';
  END IF;
END
$$;

DROP INDEX "wallets_chain_address_key";

UPDATE "wallets"
SET "address" = lower("address");

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_address_lowercase_check"
  CHECK ("address" = lower("address"));

CREATE UNIQUE INDEX "wallets_chain_address_key"
  ON "wallets"("chain", "address");
