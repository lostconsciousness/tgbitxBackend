DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "wallets" a
    JOIN "wallets" b
      ON lower(a."address") = lower(b."address")
     AND a."id" <> b."id"
    WHERE a."chain" <> b."chain"
  ) THEN
    RAISE EXCEPTION 'Cannot move wallets to ARBITRUM_SEPOLIA: duplicate addresses exist across chains';
  END IF;
END $$;

ALTER TABLE "assets"
  ADD COLUMN "contractVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "contractCodeHash" TEXT,
  ADD COLUMN "verifiedChainId" INTEGER;

UPDATE "wallets"
SET "chain" = 'ARBITRUM_SEPOLIA'
WHERE "chain" = 'ARBITRUM';

UPDATE "assets"
SET
  "chain" = 'ARBITRUM_SEPOLIA',
  "depositEnabled" = false,
  "withdrawalEnabled" = false,
  "tokenAddress" = NULL,
  "contractVerifiedAt" = NULL,
  "contractCodeHash" = NULL,
  "verifiedChainId" = NULL
WHERE "symbol" IN ('USDT', 'WETH', 'WBTC', 'ARB');

UPDATE "assets"
SET
  "chain" = 'ARBITRUM_SEPOLIA',
  "tokenAddress" = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  "decimals" = 6,
  "depositEnabled" = true,
  "withdrawalEnabled" = true,
  "contractVerifiedAt" = CURRENT_TIMESTAMP,
  "verifiedChainId" = 421614
WHERE "symbol" = 'USDC';

UPDATE "assets"
SET "chain" = 'ARBITRUM_SEPOLIA'
WHERE "chain" = 'ARBITRUM';

UPDATE "deposit_intents"
SET "network" = 'ARBITRUM_SEPOLIA'
WHERE "network" = 'ARBITRUM'
  AND "status" IN ('PENDING', 'SUBMITTED', 'DETECTED', 'CONFIRMED');

UPDATE "deposits"
SET "network" = 'ARBITRUM_SEPOLIA'
WHERE "network" = 'ARBITRUM'
  AND "status" IN ('DETECTED', 'PENDING_CONFIRMATION', 'UNMATCHED');

UPDATE "withdrawals"
SET "network" = 'ARBITRUM_SEPOLIA'
WHERE "network" = 'ARBITRUM'
  AND "status" NOT IN ('CONFIRMED', 'REJECTED', 'FAILED', 'CANCELLED');

CREATE TABLE "withdrawal_addresses" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "network" "Chain" NOT NULL,
  "address" TEXT NOT NULL,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "withdrawal_addresses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_webhook_events" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "referenceId" TEXT,
  "providerTransactionId" TEXT,
  "payload" JSONB NOT NULL,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "withdrawal_addresses_userId_network_address_key"
  ON "withdrawal_addresses"("userId", "network", "address");
CREATE INDEX "withdrawal_addresses_userId_firstSeenAt_idx"
  ON "withdrawal_addresses"("userId", "firstSeenAt");
CREATE INDEX "provider_webhook_events_provider_referenceId_idx"
  ON "provider_webhook_events"("provider", "referenceId");
CREATE INDEX "provider_webhook_events_eventType_createdAt_idx"
  ON "provider_webhook_events"("eventType", "createdAt");

ALTER TABLE "withdrawal_addresses"
  ADD CONSTRAINT "withdrawal_addresses_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
