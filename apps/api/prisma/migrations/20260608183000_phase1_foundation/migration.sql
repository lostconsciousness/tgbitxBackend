CREATE TYPE "Chain" AS ENUM ('ARBITRUM');
CREATE TYPE "WalletType" AS ENUM ('EXTERNAL', 'EMBEDDED_PLACEHOLDER');
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "AssetType" AS ENUM ('CRYPTO', 'STABLECOIN');
CREATE TYPE "MarketType" AS ENUM ('SPOT', 'PERP');
CREATE TYPE "MarketStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');
CREATE TYPE "LedgerAccountType" AS ENUM ('USER_SPOT', 'USER_PERP_MARGIN', 'PLATFORM_FEES', 'PLATFORM_BBOOK', 'PLATFORM_RISK', 'PENDING_DEPOSIT', 'PENDING_WITHDRAWAL', 'PROVIDER_CLEARING', 'GAS_FEES', 'REFERRAL', 'INSURANCE');
CREATE TYPE "LedgerEntryDirection" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "LedgerTransactionType" AS ENUM ('DEPOSIT_CREDIT', 'WITHDRAWAL_RESERVE', 'WITHDRAWAL_RELEASE', 'WITHDRAWAL_FEE', 'ADMIN_ADJUSTMENT');
CREATE TYPE "LedgerTransactionStatus" AS ENUM ('POSTED', 'VOIDED');
CREATE TYPE "DepositStatus" AS ENUM ('DETECTED', 'PENDING_CONFIRMATION', 'CREDITED', 'DUPLICATE', 'UNMATCHED', 'FAILED');
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'RISK_CHECK', 'PENDING_APPROVAL', 'APPROVED', 'BROADCASTING', 'BROADCASTED', 'CONFIRMED', 'REJECTED', 'FAILED', 'CANCELLED');
CREATE TYPE "ReconciliationType" AS ENUM ('LEDGER_BALANCE', 'DEPOSIT_INDEXER', 'WITHDRAWAL_STATUS');
CREATE TYPE "ReconciliationStatus" AS ENUM ('RUNNING', 'PASSED', 'FAILED');

CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'ARBITRUM',
    "type" "WalletType" NOT NULL DEFAULT 'EXTERNAL',
    "address" TEXT NOT NULL,
    "label" TEXT,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wallet_siwe_nonces" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "address" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_siwe_nonces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'ARBITRUM',
    "tokenAddress" TEXT,
    "decimals" INTEGER NOT NULL,
    "depositEnabled" BOOLEAN NOT NULL DEFAULT true,
    "withdrawalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "withdrawalFeeAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "minWithdrawalAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "type" "MarketType" NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'ACTIVE',
    "baseAssetId" TEXT NOT NULL,
    "quoteAssetId" TEXT NOT NULL,
    "pricePrecision" INTEGER NOT NULL,
    "sizePrecision" INTEGER NOT NULL,
    "minOrderSize" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "userId" TEXT,
    "assetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ledger_transactions" (
    "id" TEXT NOT NULL,
    "type" "LedgerTransactionType" NOT NULL,
    "status" "LedgerTransactionStatus" NOT NULL DEFAULT 'POSTED',
    "idempotencyKey" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "direction" "LedgerEntryDirection" NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "balance_snapshots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "available" DECIMAL(38,18) NOT NULL,
    "total" DECIMAL(38,18) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "balance_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deposits" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "assetId" TEXT NOT NULL,
    "walletId" TEXT,
    "network" "Chain" NOT NULL DEFAULT 'ARBITRUM',
    "fromAddress" TEXT,
    "toAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER,
    "blockNumber" INTEGER,
    "amount" DECIMAL(38,18) NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "status" "DepositStatus" NOT NULL DEFAULT 'DETECTED',
    "idempotencyKey" TEXT NOT NULL,
    "creditedLedgerTransactionId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "network" "Chain" NOT NULL DEFAULT 'ARBITRUM',
    "toAddress" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "feeAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "adminApprovalRequired" BOOLEAN NOT NULL DEFAULT true,
    "requestedLedgerTransactionId" TEXT,
    "approvedByUserId" TEXT,
    "rejectedByUserId" TEXT,
    "approvalReason" TEXT,
    "rejectionReason" TEXT,
    "txHash" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "broadcastedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "type" "ReconciliationType" NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "details" JSONB,
    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "wallets_userId_chain_address_key" ON "wallets"("userId", "chain", "address");
CREATE INDEX "wallets_address_idx" ON "wallets"("address");
CREATE UNIQUE INDEX "wallet_siwe_nonces_nonce_key" ON "wallet_siwe_nonces"("nonce");
CREATE INDEX "wallet_siwe_nonces_address_idx" ON "wallet_siwe_nonces"("address");
CREATE INDEX "wallet_siwe_nonces_expiresAt_idx" ON "wallet_siwe_nonces"("expiresAt");
CREATE UNIQUE INDEX "assets_symbol_key" ON "assets"("symbol");
CREATE UNIQUE INDEX "assets_tokenAddress_key" ON "assets"("tokenAddress");
CREATE INDEX "assets_chain_idx" ON "assets"("chain");
CREATE UNIQUE INDEX "markets_symbol_key" ON "markets"("symbol");
CREATE INDEX "markets_type_status_idx" ON "markets"("type", "status");
CREATE UNIQUE INDEX "ledger_accounts_key_key" ON "ledger_accounts"("key");
CREATE INDEX "ledger_accounts_userId_assetId_type_idx" ON "ledger_accounts"("userId", "assetId", "type");
CREATE INDEX "ledger_accounts_assetId_type_idx" ON "ledger_accounts"("assetId", "type");
CREATE UNIQUE INDEX "ledger_transactions_idempotencyKey_key" ON "ledger_transactions"("idempotencyKey");
CREATE INDEX "ledger_transactions_referenceType_referenceId_idx" ON "ledger_transactions"("referenceType", "referenceId");
CREATE INDEX "ledger_entries_accountId_idx" ON "ledger_entries"("accountId");
CREATE INDEX "ledger_entries_assetId_idx" ON "ledger_entries"("assetId");
CREATE INDEX "balance_snapshots_userId_assetId_createdAt_idx" ON "balance_snapshots"("userId", "assetId", "createdAt");
CREATE UNIQUE INDEX "deposits_idempotencyKey_key" ON "deposits"("idempotencyKey");
CREATE UNIQUE INDEX "deposits_creditedLedgerTransactionId_key" ON "deposits"("creditedLedgerTransactionId");
CREATE UNIQUE INDEX "deposits_txHash_logIndex_key" ON "deposits"("txHash", "logIndex");
CREATE INDEX "deposits_userId_status_idx" ON "deposits"("userId", "status");
CREATE INDEX "deposits_assetId_status_idx" ON "deposits"("assetId", "status");
CREATE UNIQUE INDEX "withdrawals_requestedLedgerTransactionId_key" ON "withdrawals"("requestedLedgerTransactionId");
CREATE INDEX "withdrawals_userId_status_idx" ON "withdrawals"("userId", "status");
CREATE INDEX "withdrawals_assetId_status_idx" ON "withdrawals"("assetId", "status");
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");
CREATE INDEX "reconciliation_runs_type_status_idx" ON "reconciliation_runs"("type", "status");

ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_siwe_nonces" ADD CONSTRAINT "wallet_siwe_nonces_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "markets" ADD CONSTRAINT "markets_baseAssetId_fkey" FOREIGN KEY ("baseAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "markets" ADD CONSTRAINT "markets_quoteAssetId_fkey" FOREIGN KEY ("quoteAssetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "ledger_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_creditedLedgerTransactionId_fkey" FOREIGN KEY ("creditedLedgerTransactionId") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_rejectedByUserId_fkey" FOREIGN KEY ("rejectedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_requestedLedgerTransactionId_fkey" FOREIGN KEY ("requestedLedgerTransactionId") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
