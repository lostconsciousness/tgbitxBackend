import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(60).default(900),
  JWT_REFRESH_TTL_DAYS: Joi.number().integer().min(1).default(30),
  JWT_ISSUER: Joi.string().default('dream-crypto-exchange'),
  JWT_AUDIENCE: Joi.string().default('dream-crypto-exchange-api'),
  CORS_ORIGINS: Joi.string().default('http://localhost:3000'),
  SIWE_DOMAIN: Joi.string().default('localhost:3000'),
  SIWE_URI: Joi.string().uri({ scheme: ['http', 'https'] }).default('http://localhost:3000'),
  SIWE_ALLOWED_ORIGINS: Joi.string().default('http://localhost:3000'),
  SIWE_CHAIN_ID: Joi.number()
    .integer()
    .valid(
      1, 10, 56, 97, 137, 300, 324, 5000, 5003, 8453, 84532, 42161, 421614,
      42220, 43113, 43114, 44787, 59141, 59144, 80002, 534351, 534352,
      11155111, 11155420,
    )
    .default(421614),
  SIWE_NONCE_TTL_SECONDS: Joi.number().integer().min(60).max(3600).default(600),
  SIWE_NONCE_RETENTION_DAYS: Joi.number().integer().min(1).max(90).default(7),
  RPC_REQUEST_TIMEOUT_MS: Joi.number().integer().min(500).max(30_000).default(5_000),
  RPC_RETRY_ATTEMPTS: Joi.number().integer().min(1).max(10).default(4),
  RPC_RATE_LIMIT_COOLDOWN_MS: Joi.number().integer().min(1_000).max(300_000).default(30_000),
  ONCHAIN_READINESS_CACHE_MS: Joi.number().integer().min(0).max(300_000).default(60_000),
  ONCHAIN_CHAIN_ID: Joi.number()
    .integer()
    .valid(
      1, 10, 56, 97, 137, 300, 324, 5000, 5003, 8453, 84532, 42161, 421614,
      42220, 43113, 43114, 44787, 59141, 59144, 80002, 534351, 534352,
      11155111, 11155420,
    )
    .default(421614),
  MAINNET_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  DISPLAY_MAINNET_ONLY: Joi.boolean().truthy('true').falsy('false').default(false),
  MAINNET_ENABLED_NETWORKS: Joi.string().allow('').default(''),
  DEPOSIT_INTENT_TTL_SECONDS: Joi.number().integer().min(60).max(86_400).default(900),
  DEPOSIT_INDEXER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  DEPOSIT_INDEXER_MAINNET_ONLY: Joi.boolean().truthy('true').falsy('false').default(false),
  ALCHEMY_ADDRESS_ACTIVITY_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  ALCHEMY_WEBHOOK_SIGNING_KEY: Joi.string().allow('').default(''),
  ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON: Joi.string().allow('').default(''),
  ALCHEMY_WEBHOOK_AUTH_TOKEN: Joi.string().allow('').default(''),
  ALCHEMY_WEBHOOK_IDS_JSON: Joi.string().allow('').default(''),
  DEPOSIT_EVM_FALLBACK_SCAN_MS: Joi.number()
    .integer()
    .min(60_000)
    .max(3_600_000)
    .default(300_000),
  DEPOSIT_EVM_BALANCE_RECONCILE_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false),
  DEPOSIT_SWEEP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(100).default(20),
  DEPOSIT_INDEXER_START_BLOCK: Joi.number().integer().min(0).default(0),
  DEPOSIT_INDEXER_MAX_BLOCK_RANGE: Joi.number().integer().min(1).max(10_000).default(250),
  DEPOSIT_INDEXER_RPC_PAUSE_MS: Joi.number().integer().min(0).max(5_000).default(0),
  DEPOSIT_INDEXER_CONTRACT_TIMEOUT_MS: Joi.number().integer().min(5_000).max(120_000).default(20_000),
  TRON_JSON_RPC_URL: Joi.string().uri({ scheme: ['https'] }).default('https://tron-rpc.publicnode.com/jsonrpc'),
  TRON_PUBLIC_FULLNODE_URL: Joi.string().uri({ scheme: ['https'] }).default('https://tron-rpc.publicnode.com'),
  TRON_TRC20_SWEEP_FEE_RESERVE_SUN: Joi.string().pattern(/^\d+$/).default('35000000'),
  TRON_JSON_RPC_SCAN_BLOCKS: Joi.number().integer().min(10).max(128).default(100),
  TRON_JSON_RPC_NATIVE_SCAN_BLOCKS: Joi.number().integer().min(10).max(128).default(60),
  TRON_API_MAX_QPS: Joi.number().integer().min(1).max(8).default(8),
  TRON_API_DAILY_BUDGET: Joi.number().integer().min(1_000).max(80_000).default(80_000),
  TRON_SCAN_TIMESTAMP_OVERLAP_MS: Joi.number().integer().min(0).max(3_600_000).default(60_000),
  DEPOSIT_INDEXER_BALANCE_FALLBACK_ENABLED: Joi.boolean().default(true),
  DEPOSIT_INDEXER_REORG_OVERLAP_BLOCKS: Joi.number().integer().min(1).max(500).default(30),
  DEPOSIT_INDEXER_NATIVE_REORG_OVERLAP_BLOCKS: Joi.number().integer().min(1).max(30).default(2),
  DEPOSIT_PERSONAL_SYNC_LOOKBACK_BLOCKS: Joi.number().integer().min(100).max(500_000).default(5000),
  DEPOSIT_PERSONAL_NATIVE_SYNC_LOOKBACK_BLOCKS: Joi.number().integer().min(1).max(500).default(20),
  DEPOSIT_PERSONAL_SYNC_TIMEOUT_MS: Joi.number().integer().min(1000).max(120_000).default(30_000),
  DEPOSIT_PERSONAL_SYNC_COOLDOWN_MS: Joi.number().integer().min(10_000).max(3_600_000).default(300_000),
  TOKEN_ALLOWLIST_PATH: Joi.string().allow('').default(''),
  MAX_EXTERNAL_WALLETS: Joi.number().integer().min(1).max(20).default(5),
  PRIVY_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  PRIVY_APP_ID: Joi.string().allow('').default(''),
  PRIVY_APP_SECRET: Joi.string().allow('').default(''),
  PRIVY_CLIENT_ID: Joi.string().allow('').default(''),
  PRIVY_API_URL: Joi.string().uri({ scheme: ['https'] }).default('https://api.privy.io/v1'),
  PRIVY_JWT_PRIVATE_KEY_BASE64: Joi.string().allow('').default(''),
  PRIVY_JWT_KEY_ID: Joi.string().default('dream-exchange-privy-1'),
  PRIVY_JWT_ISSUER: Joi.string().default('dream-crypto-exchange'),
  PRIVY_JWT_AUDIENCE: Joi.string().default('privy'),
  PRIVY_JWT_TTL_SECONDS: Joi.number().integer().min(60).max(900).default(300),
  PRIVY_CUSTODY_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  PRIVY_SERVER_WALLET_ID: Joi.string().allow('').default(''),
  PRIVY_SPOT_LIQUIDITY_WALLET_ID: Joi.string().allow('').default(''),
  PRIVY_SPOT_LIQUIDITY_POLICY_ID: Joi.string().allow('').default(''),
  PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: Joi.string().allow('').default(''),
  PRIVY_AUTHORIZATION_PUBLIC_KEY: Joi.string().allow('').default(''),
  PRIVY_ENV_AUTHORIZATION_MAINNET_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  PRIVY_PRODUCTION_SIGNING_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  PRIVY_SOLANA_WALLET_ID: Joi.string().allow('').default(''),
  PRIVY_SOLANA_POLICY_ID: Joi.string().allow('').default(''),
  SOLANA_SWEEP_FEE_RESERVE_LAMPORTS: Joi.string().pattern(/^\d+$/).default('10000'),
  PRIVY_TRON_WALLET_ID: Joi.string().allow('').default(''),
  PRIVY_TRON_POLICY_ID: Joi.string().allow('').default(''),
  PRIVY_TRON_RESERVE_POLICY_ID: Joi.string().allow('').default(''),
  TRON_SWEEP_FEE_RESERVE_SUN: Joi.string().pattern(/^\d+$/).default('1000000'),
  TRON_PRO_API_KEY: Joi.string().allow('').default(''),
  TRON_NILE_PRO_API_KEY: Joi.string().allow('').default(''),
  TRON_GRID_FALLBACK_URL: Joi.string().allow('').uri({ scheme: ['https'] }).default(''),
  TRON_NILE_GRID_FALLBACK_URL: Joi.string().allow('').uri({ scheme: ['https'] }).default(''),
  PRIVY_WEBHOOK_SIGNING_SECRET: Joi.string().allow('').default(''),
  PRIVY_DEPOSIT_SWEEP_POLICY_ID: Joi.string().allow('').default(''),
  PRIVY_SWEEP_GAS_WALLET_ID: Joi.string().allow('').default(''),
  PRIVY_SWEEP_GAS_POLICY_ID: Joi.string().allow('').default(''),
  PRIVY_HYPERLIQUID_MASTER_WALLET_ID: Joi.string().allow('').default(''),
  PRIVY_HYPERLIQUID_MASTER_POLICY_ID: Joi.string().allow('').default(''),
  PRIVY_HYPERLIQUID_AGENT_WALLET_ID: Joi.string().allow('').default(''),
  PRIVY_HYPERLIQUID_AGENT_ADDRESS: Joi.string().allow('').default(''),
  PRIVY_HYPERLIQUID_AGENT_POLICY_ID: Joi.string().allow('').default(''),
  PRIVY_PLATFORM_CAPITAL_WALLET_ID: Joi.string().allow('').default(''),
  PRIVY_PLATFORM_CAPITAL_POLICY_ID: Joi.string().allow('').default(''),
  PRIVY_INSURANCE_WALLET_ID: Joi.string().allow('').default(''),
  PRIVY_INSURANCE_POLICY_ID: Joi.string().allow('').default(''),
  ARBITRUM_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  ARBITRUM_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  ETHEREUM_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  ETHEREUM_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  ETHEREUM_SEPOLIA_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  ETHEREUM_SEPOLIA_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  BASE_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  BASE_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  BASE_SEPOLIA_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  BASE_SEPOLIA_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  OPTIMISM_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  OPTIMISM_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  OPTIMISM_SEPOLIA_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  OPTIMISM_SEPOLIA_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  POLYGON_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  POLYGON_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  POLYGON_AMOY_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  POLYGON_AMOY_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  BNB_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  BNB_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  BNB_TESTNET_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  BNB_TESTNET_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  AVALANCHE_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  AVALANCHE_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  AVALANCHE_FUJI_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  AVALANCHE_FUJI_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  ZKSYNC_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  ZKSYNC_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  ZKSYNC_SEPOLIA_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  ZKSYNC_SEPOLIA_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  LINEA_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  LINEA_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  LINEA_SEPOLIA_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  LINEA_SEPOLIA_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  SCROLL_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  SCROLL_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  SCROLL_SEPOLIA_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  SCROLL_SEPOLIA_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  MANTLE_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  MANTLE_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  MANTLE_SEPOLIA_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  MANTLE_SEPOLIA_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  CELO_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  CELO_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  CELO_ALFAJORES_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  CELO_ALFAJORES_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  SOLANA_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  SOLANA_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  SOLANA_DEVNET_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  SOLANA_DEVNET_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  BITCOIN_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  BITCOIN_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  BITCOIN_EXPLORER_URL: Joi.string().allow('').default(''),
  BITCOIN_SIGNET_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  BITCOIN_SIGNET_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  BITCOIN_SIGNET_EXPLORER_URL: Joi.string().allow('').default(''),
  TRON_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  TRON_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  TRON_NILE_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  TRON_NILE_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  TRON_SHASTA_RPC_PRIMARY_URL: Joi.string().allow('').default(''),
  TRON_SHASTA_RPC_FALLBACK_URL: Joi.string().allow('').default(''),
  ARBITRUM_DEPOSIT_ADDRESS: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .default('0x0000000000000000000000000000000000000000'),
  DEPOSIT_TREASURY_ADDRESS: Joi.string().allow('').default(''),
  WITHDRAWAL_HOT_ADDRESS: Joi.string().allow('').default(''),
  SAFE_RESERVE_ADDRESS: Joi.string().allow('').default(''),
  HYPERLIQUID_MASTER_ADDRESS: Joi.string().allow('').default(''),
  PLATFORM_CAPITAL_ADDRESS: Joi.string().allow('').default(''),
  INSURANCE_ADDRESS: Joi.string().allow('').default(''),
  SWEEP_GAS_ADDRESS: Joi.string().allow('').default(''),
  SOLANA_WITHDRAWAL_HOT_ADDRESS: Joi.string().allow('').default(''),
  SOLANA_DEVNET_WITHDRAWAL_HOT_ADDRESS: Joi.string().allow('').default(''),
  BITCOIN_WITHDRAWAL_HOT_ADDRESS: Joi.string().allow('').default(''),
  BITCOIN_SIGNET_WITHDRAWAL_HOT_ADDRESS: Joi.string().allow('').default(''),
  TRON_WITHDRAWAL_HOT_ADDRESS: Joi.string().allow('').default(''),
  TRON_NILE_WITHDRAWAL_HOT_ADDRESS: Joi.string().allow('').default(''),
  TRON_SHASTA_WITHDRAWAL_HOT_ADDRESS: Joi.string().allow('').default(''),
  PRIVY_DEPOSIT_TREASURY_WALLET_ID: Joi.string().allow('').default(''),
  ARBITRUM_SEPOLIA_USDC_ADDRESS: Joi.string().allow('').default(''),
  ARBITRUM_SEPOLIA_USDT_ADDRESS: Joi.string().allow('').default(''),
  ARBITRUM_SEPOLIA_WETH_ADDRESS: Joi.string().allow('').default(''),
  ARBITRUM_SEPOLIA_WBTC_ADDRESS: Joi.string().allow('').default(''),
  ARBITRUM_SEPOLIA_ARB_ADDRESS: Joi.string().allow('').default(''),
  MOCK_USDC_ARBITRUM_SEPOLIA_ADDRESS: Joi.string().allow('').default(''),
  MOCK_USDC_ETHEREUM_SEPOLIA_ADDRESS: Joi.string().allow('').default(''),
  MOCK_USDC_BASE_SEPOLIA_ADDRESS: Joi.string().allow('').default(''),
  MOCK_USDC_OPTIMISM_SEPOLIA_ADDRESS: Joi.string().allow('').default(''),
  MOCK_USDC_POLYGON_AMOY_ADDRESS: Joi.string().allow('').default(''),
  MOCK_USDC_BNB_TESTNET_ADDRESS: Joi.string().allow('').default(''),
  MOCK_USDC_AVALANCHE_FUJI_ADDRESS: Joi.string().allow('').default(''),
  TRON_NILE_USDT_TRC20_ADDRESS: Joi.string().allow('').default(''),
  SOLANA_WITHDRAWAL_PRIVATE_KEY: Joi.string().allow('').default(''),
  SOLANA_DEVNET_WITHDRAWAL_PRIVATE_KEY: Joi.string().allow('').default(''),
  BITCOIN_WITHDRAWAL_WIF: Joi.string().allow('').default(''),
  BITCOIN_WITHDRAWAL_FEE_SATS: Joi.string().pattern(/^\d+$/).default('1000'),
  BITCOIN_RBF_FEE_STEP_SATS: Joi.string().pattern(/^\d+$/).default('1000'),
  BITCOIN_SIGNET_WITHDRAWAL_WIF: Joi.string().allow('').default(''),
  BITCOIN_SIGNET_WITHDRAWAL_FEE_SATS: Joi.string().pattern(/^\d+$/).default('1000'),
  BITCOIN_SIGNET_RBF_FEE_STEP_SATS: Joi.string().pattern(/^\d+$/).default('1000'),
  TRON_WITHDRAWAL_PRIVATE_KEY: Joi.string().allow('').default(''),
  TRON_TRC20_FEE_LIMIT_SUN: Joi.string().pattern(/^\d+$/).default('150000000'),
  TRON_NILE_WITHDRAWAL_PRIVATE_KEY: Joi.string().allow('').default(''),
  TRON_NILE_TRC20_FEE_LIMIT_SUN: Joi.string().pattern(/^\d+$/).default('150000000'),
  DEPOSIT_CONFIRMATIONS: Joi.number().integer().min(1).default(12),
  DEPOSIT_SWEEP_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  SWEEP_GAS_TOPUP_WEI: Joi.string().pattern(/^\d+$/).default('0'),
  SWEEP_GAS_MAX_TOPUP_WEI: Joi.string().pattern(/^\d+$/).default('0'),
  DEPOSIT_ADDRESS_SCAN_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(100),
  WITHDRAWALS_PAUSED: Joi.boolean().truthy('true').falsy('false').default(false),
  WITHDRAWAL_WORKER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  WITHDRAWAL_DAILY_LIMIT: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('10000'),
  WITHDRAWAL_MANUAL_APPROVAL_THRESHOLD: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('1000'),
  WITHDRAWAL_NEW_ADDRESS_COOLDOWN_SECONDS: Joi.number().integer().min(0).default(0),
  WITHDRAWAL_CONFIRMATIONS: Joi.number().integer().min(1).default(12),
  WITHDRAWAL_FUNDING_WAIT_MS: Joi.number().integer().min(1_000).default(15_000),
  WITHDRAWAL_BROADCAST_TIMEOUT_MS: Joi.number().integer().min(5_000).default(45_000),
  WITHDRAWAL_BROADCAST_INTERRUPT_GRACE_MS: Joi.number().integer().min(3_000).default(12_000),
  WITHDRAWAL_NATIVE_GAS_RESERVE: Joi.string()
    .pattern(/^\d+(?:\.\d+)?$/)
    .default('0.00015'),
  TREASURY_REBALANCE_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  TREASURY_REBALANCE_ASSET_SYMBOL: Joi.string().allow('').default('USDC'),
  TREASURY_REBALANCE_HOT_MIN_AMOUNT: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0'),
  TREASURY_REBALANCE_HOT_TARGET_AMOUNT: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0'),
  TREASURY_REBALANCE_MAX_SINGLE_AMOUNT: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0'),
  TREASURY_REBALANCE_HOT_PERCENT: Joi.number().min(0).max(100).default(0),
  TREASURY_REBALANCE_MAINNET_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  HYPERLIQUID_INFO_URL: Joi.string().uri({ scheme: ['https'] }).default('https://api.hyperliquid.xyz/info'),
  HYPERLIQUID_WS_URL: Joi.string().uri({ scheme: ['wss'] }).default('wss://api.hyperliquid.xyz/ws'),
  HYPERLIQUID_TESTNET: Joi.boolean().truthy('true').falsy('false').default(true),
  HYPERLIQUID_EXECUTION_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  HYPERLIQUID_MIN_ACCOUNT_VALUE_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('25'),
  HYPERLIQUID_MIN_WITHDRAWABLE_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('5'),
  PERP_MIN_ORDER_NOTIONAL_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0'),
  PERP_MAX_ORDER_NOTIONAL_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('100'),
  PERP_MAX_LEVERAGE: Joi.number().integer().min(1).max(100).default(10),
  PROVIDER_RECONCILIATION_INTERVAL_MS: Joi.number().integer().min(1000).max(60000).default(5000),
  PROVIDER_RECONCILIATION_UNKNOWN_GRACE_MS: Joi.number().integer().min(30000).max(3600000).default(300000),
  PROVIDER_RECONCILIATION_MAX_ATTEMPTS: Joi.number().integer().min(1).max(100).default(20),
  PROVIDER_RECONCILIATION_MANUAL_RECHECK_MS: Joi.number().integer().min(60_000).max(3_600_000).default(300_000),
  HYPERLIQUID_RETRY_ATTEMPTS: Joi.number().integer().min(1).max(5).default(3),
  HYPERLIQUID_RETRY_BASE_DELAY_MS: Joi.number().integer().min(50).max(5_000).default(250),
  HYPERLIQUID_RETRY_MAX_DELAY_MS: Joi.number().integer().min(100).max(30_000).default(3_000),
  HYPERLIQUID_CIRCUIT_FAILURE_THRESHOLD: Joi.number().integer().min(2).max(50).default(5),
  HYPERLIQUID_CIRCUIT_COOLDOWN_MS: Joi.number().integer().min(1_000).max(300_000).default(15_000),
  HYPERLIQUID_MARKET_DATA_BACKOFF_BASE_MS: Joi.number().integer().min(250).max(10_000).default(1_000),
  HYPERLIQUID_MARKET_DATA_BACKOFF_MAX_MS: Joi.number().integer().min(1_000).max(300_000).default(30_000),
  ACCOUNT_OVERVIEW_CACHE_MS: Joi.number().integer().min(0).max(60_000).default(5_000),
  CONNECTED_WALLET_BALANCE_CACHE_MS: Joi.number().integer().min(1_000).max(300_000).default(120_000),
  CONNECTED_WALLET_NETWORK_KEYS: Joi.string().allow('').default(''),
  PRIVATE_WS_FALLBACK_SNAPSHOT_MS: Joi.number().integer().min(10_000).max(300_000).default(30_000),
  PRIVATE_WS_EVENT_DEBOUNCE_MS: Joi.number().integer().min(0).max(1_000).default(25),
  MARKET_DATA_PROVIDER: Joi.string().valid('MOCK', 'HYPERLIQUID').default('MOCK'),
  MARKET_DATA_FALLBACK_TO_MOCK: Joi.boolean().truthy('true').falsy('false').default(true),
  ONEINCH_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  ONEINCH_API_KEY: Joi.string().allow('').default(''),
  ONEINCH_BASE_URL: Joi.string().uri({ scheme: ['https'] }).default('https://api.1inch.com/swap/v6.1'),
  ONEINCH_CHAIN_ID: Joi.number().integer().min(1).default(42161),
  ONEINCH_MIN_REQUEST_INTERVAL_MS: Joi.number().integer().min(1000).max(10000).default(1100),
  ONEINCH_MAX_RETRIES: Joi.number().integer().min(0).max(5).default(2),
  ONEINCH_SPENDER_CACHE_MS: Joi.number().integer().min(1000).max(3600000).default(300000),
  ONEINCH_PRICE_CACHE_MS: Joi.number().integer().min(1000).max(300000).default(5000),
  CONVERT_SPOT_TICKER_CACHE_MS: Joi.number().integer().min(1000).max(300000).default(15000),
  CONVERT_ORDERBOOK_CACHE_MS: Joi.number().integer().min(5000).max(300000).default(30000),
  CONVERT_ORDERBOOK_STREAM_MS: Joi.number().integer().min(1000).max(60000).default(5000),
  CONVERT_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  CONVERT_EVM_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  CONVERT_SPOT_NETWORKS: Joi.string().default(
    'arbitrum,bnb,base,optimism,ethereum',
  ),
  CONVERT_SPOT_CATALOG_CACHE_MS: Joi.number().integer().min(1000).max(300000).default(60000),
  CONVERT_READINESS_CACHE_MS: Joi.number().integer().min(1000).max(300000).default(120000),
  CONVERT_SPOT_CATALOG_MIN_STABLE_BALANCE: Joi.string()
    .pattern(/^\d+(?:\.\d+)?$/)
    .default('100'),
  CONVERT_EVM_NETWORKS: Joi.string().allow('').default('arbitrum,bnb,base,optimism,ethereum'),
  CONVERT_EVM_GAS_RESERVE: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0.00015'),
  CONVERT_SPOT_GAS_RESERVE_ETHEREUM: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0.02'),
  CONVERT_SPOT_GAS_RESERVE_BNB: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0.02'),
  CONVERT_SPOT_GAS_RESERVE_ARBITRUM: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0.005'),
  CONVERT_SPOT_GAS_RESERVE_BASE: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0.005'),
  CONVERT_SPOT_GAS_RESERVE_OPTIMISM: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0.005'),
  CONVERT_SOL_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  CONVERT_TRON_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  CONVERT_FEE_BPS: Joi.number().integer().min(0).max(300).default(20),
  CONVERT_DEFAULT_SLIPPAGE_BPS: Joi.number().integer().min(1).max(100).default(50),
  CONVERT_MAX_SLIPPAGE_BPS: Joi.number().integer().min(1).max(100).default(100),
  CONVERT_QUOTE_TTL_SECONDS: Joi.number().integer().min(5).max(60).default(20),
  CONVERT_MAX_ORDER_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('100'),
  CONVERT_DAILY_LIMIT_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('1000'),
  CONVERT_RESERVE_COVERAGE_BPS: Joi.number().integer().min(10000).max(20000).default(11000),
  TRADING_PAUSED: Joi.boolean().truthy('true').falsy('false').default(false),
  ABOOK_RECONCILIATION_PAUSED: Joi.boolean().truthy('true').falsy('false').default(false),
  BBOOK_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  BBOOK_PAUSED: Joi.boolean().truthy('true').falsy('false').default(false),
  PLATFORM_CAPITAL_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0'),
  INSURANCE_CAPITAL_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('0'),
  BBOOK_MIN_PLATFORM_CAPITAL_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('500'),
  BBOOK_MIN_INSURANCE_CAPITAL_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('100'),
  BBOOK_MAX_ORDER_CAPITAL_PCT: Joi.string().pattern(/^0(?:\.\d+)?$/).default('0.025'),
  BBOOK_MAX_MARKET_EXPOSURE_PCT: Joi.string().pattern(/^0(?:\.\d+)?$/).default('0.10'),
  BBOOK_MAX_TOTAL_EXPOSURE_PCT: Joi.string().pattern(/^0(?:\.\d+)?$/).default('0.25'),
  BBOOK_MAX_UNREALIZED_LOSS_PCT: Joi.string().pattern(/^0(?:\.\d+)?$/).default('0.10'),
  BBOOK_MAX_SPREAD_BPS: Joi.number().integer().min(1).max(500).default(50),
  BBOOK_MIN_NOTIONAL_24H_USDC: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('1000000'),
  BBOOK_MAX_MARK_DEVIATION_BPS: Joi.number().integer().min(1).max(1000).default(100),
  BBOOK_MIN_DEPTH_MULTIPLIER: Joi.string().pattern(/^\d+(?:\.\d+)?$/).default('5'),
  BBOOK_DEPTH_BPS: Joi.number().integer().min(1).max(500).default(30),
  BBOOK_AUTO_PAUSE_DRAWDOWN_PCT: Joi.string().pattern(/^0(?:\.\d+)?$/).default('0.15'),
  ORDERBOOK_MAX_LEVELS: Joi.number().integer().min(1).max(100).default(25),
}).custom((value, helpers) => {
  if (value.NODE_ENV === 'production') {
    if (value.MARKET_DATA_PROVIDER === 'MOCK') {
      return helpers.error('any.invalid', {
        message: 'MARKET_DATA_PROVIDER=MOCK is not allowed in production',
      });
    }
    if (value.MARKET_DATA_FALLBACK_TO_MOCK === true) {
      return helpers.error('any.invalid', {
        message: 'MARKET_DATA_FALLBACK_TO_MOCK=true is not allowed in production',
      });
    }
  }
  if (value.ONEINCH_ENABLED === true && !value.ONEINCH_API_KEY) {
    return helpers.error('any.invalid', {
      message: 'ONEINCH_API_KEY is required when ONEINCH_ENABLED=true',
    });
  }
  if (
    value.ALCHEMY_ADDRESS_ACTIVITY_ENABLED === true &&
    !value.ALCHEMY_WEBHOOK_SIGNING_KEY &&
    !value.ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON
  ) {
    return helpers.error('any.invalid', {
      message:
        'ALCHEMY_WEBHOOK_SIGNING_KEY or ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON is required when ALCHEMY_ADDRESS_ACTIVITY_ENABLED=true',
    });
  }
  if (value.ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON) {
    try {
      const keys = JSON.parse(value.ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON) as Record<string, unknown>;
      if (
        !keys ||
        Array.isArray(keys) ||
        Object.keys(keys).length === 0 ||
        Object.values(keys).some((key) => typeof key !== 'string' || key.length === 0)
      ) {
        return helpers.error('any.invalid', {
          message: 'ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON must map webhook IDs to signing keys',
        });
      }
    } catch (_error) {
      return helpers.error('any.invalid', {
        message: 'ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON must contain valid JSON',
      });
    }
  }
  if (value.ALCHEMY_WEBHOOK_IDS_JSON) {
    try {
      const ids = JSON.parse(value.ALCHEMY_WEBHOOK_IDS_JSON) as Record<string, unknown>;
      const supported = ['ethereum', 'arbitrum', 'base', 'optimism', 'bnb'];
      if (
        !ids ||
        Array.isArray(ids) ||
        Object.keys(ids).length === 0 ||
        Object.entries(ids).some(
          ([network, id]) =>
            !supported.includes(network) ||
            typeof id !== 'string' ||
            !id.startsWith('wh_'),
        )
      ) {
        return helpers.error('any.invalid', {
          message:
            'ALCHEMY_WEBHOOK_IDS_JSON must map supported EVM network keys to webhook IDs',
        });
      }
    } catch (_error) {
      return helpers.error('any.invalid', {
        message: 'ALCHEMY_WEBHOOK_IDS_JSON must contain valid JSON',
      });
    }
  }
  if (
    value.NODE_ENV === 'production' &&
    value.ALCHEMY_ADDRESS_ACTIVITY_ENABLED === true &&
    (!value.ALCHEMY_WEBHOOK_AUTH_TOKEN || !value.ALCHEMY_WEBHOOK_IDS_JSON)
  ) {
    return helpers.error('any.invalid', {
      message:
        'ALCHEMY_WEBHOOK_AUTH_TOKEN and ALCHEMY_WEBHOOK_IDS_JSON are required for production webhook address synchronization',
    });
  }
  if (value.CONVERT_EVM_ENABLED === true && value.ONEINCH_ENABLED !== true) {
    return helpers.error('any.invalid', {
      message: 'ONEINCH_ENABLED=true is required when CONVERT_EVM_ENABLED=true',
    });
  }
  if (
    Number(value.PERP_MIN_ORDER_NOTIONAL_USDC) >
    Number(value.PERP_MAX_ORDER_NOTIONAL_USDC)
  ) {
    return helpers.error('any.invalid', {
      message: 'PERP_MIN_ORDER_NOTIONAL_USDC must not exceed PERP_MAX_ORDER_NOTIONAL_USDC',
    });
  }
  if (value.HYPERLIQUID_EXECUTION_ENABLED === true) {
    const required = [
      'PRIVY_APP_ID',
      'PRIVY_APP_SECRET',
      'PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64',
      'PRIVY_HYPERLIQUID_MASTER_WALLET_ID',
      'PRIVY_HYPERLIQUID_AGENT_WALLET_ID',
      'PRIVY_HYPERLIQUID_AGENT_ADDRESS',
      'HYPERLIQUID_MASTER_ADDRESS',
    ];
    const missing = required.filter((key) => !value[key]);
    if (missing.length > 0) {
      return helpers.error('any.invalid', {
        message: `${missing.join(', ')} required when HYPERLIQUID_EXECUTION_ENABLED=true`,
      });
    }
    if (
      value.MAINNET_ENABLED !== true ||
      value.HYPERLIQUID_TESTNET !== false ||
      value.MARKET_DATA_PROVIDER !== 'HYPERLIQUID' ||
      value.MARKET_DATA_FALLBACK_TO_MOCK !== false
    ) {
      return helpers.error('any.invalid', {
        message: 'Hyperliquid mainnet execution requires MAINNET_ENABLED=true, HYPERLIQUID_TESTNET=false, MARKET_DATA_PROVIDER=HYPERLIQUID and MARKET_DATA_FALLBACK_TO_MOCK=false',
      });
    }
  }
  return value;
});
