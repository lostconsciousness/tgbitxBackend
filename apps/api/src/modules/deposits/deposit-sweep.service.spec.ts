import { ConfigService } from '@nestjs/config';
import {
  Chain,
  CustodyProvider,
  DepositSweepStatus,
  TokenStandard,
} from '@prisma/client';
import { DepositSweepService } from './deposit-sweep.service';

describe('DepositSweepService TRON reads', () => {
  afterEach(() => jest.restoreAllMocks());

  it('falls back from a rejected primary RPC to TronGrid for TRC20 balances', async () => {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          TRON_RPC_PRIMARY_URL: 'https://primary.invalid',
          TRON_PRO_API_KEY: '',
        };
        return values[key] ?? fallback;
      }),
    } as unknown as ConfigService;
    const fetchMock = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ trc20: [{ TToken: '100000000' }] }] }),
      } as Response);
    const service = new DepositSweepService(
      {} as any,
      config,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      (service as any).getTronTrc20BalanceRaw('TUser', 'TToken'),
    ).resolves.toBe(100000000n);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('api.trongrid.io');
  });

  it('accepts a confirmed native TRX receipt without receipt.result', async () => {
    const service = new DepositSweepService(
      {} as any,
      { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service as any, 'tronApiRequest').mockResolvedValue({
      id: 'native-tx',
      blockNumber: 123,
      receipt: { net_usage: 267 },
    });

    await expect((service as any).confirmTronSweepTransaction('native-tx')).resolves.toEqual({
      success: true,
      failed: false,
    });
  });

  it('rejects an explicit failed Tron receipt', async () => {
    const service = new DepositSweepService(
      {} as any,
      { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service as any, 'tronApiRequest').mockResolvedValue({
      id: 'failed-tx',
      receipt: { result: 'OUT_OF_ENERGY' },
    });

    await expect((service as any).confirmTronSweepTransaction('failed-tx')).resolves.toEqual({
      success: false,
      failed: true,
    });
  });

  it('aligns the TRC20 fee limit with the funded TRX reserve', async () => {
    const update = jest.fn()
      .mockResolvedValueOnce({ attempts: 1 })
      .mockResolvedValueOnce({});
    const custody = {
      isTronEnabled: jest.fn().mockReturnValue(true),
      getWalletAddress: jest.fn().mockResolvedValue('TTreasury'),
      sendTronTrc20Transfer: jest.fn().mockResolvedValue({ txHash: 'sweep-tx' }),
    };
    const config = {
      getOrThrow: jest.fn().mockReturnValue('treasury-wallet'),
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'TRON_TRC20_SWEEP_FEE_RESERVE_SUN') return '35000000';
        return fallback;
      }),
    } as unknown as ConfigService;
    const service = new DepositSweepService(
      { depositSweep: { update } } as any,
      config,
      custody as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service as any, 'getSweepTarget').mockResolvedValue({
      tokenContract: {
        standard: TokenStandard.TRC20,
        address: 'TUsdtContract',
        decimals: 6,
      },
    });
    jest.spyOn(service as any, 'getTronTrc20BalanceRaw').mockResolvedValue(50_000_000n);
    jest.spyOn(service as any, 'getTronNativeBalanceSun').mockResolvedValue(35_000_000n);

    await (service as any).processTronSweep({
      id: 'sweep-1',
      status: DepositSweepStatus.PENDING,
      rawAmount: '50000000',
      txHash: null,
      gasFundingTxHash: null,
      assetId: 'asset-usdt',
      depositAddress: {
        address: 'TDeposit',
        network: Chain.TRON,
        provider: CustodyProvider.PRIVY,
        providerWalletRef: 'deposit-wallet',
      },
    });

    expect(custody.sendTronTrc20Transfer).toHaveBeenCalledWith(
      expect.objectContaining({ feeLimitSun: 35_000_000 }),
    );
  });

  it('returns a pre-broadcast Tron failure to pending for a safe retry', async () => {
    const update = jest.fn()
      .mockResolvedValueOnce({ attempts: 1 })
      .mockResolvedValueOnce({});
    const custody = {
      isTronEnabled: jest.fn().mockReturnValue(true),
      getWalletAddress: jest.fn().mockResolvedValue('TTreasury'),
      sendTronTrc20Transfer: jest.fn().mockRejectedValue(new Error('policy violation')),
    };
    const service = new DepositSweepService(
      { depositSweep: { update } } as any,
      {
        getOrThrow: jest.fn().mockReturnValue('treasury-wallet'),
        get: jest.fn((_key: string, fallback?: unknown) => fallback),
      } as unknown as ConfigService,
      custody as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service as any, 'getSweepTarget').mockResolvedValue({
      tokenContract: {
        standard: TokenStandard.TRC20,
        address: 'TUsdtContract',
        decimals: 6,
      },
    });
    jest.spyOn(service as any, 'getTronTrc20BalanceRaw').mockResolvedValue(50_000_000n);
    jest.spyOn(service as any, 'getTronNativeBalanceSun').mockResolvedValue(35_000_000n);

    await expect((service as any).processTronSweep({
      id: 'sweep-1',
      status: DepositSweepStatus.PENDING,
      rawAmount: '50000000',
      txHash: null,
      gasFundingTxHash: null,
      assetId: 'asset-usdt',
      depositAddress: {
        address: 'TDeposit',
        network: Chain.TRON,
        provider: CustodyProvider.PRIVY,
        providerWalletRef: 'deposit-wallet',
      },
    })).rejects.toThrow('policy violation');
    expect(update).toHaveBeenLastCalledWith({
      where: { id: 'sweep-1' },
      data: {
        status: DepositSweepStatus.PENDING,
        failureReason: 'policy violation',
      },
    });
  });
});
