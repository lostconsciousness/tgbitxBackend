import { resolveWithdrawalNativeGasReserve } from './withdrawal-native-gas.policy';

describe('withdrawal-native-gas.policy', () => {
  it('returns low BSC reserve', () => {
    expect(resolveWithdrawalNativeGasReserve('bnb')).toBe('0.00015');
  });

  it('falls back to env default for unknown networks', () => {
    expect(
      resolveWithdrawalNativeGasReserve('unknown-chain', {
        get: (_key, fallback) => fallback ?? '0.00015',
      }),
    ).toBe('0.00015');
  });
});
