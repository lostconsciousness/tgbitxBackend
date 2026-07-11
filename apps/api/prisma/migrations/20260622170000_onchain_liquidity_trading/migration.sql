CREATE TYPE "DepositIntentStatus" AS ENUM ('PENDING', 'SUBMITTED', 'DETECTED', 'CONFIRMED', 'CREDITED', 'EXPIRED', 'FAILED', 'CANCELLED');
CREATE TYPE "CustodyAccountRole" AS ENUM ('DEPOSIT_TREASURY', 'WITHDRAWAL_HOT', 'SAFE_RESERVE', 'HYPERLIQUID_COLLATERAL', 'PLATFORM_CAPITAL', 'INSURANCE');
CREATE TYPE "CustodyProvider" AS ENUM ('PRIVY', 'SAFE', 'HYPERLIQUID', 'EXTERNAL');
CREATE TYPE "CustodyAccountStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');
CREATE TYPE "TreasuryTransferStatus" AS ENUM ('PROPOSED', 'APPROVED', 'BROADCASTING', 'BROADCASTED', 'CONFIRMED', 'REJECTED', 'FAILED');
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP_LOSS', 'TAKE_PROFIT');
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'VALIDATED', 'REJECTED', 'ROUTED', 'PROVIDER_PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED', 'FAILED', 'FORCE_CLOSED', 'LIQUIDATED');
CREATE TYPE "ExecutionRoute" AS ENUM ('A_BOOK_HYPERLIQUID', 'B_BOOK_INTERNAL');
CREATE TYPE "PositionSide" AS ENUM ('LONG', 'SHORT');
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED', 'LIQUIDATED');
CREATE TYPE "MarginMode" AS ENUM ('ISOLATED');
CREATE TYPE "ProviderOrderStatus" AS ENUM ('PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'FAILED');
CREATE TYPE "LiquidationStatus" AS ENUM ('TRIGGERED', 'CLOSING', 'COMPLETED', 'FAILED');

ALTER TYPE "Chain" ADD VALUE 'ARBITRUM_SEPOLIA';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'MARGIN_RESERVE';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'MARGIN_RELEASE';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'TRADE_PNL';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'TRADING_FEE';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'FUNDING';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'LIQUIDATION';
ALTER TYPE "LedgerTransactionType" ADD VALUE 'TREASURY_TRANSFER';
ALTER TYPE "ReconciliationType" ADD VALUE 'TREASURY_BALANCE';
ALTER TYPE "ReconciliationType" ADD VALUE 'PROVIDER_BALANCE';
ALTER TYPE "ReconciliationType" ADD VALUE 'PROVIDER_ORDERS';
ALTER TYPE "ReconciliationType" ADD VALUE 'PROVIDER_POSITIONS';
ALTER TYPE "ReconciliationType" ADD VALUE 'BBOOK_EXPOSURE';

ALTER TABLE "deposits" ADD COLUMN "intentId" TEXT;
ALTER TABLE "withdrawals"
  ADD COLUMN "broadcastAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "broadcastNonce" BIGINT,
  ADD COLUMN "destinationFirstSeenAt" TIMESTAMP(3),
  ADD COLUMN "effectiveGasPrice" BIGINT,
  ADD COLUMN "gasUsed" BIGINT,
  ADD COLUMN "lastBroadcastError" TEXT,
  ADD COLUMN "providerRequestId" TEXT;

CREATE TABLE "deposit_intents" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "network" "Chain" NOT NULL,
  "fromAddress" TEXT NOT NULL,
  "treasuryAddress" TEXT NOT NULL,
  "amount" DECIMAL(38,18) NOT NULL,
  "rawAmount" TEXT NOT NULL,
  "txHash" TEXT,
  "status" "DepositIntentStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "detectedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "creditedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deposit_intents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "custody_accounts" (
  "id" TEXT NOT NULL,
  "role" "CustodyAccountRole" NOT NULL,
  "provider" "CustodyProvider" NOT NULL,
  "network" "Chain" NOT NULL,
  "address" TEXT NOT NULL,
  "providerWalletRef" TEXT,
  "policyRef" TEXT,
  "status" "CustodyAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custody_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "custody_balance_snapshots" (
  "id" TEXT NOT NULL,
  "custodyAccountId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "balance" DECIMAL(38,18) NOT NULL,
  "blockNumber" BIGINT,
  "source" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "custody_balance_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "treasury_transfers" (
  "id" TEXT NOT NULL,
  "sourceAccountId" TEXT NOT NULL,
  "destinationAccountId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "amount" DECIMAL(38,18) NOT NULL,
  "status" "TreasuryTransferStatus" NOT NULL DEFAULT 'PROPOSED',
  "reason" TEXT NOT NULL,
  "proposedByUserId" TEXT,
  "approvedByUserId" TEXT,
  "providerRequestId" TEXT,
  "txHash" TEXT,
  "failureReason" TEXT,
  "approvedAt" TIMESTAMP(3),
  "broadcastedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "treasury_transfers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "orders" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "clientOrderId" TEXT NOT NULL,
  "side" "OrderSide" NOT NULL,
  "type" "OrderType" NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
  "route" "ExecutionRoute",
  "size" DECIMAL(38,18) NOT NULL,
  "filledSize" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "price" DECIMAL(38,18),
  "averageFillPrice" DECIMAL(38,18),
  "triggerPrice" DECIMAL(38,18),
  "leverage" INTEGER NOT NULL,
  "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
  "marginMode" "MarginMode" NOT NULL DEFAULT 'ISOLATED',
  "marginReserved" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "feeAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "rejectionReason" TEXT,
  "marginLedgerTransactionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "trades" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "providerFillId" TEXT,
  "route" "ExecutionRoute" NOT NULL,
  "side" "OrderSide" NOT NULL,
  "price" DECIMAL(38,18) NOT NULL,
  "size" DECIMAL(38,18) NOT NULL,
  "notional" DECIMAL(38,18) NOT NULL,
  "feeAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "realizedPnl" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "executedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "positions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "side" "PositionSide" NOT NULL,
  "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
  "route" "ExecutionRoute" NOT NULL,
  "marginMode" "MarginMode" NOT NULL DEFAULT 'ISOLATED',
  "size" DECIMAL(38,18) NOT NULL,
  "entryPrice" DECIMAL(38,18) NOT NULL,
  "markPrice" DECIMAL(38,18) NOT NULL,
  "leverage" INTEGER NOT NULL,
  "margin" DECIMAL(38,18) NOT NULL,
  "maintenanceMargin" DECIMAL(38,18) NOT NULL,
  "liquidationPrice" DECIMAL(38,18) NOT NULL,
  "unrealizedPnl" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "realizedPnl" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "fundingPaid" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "providerPositionRef" TEXT,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_orders" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerOrderId" TEXT,
  "cloid" TEXT NOT NULL,
  "status" "ProviderOrderStatus" NOT NULL DEFAULT 'PENDING',
  "rawResponse" JSONB,
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provider_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "provider_fills" (
  "id" TEXT NOT NULL,
  "providerOrderId" TEXT NOT NULL,
  "providerFillId" TEXT NOT NULL,
  "price" DECIMAL(38,18) NOT NULL,
  "size" DECIMAL(38,18) NOT NULL,
  "feeAmount" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_fills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bbook_exposures" (
  "id" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "longNotional" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "shortNotional" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "netNotional" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "unrealizedPlatformPnl" DECIMAL(38,18) NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bbook_exposures_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "risk_configs" (
  "id" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "bbookEnabled" BOOLEAN NOT NULL DEFAULT false,
  "maxBbookOrderNotional" DECIMAL(38,18) NOT NULL DEFAULT 1000,
  "maxMarketExposure" DECIMAL(38,18) NOT NULL DEFAULT 5000,
  "maxTotalExposure" DECIMAL(38,18) NOT NULL DEFAULT 10000,
  "maxPlatformUnrealizedLoss" DECIMAL(38,18) NOT NULL DEFAULT 2000,
  "maxLeverage" INTEGER NOT NULL,
  "maintenanceMarginRate" DECIMAL(18,8) NOT NULL DEFAULT 0.005,
  "maxMarkAgeMs" INTEGER NOT NULL DEFAULT 2000,
  "maxOracleDeviationBps" INTEGER NOT NULL DEFAULT 100,
  "liquidationSlippageBps" INTEGER NOT NULL DEFAULT 50,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "risk_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fee_configs" (
  "id" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "makerFeeBps" INTEGER NOT NULL DEFAULT 2,
  "takerFeeBps" INTEGER NOT NULL DEFAULT 5,
  "liquidationFeeBps" INTEGER NOT NULL DEFAULT 50,
  "liquidationPlatformShareBps" INTEGER NOT NULL DEFAULT 7000,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fee_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "liquidation_events" (
  "id" TEXT NOT NULL,
  "positionId" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "status" "LiquidationStatus" NOT NULL DEFAULT 'TRIGGERED',
  "markPrice" DECIMAL(38,18) NOT NULL,
  "positionSize" DECIMAL(38,18) NOT NULL,
  "collateralBefore" DECIMAL(38,18) NOT NULL,
  "realizedPnl" DECIMAL(38,18) NOT NULL,
  "liquidationFee" DECIMAL(38,18) NOT NULL,
  "platformFee" DECIMAL(38,18) NOT NULL,
  "insuranceFee" DECIMAL(38,18) NOT NULL,
  "ledgerTransactionId" TEXT,
  "failureReason" TEXT,
  "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "liquidation_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deposit_intents_txHash_key" ON "deposit_intents"("txHash");
CREATE INDEX "deposit_intents_userId_status_idx" ON "deposit_intents"("userId", "status");
CREATE INDEX "deposit_intents_status_expiresAt_idx" ON "deposit_intents"("status", "expiresAt");
CREATE INDEX "custody_accounts_provider_status_idx" ON "custody_accounts"("provider", "status");
CREATE UNIQUE INDEX "custody_accounts_network_address_key" ON "custody_accounts"("network", "address");
CREATE UNIQUE INDEX "custody_accounts_role_network_key" ON "custody_accounts"("role", "network");
CREATE INDEX "custody_balance_snapshots_custodyAccountId_assetId_capturedAt_idx" ON "custody_balance_snapshots"("custodyAccountId", "assetId", "capturedAt");
CREATE UNIQUE INDEX "treasury_transfers_providerRequestId_key" ON "treasury_transfers"("providerRequestId");
CREATE UNIQUE INDEX "treasury_transfers_txHash_key" ON "treasury_transfers"("txHash");
CREATE INDEX "treasury_transfers_status_createdAt_idx" ON "treasury_transfers"("status", "createdAt");
CREATE UNIQUE INDEX "orders_marginLedgerTransactionId_key" ON "orders"("marginLedgerTransactionId");
CREATE INDEX "orders_userId_status_createdAt_idx" ON "orders"("userId", "status", "createdAt");
CREATE INDEX "orders_marketId_status_idx" ON "orders"("marketId", "status");
CREATE UNIQUE INDEX "orders_userId_clientOrderId_key" ON "orders"("userId", "clientOrderId");
CREATE UNIQUE INDEX "trades_providerFillId_key" ON "trades"("providerFillId");
CREATE INDEX "trades_userId_executedAt_idx" ON "trades"("userId", "executedAt");
CREATE INDEX "trades_marketId_executedAt_idx" ON "trades"("marketId", "executedAt");
CREATE INDEX "positions_marketId_status_idx" ON "positions"("marketId", "status");
CREATE INDEX "positions_userId_marketId_route_status_idx" ON "positions"("userId", "marketId", "route", "status");
CREATE UNIQUE INDEX "provider_orders_orderId_key" ON "provider_orders"("orderId");
CREATE UNIQUE INDEX "provider_orders_cloid_key" ON "provider_orders"("cloid");
CREATE INDEX "provider_orders_provider_status_idx" ON "provider_orders"("provider", "status");
CREATE UNIQUE INDEX "provider_fills_providerFillId_key" ON "provider_fills"("providerFillId");
CREATE INDEX "provider_fills_providerOrderId_occurredAt_idx" ON "provider_fills"("providerOrderId", "occurredAt");
CREATE UNIQUE INDEX "bbook_exposures_marketId_key" ON "bbook_exposures"("marketId");
CREATE UNIQUE INDEX "risk_configs_marketId_key" ON "risk_configs"("marketId");
CREATE UNIQUE INDEX "fee_configs_marketId_key" ON "fee_configs"("marketId");
CREATE UNIQUE INDEX "liquidation_events_ledgerTransactionId_key" ON "liquidation_events"("ledgerTransactionId");
CREATE INDEX "liquidation_events_status_triggeredAt_idx" ON "liquidation_events"("status", "triggeredAt");
CREATE UNIQUE INDEX "deposits_intentId_key" ON "deposits"("intentId");
CREATE UNIQUE INDEX "withdrawals_providerRequestId_key" ON "withdrawals"("providerRequestId");

ALTER TABLE "deposits" ADD CONSTRAINT "deposits_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "deposit_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deposit_intents" ADD CONSTRAINT "deposit_intents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposit_intents" ADD CONSTRAINT "deposit_intents_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposit_intents" ADD CONSTRAINT "deposit_intents_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "custody_balance_snapshots" ADD CONSTRAINT "custody_balance_snapshots_custodyAccountId_fkey" FOREIGN KEY ("custodyAccountId") REFERENCES "custody_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "custody_balance_snapshots" ADD CONSTRAINT "custody_balance_snapshots_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "custody_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_destinationAccountId_fkey" FOREIGN KEY ("destinationAccountId") REFERENCES "custody_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_marginLedgerTransactionId_fkey" FOREIGN KEY ("marginLedgerTransactionId") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trades" ADD CONSTRAINT "trades_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trades" ADD CONSTRAINT "trades_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trades" ADD CONSTRAINT "trades_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "positions" ADD CONSTRAINT "positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "positions" ADD CONSTRAINT "positions_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_orders" ADD CONSTRAINT "provider_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_orders" ADD CONSTRAINT "provider_orders_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_fills" ADD CONSTRAINT "provider_fills_providerOrderId_fkey" FOREIGN KEY ("providerOrderId") REFERENCES "provider_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bbook_exposures" ADD CONSTRAINT "bbook_exposures_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "risk_configs" ADD CONSTRAINT "risk_configs_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fee_configs" ADD CONSTRAINT "fee_configs_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "liquidation_events" ADD CONSTRAINT "liquidation_events_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "liquidation_events" ADD CONSTRAINT "liquidation_events_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "liquidation_events" ADD CONSTRAINT "liquidation_events_ledgerTransactionId_fkey" FOREIGN KEY ("ledgerTransactionId") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
