-- AlterTable
ALTER TABLE "wallet_siwe_nonces" ALTER COLUMN "domain" DROP DEFAULT,
ALTER COLUMN "uri" DROP DEFAULT,
ALTER COLUMN "chainId" DROP DEFAULT,
ALTER COLUMN "issuedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "custody_balance_snapshots_custodyAccountId_assetId_capturedAt_i" RENAME TO "custody_balance_snapshots_custodyAccountId_assetId_captured_idx";
