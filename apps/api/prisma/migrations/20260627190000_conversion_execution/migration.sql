ALTER TYPE "LedgerTransactionType" ADD VALUE 'CONVERT_RESERVE';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'CONVERT_RELEASE';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'CONVERT_TRADE';

CREATE TYPE "ConversionProvider" AS ENUM ('ONEINCH', 'INTERNAL_RESERVE', 'CEX');
CREATE TYPE "ConversionQuoteStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED');
CREATE TYPE "ConversionStatus" AS ENUM ('PENDING', 'EXECUTING', 'FILLED', 'FAILED', 'CANCELLED');

CREATE TABLE "conversion_quotes" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fromAssetId" TEXT NOT NULL,
  "toAssetId" TEXT NOT NULL,
  "provider" "ConversionProvider" NOT NULL,
  "status" "ConversionQuoteStatus" NOT NULL DEFAULT 'ACTIVE',
  "networkKey" TEXT NOT NULL,
  "fromAmount" DECIMAL(38,18) NOT NULL,
  "expectedToAmount" DECIMAL(38,18) NOT NULL,
  "minToAmount" DECIMAL(38,18) NOT NULL,
  "feeAmount" DECIMAL(38,18) NOT NULL,
  "slippageBps" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "providerData" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversion_quotes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "clientConversionId" TEXT NOT NULL,
  "fromAssetId" TEXT NOT NULL,
  "toAssetId" TEXT NOT NULL,
  "provider" "ConversionProvider" NOT NULL,
  "status" "ConversionStatus" NOT NULL DEFAULT 'PENDING',
  "networkKey" TEXT NOT NULL,
  "fromAmount" DECIMAL(38,18) NOT NULL,
  "expectedToAmount" DECIMAL(38,18) NOT NULL,
  "minToAmount" DECIMAL(38,18) NOT NULL,
  "actualToAmount" DECIMAL(38,18),
  "feeAmount" DECIMAL(38,18) NOT NULL,
  "approvalTxHash" TEXT,
  "txHash" TEXT,
  "providerRequestId" TEXT,
  "executionData" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "failureReason" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "conversions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversions_quoteId_key" ON "conversions"("quoteId");
CREATE UNIQUE INDEX "conversions_txHash_key" ON "conversions"("txHash");
CREATE UNIQUE INDEX "conversions_userId_clientConversionId_key" ON "conversions"("userId", "clientConversionId");
CREATE INDEX "conversion_quotes_userId_createdAt_idx" ON "conversion_quotes"("userId", "createdAt");
CREATE INDEX "conversion_quotes_status_expiresAt_idx" ON "conversion_quotes"("status", "expiresAt");
CREATE INDEX "conversions_userId_createdAt_idx" ON "conversions"("userId", "createdAt");
CREATE INDEX "conversions_status_createdAt_idx" ON "conversions"("status", "createdAt");

ALTER TABLE "conversion_quotes" ADD CONSTRAINT "conversion_quotes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversion_quotes" ADD CONSTRAINT "conversion_quotes_fromAssetId_fkey" FOREIGN KEY ("fromAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversion_quotes" ADD CONSTRAINT "conversion_quotes_toAssetId_fkey" FOREIGN KEY ("toAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "conversion_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_fromAssetId_fkey" FOREIGN KEY ("fromAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_toAssetId_fkey" FOREIGN KEY ("toAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
