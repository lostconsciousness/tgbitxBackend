ALTER TYPE "Chain" ADD VALUE IF NOT EXISTS 'ETHEREUM';
ALTER TYPE "Chain" ADD VALUE IF NOT EXISTS 'BASE';
ALTER TYPE "Chain" ADD VALUE IF NOT EXISTS 'OPTIMISM';
ALTER TYPE "Chain" ADD VALUE IF NOT EXISTS 'POLYGON';
ALTER TYPE "Chain" ADD VALUE IF NOT EXISTS 'BNB';
ALTER TYPE "Chain" ADD VALUE IF NOT EXISTS 'AVALANCHE';
ALTER TYPE "Chain" ADD VALUE IF NOT EXISTS 'SOLANA';
ALTER TYPE "Chain" ADD VALUE IF NOT EXISTS 'BITCOIN';

CREATE TYPE "NetworkFamily" AS ENUM ('EVM', 'SVM', 'UTXO');
CREATE TYPE "TokenStandard" AS ENUM ('NATIVE', 'ERC20', 'SPL', 'BTC');

CREATE TABLE "networks" (
  "id" TEXT NOT NULL,
  "chainKey" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "family" "NetworkFamily" NOT NULL,
  "legacyChain" "Chain",
  "caip2" TEXT,
  "chainId" INTEGER,
  "mainnet" BOOLEAN NOT NULL DEFAULT false,
  "rpcPrimaryEnv" TEXT,
  "rpcFallbackEnv" TEXT,
  "confirmations" INTEGER NOT NULL DEFAULT 12,
  "reorgOverlapBlocks" INTEGER NOT NULL DEFAULT 30,
  "depositEnabled" BOOLEAN NOT NULL DEFAULT false,
  "withdrawalEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "networks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "token_contracts" (
  "id" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "networkId" TEXT NOT NULL,
  "standard" "TokenStandard" NOT NULL,
  "address" TEXT,
  "decimals" INTEGER NOT NULL,
  "depositEnabled" BOOLEAN NOT NULL DEFAULT false,
  "withdrawalEnabled" BOOLEAN NOT NULL DEFAULT false,
  "withdrawalFeeAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "minWithdrawalAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "contractVerifiedAt" TIMESTAMP(3),
  "contractCodeHash" TEXT,
  "verifiedChainId" INTEGER,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "token_contracts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deposit_indexer_cursors" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "networkId" TEXT NOT NULL,
  "tokenContractId" TEXT,
  "lastBlock" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deposit_indexer_cursors_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "deposits" ADD COLUMN "tokenContractId" TEXT;
ALTER TABLE "deposit_intents" ADD COLUMN "tokenContractId" TEXT;
ALTER TABLE "withdrawals" ADD COLUMN "tokenContractId" TEXT;

CREATE UNIQUE INDEX "networks_chainKey_key" ON "networks"("chainKey");
CREATE UNIQUE INDEX "networks_caip2_key" ON "networks"("caip2");
CREATE UNIQUE INDEX "networks_chainId_key" ON "networks"("chainId");
CREATE INDEX "networks_family_depositEnabled_idx" ON "networks"("family", "depositEnabled");
CREATE INDEX "networks_family_withdrawalEnabled_idx" ON "networks"("family", "withdrawalEnabled");

CREATE UNIQUE INDEX "token_contracts_assetId_networkId_standard_key" ON "token_contracts"("assetId", "networkId", "standard");
CREATE UNIQUE INDEX "token_contracts_networkId_address_key" ON "token_contracts"("networkId", "address");
CREATE INDEX "token_contracts_networkId_depositEnabled_idx" ON "token_contracts"("networkId", "depositEnabled");
CREATE INDEX "token_contracts_networkId_withdrawalEnabled_idx" ON "token_contracts"("networkId", "withdrawalEnabled");

CREATE UNIQUE INDEX "deposit_indexer_cursors_key_key" ON "deposit_indexer_cursors"("key");
CREATE INDEX "deposit_indexer_cursors_networkId_tokenContractId_idx" ON "deposit_indexer_cursors"("networkId", "tokenContractId");

CREATE INDEX "deposits_tokenContractId_status_idx" ON "deposits"("tokenContractId", "status");
CREATE INDEX "deposit_intents_tokenContractId_status_idx" ON "deposit_intents"("tokenContractId", "status");
CREATE INDEX "withdrawals_tokenContractId_status_idx" ON "withdrawals"("tokenContractId", "status");

DROP INDEX IF EXISTS "deposits_txHash_logIndex_key";
CREATE UNIQUE INDEX "deposits_network_txHash_logIndex_key" ON "deposits"("network", "txHash", "logIndex");

ALTER TABLE "token_contracts"
  ADD CONSTRAINT "token_contracts_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "token_contracts"
  ADD CONSTRAINT "token_contracts_networkId_fkey"
  FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deposit_indexer_cursors"
  ADD CONSTRAINT "deposit_indexer_cursors_networkId_fkey"
  FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deposit_indexer_cursors"
  ADD CONSTRAINT "deposit_indexer_cursors_tokenContractId_fkey"
  FOREIGN KEY ("tokenContractId") REFERENCES "token_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deposits"
  ADD CONSTRAINT "deposits_tokenContractId_fkey"
  FOREIGN KEY ("tokenContractId") REFERENCES "token_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposit_intents"
  ADD CONSTRAINT "deposit_intents_tokenContractId_fkey"
  FOREIGN KEY ("tokenContractId") REFERENCES "token_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_tokenContractId_fkey"
  FOREIGN KEY ("tokenContractId") REFERENCES "token_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
