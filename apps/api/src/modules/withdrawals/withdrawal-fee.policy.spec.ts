import { TokenStandard } from '@prisma/client';
import {
  buildWithdrawalFeeBreakdown,
  lookupPolicyWithdrawalFee,
  resolveWithdrawalFeeAmount,
} from './withdrawal-fee.policy';

describe('withdrawal-fee.policy', () => {
  it('returns BNB USDT fee from policy', () => {
    expect(lookupPolicyWithdrawalFee('USDT', 'bnb')).toBe('1');
    expect(
      resolveWithdrawalFeeAmount({
        assetSymbol: 'USDT',
        networkKey: 'bnb',
        configuredAmount: '0',
      }).toString(),
    ).toBe('1');
  });

  it('prefers policy over zero configured fee', () => {
    const breakdown = buildWithdrawalFeeBreakdown({
      assetSymbol: 'USDT',
      networkKey: 'bnb',
      configuredAmount: '0',
      tokenStandard: TokenStandard.ERC20,
    });
    expect(breakdown.withdrawalFeeAmount).toBe('1');
    expect(breakdown.gasPaidByExchange).toBe(false);
    expect(Number(breakdown.estimatedNetworkCostUsd ?? '0')).toBeGreaterThan(0);
    expect(Number(breakdown.estimatedNetworkCostUsd ?? '0')).toBeLessThan(1);
  });

  it('charges slightly more than estimated gas for L2 stables', () => {
    const breakdown = buildWithdrawalFeeBreakdown({
      assetSymbol: 'USDT',
      networkKey: 'arbitrum',
      configuredAmount: '1',
      tokenStandard: TokenStandard.ERC20,
    });
    expect(breakdown.withdrawalFeeAmount).toBe('0.75');
  });
});
