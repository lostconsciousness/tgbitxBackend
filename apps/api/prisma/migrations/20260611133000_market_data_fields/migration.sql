ALTER TABLE "markets"
ADD COLUMN "providerName" TEXT,
ADD COLUMN "providerSymbol" TEXT,
ADD COLUMN "tradingViewSymbol" TEXT,
ADD COLUMN "orderbookEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "markets_providerName_providerSymbol_idx" ON "markets"("providerName", "providerSymbol");
