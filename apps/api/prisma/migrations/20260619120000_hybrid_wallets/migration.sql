DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "wallets"
    GROUP BY "chain", lower("address")
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Hybrid wallet migration blocked: duplicate wallet addresses exist across users. Resolve duplicates before retrying.';
  END IF;
END
$$;

ALTER TYPE "WalletType" RENAME VALUE 'EMBEDDED_PLACEHOLDER' TO 'EMBEDDED';

CREATE TYPE "WalletProvider" AS ENUM ('SIWE', 'PRIVY');

ALTER TABLE "wallets"
  ADD COLUMN "provider" "WalletProvider" NOT NULL DEFAULT 'SIWE',
  ADD COLUMN "providerUserRef" TEXT,
  ADD COLUMN "providerWalletRef" TEXT,
  ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId"
      ORDER BY
        CASE WHEN "status" = 'ACTIVE' THEN 0 ELSE 1 END,
        "verifiedAt" DESC NULLS LAST,
        "createdAt" ASC
    ) AS position
  FROM "wallets"
)
UPDATE "wallets"
SET "isPrimary" = true
FROM ranked
WHERE "wallets"."id" = ranked."id"
  AND ranked.position = 1
  AND "wallets"."status" = 'ACTIVE';

ALTER TABLE "wallet_siwe_nonces"
  ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'localhost:3000',
  ADD COLUMN "uri" TEXT NOT NULL DEFAULT 'http://localhost:3000',
  ADD COLUMN "chainId" INTEGER NOT NULL DEFAULT 42161,
  ADD COLUMN "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DROP INDEX "wallets_userId_chain_address_key";

CREATE UNIQUE INDEX "wallets_chain_address_key"
  ON "wallets"("chain", "address");

CREATE UNIQUE INDEX "wallets_providerWalletRef_key"
  ON "wallets"("providerWalletRef");

CREATE INDEX "wallets_userId_status_idx"
  ON "wallets"("userId", "status");

CREATE INDEX "wallets_provider_providerUserRef_idx"
  ON "wallets"("provider", "providerUserRef");

CREATE UNIQUE INDEX "wallets_one_active_primary_per_user_idx"
  ON "wallets"("userId")
  WHERE "status" = 'ACTIVE' AND "isPrimary" = true;

CREATE UNIQUE INDEX "wallets_one_active_embedded_per_user_chain_idx"
  ON "wallets"("userId", "chain")
  WHERE "status" = 'ACTIVE' AND "type" = 'EMBEDDED';
