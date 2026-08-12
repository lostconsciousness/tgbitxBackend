ALTER TYPE "CustodyAccountRole" ADD VALUE IF NOT EXISTS 'SPOT_LIQUIDITY';

ALTER TABLE "token_contracts"
ADD COLUMN "minDepositAmount" DECIMAL(38,18) NOT NULL DEFAULT 0;

CREATE TABLE "tron_deposit_scan_cursors" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "depositAddressId" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "lastTimestampMs" BIGINT NOT NULL DEFAULT 0,
    "lastBlock" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tron_deposit_scan_cursors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tron_deposit_scan_cursors_key_key"
ON "tron_deposit_scan_cursors"("key");

CREATE UNIQUE INDEX "tron_deposit_scan_cursors_depositAddressId_stream_key"
ON "tron_deposit_scan_cursors"("depositAddressId", "stream");

CREATE INDEX "tron_deposit_scan_cursors_networkId_stream_updatedAt_idx"
ON "tron_deposit_scan_cursors"("networkId", "stream", "updatedAt");

ALTER TABLE "tron_deposit_scan_cursors"
ADD CONSTRAINT "tron_deposit_scan_cursors_networkId_fkey"
FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tron_deposit_scan_cursors"
ADD CONSTRAINT "tron_deposit_scan_cursors_depositAddressId_fkey"
FOREIGN KEY ("depositAddressId") REFERENCES "user_deposit_addresses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "token_contracts" tc
SET "minDepositAmount" = 1
FROM "assets" a, "networks" n
WHERE tc."assetId" = a.id
  AND tc."networkId" = n.id
  AND n."chainKey" = 'tron'
  AND a.symbol IN ('TRX', 'USDT');
