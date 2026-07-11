ALTER TYPE "ProviderOrderStatus" ADD VALUE IF NOT EXISTS 'RECONCILIATION_REQUIRED';

ALTER TABLE "provider_orders"
  ADD COLUMN "nextSyncAt" TIMESTAMP(3),
  ADD COLUMN "syncAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failureReason" TEXT,
  ADD COLUMN "reconciliationRequiredAt" TIMESTAMP(3);

CREATE INDEX "provider_orders_status_nextSyncAt_idx"
  ON "provider_orders"("status", "nextSyncAt");

ALTER TABLE "orders" ADD COLUMN "liquidationEventId" TEXT;
CREATE UNIQUE INDEX "orders_liquidationEventId_key" ON "orders"("liquidationEventId");
ALTER TABLE "orders" ADD CONSTRAINT "orders_liquidationEventId_fkey"
  FOREIGN KEY ("liquidationEventId") REFERENCES "liquidation_events"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
