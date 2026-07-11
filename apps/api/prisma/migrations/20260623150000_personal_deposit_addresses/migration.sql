ALTER TYPE "CustodyAccountRole" ADD VALUE IF NOT EXISTS 'SWEEP_GAS';

CREATE TYPE "DepositChannel" AS ENUM ('PERSONAL_ADDRESS', 'WEB3_INTENT', 'UNMATCHED');
CREATE TYPE "UserDepositAddressStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'PAUSED', 'FAILED');
CREATE TYPE "DepositSweepStatus" AS ENUM (
  'PENDING',
  'FUNDING_GAS',
  'BROADCASTING',
  'BROADCASTED',
  'CONFIRMED',
  'BLOCKED',
  'FAILED'
);

CREATE TABLE "user_deposit_addresses" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "network" "Chain" NOT NULL,
  "address" TEXT NOT NULL,
  "provider" "CustodyProvider" NOT NULL DEFAULT 'PRIVY',
  "providerWalletRef" TEXT,
  "externalId" TEXT NOT NULL,
  "policyRef" TEXT,
  "status" "UserDepositAddressStatus" NOT NULL DEFAULT 'PROVISIONING',
  "failureReason" TEXT,
  "provisionedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_deposit_addresses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deposit_sweeps" (
  "id" TEXT NOT NULL,
  "depositAddressId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "amount" DECIMAL(38,18) NOT NULL,
  "rawAmount" TEXT NOT NULL,
  "status" "DepositSweepStatus" NOT NULL DEFAULT 'PENDING',
  "gasFundingProviderRequestId" TEXT,
  "gasFundingTxHash" TEXT,
  "providerRequestId" TEXT,
  "txHash" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "failureReason" TEXT,
  "startedAt" TIMESTAMP(3),
  "broadcastedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deposit_sweeps_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "deposits"
  ADD COLUMN "depositAddressId" TEXT,
  ADD COLUMN "sweepId" TEXT,
  ADD COLUMN "channel" "DepositChannel" NOT NULL DEFAULT 'UNMATCHED',
  ADD COLUMN "rawAmount" TEXT;

UPDATE "deposits"
SET "channel" = CASE
  WHEN "intentId" IS NOT NULL THEN 'WEB3_INTENT'::"DepositChannel"
  ELSE 'UNMATCHED'::"DepositChannel"
END;

CREATE UNIQUE INDEX "user_deposit_addresses_providerWalletRef_key" ON "user_deposit_addresses"("providerWalletRef");
CREATE UNIQUE INDEX "user_deposit_addresses_externalId_key" ON "user_deposit_addresses"("externalId");
CREATE UNIQUE INDEX "user_deposit_addresses_userId_network_key" ON "user_deposit_addresses"("userId", "network");
CREATE UNIQUE INDEX "user_deposit_addresses_network_address_key" ON "user_deposit_addresses"("network", "address");
CREATE INDEX "user_deposit_addresses_network_status_idx" ON "user_deposit_addresses"("network", "status");

CREATE UNIQUE INDEX "deposit_sweeps_gasFundingProviderRequestId_key" ON "deposit_sweeps"("gasFundingProviderRequestId");
CREATE UNIQUE INDEX "deposit_sweeps_gasFundingTxHash_key" ON "deposit_sweeps"("gasFundingTxHash");
CREATE UNIQUE INDEX "deposit_sweeps_providerRequestId_key" ON "deposit_sweeps"("providerRequestId");
CREATE UNIQUE INDEX "deposit_sweeps_txHash_key" ON "deposit_sweeps"("txHash");
CREATE INDEX "deposit_sweeps_status_createdAt_idx" ON "deposit_sweeps"("status", "createdAt");
CREATE INDEX "deposit_sweeps_depositAddressId_assetId_idx" ON "deposit_sweeps"("depositAddressId", "assetId");
CREATE UNIQUE INDEX "deposit_sweeps_active_address_asset_key"
  ON "deposit_sweeps"("depositAddressId", "assetId")
  WHERE "status" IN ('PENDING', 'FUNDING_GAS', 'BROADCASTING', 'BROADCASTED', 'BLOCKED');

CREATE INDEX "deposits_depositAddressId_status_idx" ON "deposits"("depositAddressId", "status");
CREATE INDEX "deposits_sweepId_idx" ON "deposits"("sweepId");

ALTER TABLE "user_deposit_addresses"
  ADD CONSTRAINT "user_deposit_addresses_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deposit_sweeps"
  ADD CONSTRAINT "deposit_sweeps_depositAddressId_fkey"
  FOREIGN KEY ("depositAddressId") REFERENCES "user_deposit_addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposit_sweeps"
  ADD CONSTRAINT "deposit_sweeps_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deposits"
  ADD CONSTRAINT "deposits_depositAddressId_fkey"
  FOREIGN KEY ("depositAddressId") REFERENCES "user_deposit_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deposits"
  ADD CONSTRAINT "deposits_sweepId_fkey"
  FOREIGN KEY ("sweepId") REFERENCES "deposit_sweeps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
