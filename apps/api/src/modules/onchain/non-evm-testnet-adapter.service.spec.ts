import { ConfigService } from '@nestjs/config';
import { Network } from '@prisma/client';
import { NonEvmTestnetAdapterService } from './non-evm-testnet-adapter.service';
import { PrivyCustodyService } from '../treasury/privy-custody.service';

describe('NonEvmTestnetAdapterService Tron history', () => {
  function service() {
    return new NonEvmTestnetAdapterService(
      { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService,
      {
        isTronEnabled: jest.fn().mockReturnValue(true),
        getWalletAddress: jest.fn().mockResolvedValue('TTreasury'),
      } as unknown as PrivyCustodyService,
    );
  }

  it('walks every fingerprint page in one confirmed inbound TRC20 stream', async () => {
    const instance = service();
    const first = Array.from({ length: 200 }, (_, index) => ({ transaction_id: `tx-${index}` }));
    const second = [{ transaction_id: 'tx-200' }];
    const get = jest.spyOn(instance as any, 'tronGridGet')
      .mockResolvedValueOnce({ data: first, success: true, meta: { fingerprint: 'next-page' } })
      .mockResolvedValueOnce({ data: second, success: true, meta: {} });

    const rows = await (instance as any).fetchTronHistoryPages(
      { chainKey: 'tron' } as Network,
      'TAddress',
      'trc20',
      100,
      200,
    );

    expect(rows).toHaveLength(201);
    expect(get).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining('only_confirmed=true'),
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining('fingerprint=next-page'),
    );
  });

  it('does not silently accept a failed history page', async () => {
    const instance = service();
    jest.spyOn(instance as any, 'tronGridGet').mockResolvedValue({ success: false, data: [] });

    await expect((instance as any).fetchTronHistoryPages(
      { chainKey: 'tron' } as Network,
      'TAddress',
      'trc20',
      0,
      200,
    )).rejects.toThrow('success=false');
  });

  it('treats OUT_OF_ENERGY as a terminal confirmed Tron failure', async () => {
    const instance = service();
    jest.spyOn(instance as any, 'tronPost').mockResolvedValue({
      blockNumber: 100,
      result: 'FAILED',
      receipt: {
        result: 'OUT_OF_ENERGY',
        energy_usage_total: 51_850,
      },
    });

    const result = await (instance as any).confirmTronWithdrawal({
      network: { chainKey: 'tron' },
      tokenContract: { standard: 'TRC20', address: 'TToken', decimals: 6 },
      txHash: 'tx-failed',
      toAddress: 'TRecipient',
      amount: '200',
      requiredConfirmations: 12,
    });

    expect(result).toEqual({
      confirmed: false,
      failed: true,
      failureReason: 'TRON transaction failed: OUT_OF_ENERGY',
      gasUsed: 51_850n,
    });
  });

  it('does not classify a pending Tron transaction as failed', async () => {
    const instance = service();
    jest.spyOn(instance as any, 'tronPost').mockResolvedValue({});

    const result = await (instance as any).confirmTronWithdrawal({
      network: { chainKey: 'tron' },
      tokenContract: { standard: 'TRC20', address: 'TToken', decimals: 6 },
      txHash: 'tx-pending',
      toAddress: 'TRecipient',
      amount: '200',
      requiredConfirmations: 12,
    });

    expect(result).toEqual({ confirmed: false });
  });
});
