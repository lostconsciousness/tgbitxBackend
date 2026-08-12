import { hyperliquidTradingViewSymbolFor } from './hyperliquid-perp-market.sync';

describe('hyperliquidTradingViewSymbolFor', () => {
  it('uses the Hyperliquid perpetual ticker instead of the spot ticker', () => {
    expect(hyperliquidTradingViewSymbolFor('BTC')).toBe('HYPERLIQUID:BTCUSDC.P');
  });

  it('preserves scaled provider contracts', () => {
    expect(hyperliquidTradingViewSymbolFor('kPEPE')).toBe('HYPERLIQUID:KPEPEUSDC.P');
    expect(hyperliquidTradingViewSymbolFor('kSHIB')).toBe('HYPERLIQUID:KSHIBUSDC.P');
    expect(hyperliquidTradingViewSymbolFor('kFLOKI')).toBe('HYPERLIQUID:KFLOKIUSDC.P');
  });
});
