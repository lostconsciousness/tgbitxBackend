import { ConfigService } from '@nestjs/config';
import { PrivyCustodyService } from '../treasury/privy-custody.service';
import { HyperliquidExecutionService } from './hyperliquid-execution.service';

jest.mock('./hyperliquid-order-format', () => ({
  formatHyperliquidPrice: (price: string) => price,
  formatHyperliquidSize: (size: string) => size,
}));

describe('HyperliquidExecutionService readiness', () => {
  const master = `0x${'1'.repeat(40)}`;
  const agent = `0x${'2'.repeat(40)}`;

  function createService(extraAgents: Array<{ address: string; validUntil: number | null }>) {
    const values: Record<string, unknown> = {
      HYPERLIQUID_EXECUTION_ENABLED: true,
      PRIVY_APP_ID: 'app-id',
      PRIVY_APP_SECRET: 'app-secret',
      PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:key',
      PRIVY_HYPERLIQUID_MASTER_WALLET_ID: 'master-id',
      PRIVY_HYPERLIQUID_AGENT_WALLET_ID: 'agent-id',
      PRIVY_HYPERLIQUID_AGENT_ADDRESS: agent,
      HYPERLIQUID_MASTER_ADDRESS: master,
      MAINNET_ENABLED: true,
      HYPERLIQUID_TESTNET: false,
      MARKET_DATA_PROVIDER: 'HYPERLIQUID',
      MARKET_DATA_FALLBACK_TO_MOCK: false,
      HYPERLIQUID_MIN_ACCOUNT_VALUE_USDC: '25',
      HYPERLIQUID_MIN_WITHDRAWABLE_USDC: '5',
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
      getOrThrow: jest.fn((key: string) => {
        if (values[key] === undefined) throw new Error(`${key} missing`);
        return values[key];
      }),
    };
    const custody = {
      getWalletAddress: jest.fn((walletId: string) =>
        Promise.resolve(walletId === 'master-id' ? master : agent)),
    };
    const service = new HyperliquidExecutionService(
      config as unknown as ConfigService,
      custody as unknown as PrivyCustodyService,
    );
    jest.spyOn(service as never, 'createClients' as never).mockResolvedValue({
      info: {
        extraAgents: jest.fn().mockResolvedValue(extraAgents),
        clearinghouseState: jest.fn().mockResolvedValue({
          marginSummary: { accountValue: '25' },
          withdrawable: '5',
        }),
      },
    } as never);
    return service;
  }

  it('is ready only when the configured agent is registered for the master', async () => {
    const service = createService([{ address: agent, validUntil: null }]);
    await expect(service.getReadiness()).resolves.toMatchObject({
      ready: true,
      reasons: [],
      accountValue: '25',
      withdrawable: '5',
      agentRegistered: true,
    });
  });

  it('returns a safe reason when agent registration is missing', async () => {
    const service = createService([]);
    await expect(service.getReadiness()).resolves.toMatchObject({
      ready: false,
      reasons: ['AGENT_NOT_REGISTERED'],
      agentRegistered: false,
    });
  });

  it('blocks new risk when account value exists but withdrawable collateral is zero', async () => {
    const service = createService([{ address: agent, validUntil: null }]);
    const clients = await (service as unknown as { createClients: () => Promise<{
      info: { clearinghouseState: jest.Mock };
    }> }).createClients();
    clients.info.clearinghouseState.mockResolvedValue({
      marginSummary: { accountValue: '34' },
      withdrawable: '0',
    });

    await expect(service.getReadiness()).resolves.toMatchObject({
      ready: false,
      reasons: ['COLLATERAL_INSUFFICIENT'],
      accountValue: '34',
      withdrawable: '0',
    });
  });
});
