/**
 * Minimum native balance kept on the withdrawal hot wallet (covers ~2–3 typical txs).
 * Actual on-chain gas is much lower; SWEEP_GAS tops up when hot falls short.
 */
export const HOT_WALLET_NATIVE_GAS_RESERVE: Record<string, string> = {
  bnb: '0.00015',
  'bnb-testnet': '0.00015',
  arbitrum: '0.00003',
  'arbitrum-sepolia': '0.00003',
  base: '0.00002',
  'base-sepolia': '0.00002',
  optimism: '0.00002',
  'optimism-sepolia': '0.00002',
  polygon: '0.05',
  'polygon-amoy': '0.05',
  avalanche: '0.002',
  'avalanche-fuji': '0.002',
  ethereum: '0.001',
  'ethereum-sepolia': '0.001',
  zksync: '0.00003',
  linea: '0.00003',
  scroll: '0.00003',
  mantle: '0.00005',
};

export function resolveWithdrawalNativeGasReserve(
  networkKey: string,
  config?: { get(key: string, defaultValue?: string): string },
): string {
  const key = networkKey.trim().toLowerCase();
  return (
    HOT_WALLET_NATIVE_GAS_RESERVE[key] ??
    config?.get('WITHDRAWAL_NATIVE_GAS_RESERVE', '0.00015') ??
    '0.00015'
  );
}
