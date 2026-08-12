import { ConfigService } from '@nestjs/config';
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
});
