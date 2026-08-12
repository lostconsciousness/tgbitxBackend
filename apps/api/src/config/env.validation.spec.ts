import { envValidationSchema } from './env.validation';

describe('envValidationSchema', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://dream_exchange:dream_exchange@localhost:5432/dream_exchange',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
  };

  it('rejects mock market data in production', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      NODE_ENV: 'production',
      MARKET_DATA_PROVIDER: 'MOCK',
      MARKET_DATA_FALLBACK_TO_MOCK: false,
    });

    expect(result.error).toBeDefined();
  });

  it('rejects mock fallback in production', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      NODE_ENV: 'production',
      MARKET_DATA_PROVIDER: 'HYPERLIQUID',
      MARKET_DATA_FALLBACK_TO_MOCK: true,
    });

    expect(result.error).toBeDefined();
  });

  it('requires one inch api key when enabled', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      ONEINCH_ENABLED: true,
      ONEINCH_API_KEY: '',
    });

    expect(result.error).toBeDefined();
  });

  it('requires a signing key when Alchemy address activity is enabled', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      ALCHEMY_ADDRESS_ACTIVITY_ENABLED: true,
    });

    expect(result.error).toBeDefined();
  });

  it('accepts a per-webhook Alchemy signing key map', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      ALCHEMY_ADDRESS_ACTIVITY_ENABLED: true,
      ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON: JSON.stringify({ wh_arbitrum: 'secret' }),
    });

    expect(result.error).toBeUndefined();
    expect(result.value.DEPOSIT_EVM_FALLBACK_SCAN_MS).toBe(300_000);
    expect(result.value.DEPOSIT_EVM_BALANCE_RECONCILE_ENABLED).toBe(false);
  });

  it('requires webhook management credentials for event-driven deposits in production', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      NODE_ENV: 'production',
      MARKET_DATA_PROVIDER: 'HYPERLIQUID',
      MARKET_DATA_FALLBACK_TO_MOCK: false,
      ALCHEMY_ADDRESS_ACTIVITY_ENABLED: true,
      ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON: JSON.stringify({ wh_arbitrum: 'secret' }),
    });

    expect(result.error).toBeDefined();
  });

  it('accepts complete production webhook configuration', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      NODE_ENV: 'production',
      MARKET_DATA_PROVIDER: 'HYPERLIQUID',
      MARKET_DATA_FALLBACK_TO_MOCK: false,
      ALCHEMY_ADDRESS_ACTIVITY_ENABLED: true,
      ALCHEMY_WEBHOOK_SIGNING_KEYS_JSON: JSON.stringify({ wh_arbitrum: 'secret' }),
      ALCHEMY_WEBHOOK_AUTH_TOKEN: 'notify-auth-token',
      ALCHEMY_WEBHOOK_IDS_JSON: JSON.stringify({ arbitrum: 'wh_arbitrum' }),
    });

    expect(result.error).toBeUndefined();
  });

  it('allows an empty treasury asset list for per-network auto discovery', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      TREASURY_REBALANCE_ASSET_SYMBOL: '',
    });

    expect(result.error).toBeUndefined();
    expect(result.value.TREASURY_REBALANCE_ASSET_SYMBOL).toBe('');
  });

  it('rejects a treasury hot-wallet percentage above 100', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      TREASURY_REBALANCE_HOT_PERCENT: 101,
    });

    expect(result.error).toBeDefined();
  });

  it('rejects Hyperliquid execution unless every mainnet safety flag is set', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      HYPERLIQUID_EXECUTION_ENABLED: true,
      PRIVY_APP_ID: 'app-id',
      PRIVY_APP_SECRET: 'app-secret',
      PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:key',
      PRIVY_HYPERLIQUID_MASTER_WALLET_ID: 'master-id',
      PRIVY_HYPERLIQUID_AGENT_WALLET_ID: 'agent-id',
      PRIVY_HYPERLIQUID_AGENT_ADDRESS: `0x${'1'.repeat(40)}`,
      HYPERLIQUID_MASTER_ADDRESS: `0x${'2'.repeat(40)}`,
      MAINNET_ENABLED: false,
      HYPERLIQUID_TESTNET: false,
      MARKET_DATA_PROVIDER: 'HYPERLIQUID',
      MARKET_DATA_FALLBACK_TO_MOCK: false,
    });
    expect(result.error).toBeDefined();
  });

  it('accepts the complete Hyperliquid mainnet execution configuration', () => {
    const result = envValidationSchema.validate({
      ...baseEnv,
      HYPERLIQUID_EXECUTION_ENABLED: true,
      PRIVY_APP_ID: 'app-id',
      PRIVY_APP_SECRET: 'app-secret',
      PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:key',
      PRIVY_HYPERLIQUID_MASTER_WALLET_ID: 'master-id',
      PRIVY_HYPERLIQUID_AGENT_WALLET_ID: 'agent-id',
      PRIVY_HYPERLIQUID_AGENT_ADDRESS: `0x${'1'.repeat(40)}`,
      HYPERLIQUID_MASTER_ADDRESS: `0x${'2'.repeat(40)}`,
      MAINNET_ENABLED: true,
      HYPERLIQUID_TESTNET: false,
      MARKET_DATA_PROVIDER: 'HYPERLIQUID',
      MARKET_DATA_FALLBACK_TO_MOCK: false,
    });
    expect(result.error).toBeUndefined();
  });
});
