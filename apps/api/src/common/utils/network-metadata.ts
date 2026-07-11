const NATIVE_GAS_SYMBOLS: Record<string, string> = {
  'ethereum-sepolia': 'ETH',
  ethereum: 'ETH',
  'base-sepolia': 'ETH',
  base: 'ETH',
  'optimism-sepolia': 'ETH',
  optimism: 'ETH',
  'arbitrum-sepolia': 'ETH',
  arbitrum: 'ETH',
  'polygon-amoy': 'POL',
  polygon: 'POL',
  'bnb-testnet': 'BNB',
  bnb: 'BNB',
  'avalanche-fuji': 'AVAX',
  avalanche: 'AVAX',
  'zksync-sepolia': 'ETH',
  zksync: 'ETH',
  'linea-sepolia': 'ETH',
  linea: 'ETH',
  'scroll-sepolia': 'ETH',
  scroll: 'ETH',
  'mantle-sepolia': 'MNT',
  mantle: 'MNT',
  'celo-alfajores': 'CELO',
  celo: 'CELO',
  'tron-nile': 'TRX',
  'tron-shasta': 'TRX',
  tron: 'TRX',
  'bitcoin-signet': 'BTC',
  bitcoin: 'BTC',
  'solana-devnet': 'SOL',
  solana: 'SOL',
};

export function nativeGasSymbol(networkKey: string): string {
  return NATIVE_GAS_SYMBOLS[networkKey] ?? 'ETH';
}

export function legacyChainToNetworkKey(chain: string): string {
  return chain.toLowerCase().replace(/_/g, '-');
}

export function legacyChainDisplayName(chain: string): string {
  return legacyChainToNetworkKey(chain)
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
