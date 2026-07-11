import { Chain } from '@prisma/client';

const CHAIN_ID_TO_LEGACY_CHAIN: Record<number, Chain> = {
  1: Chain.ETHEREUM,
  10: Chain.OPTIMISM,
  56: Chain.BNB,
  97: Chain.BNB_TESTNET,
  137: Chain.POLYGON,
  300: Chain.ZKSYNC_SEPOLIA,
  324: Chain.ZKSYNC,
  5000: Chain.MANTLE,
  5003: Chain.MANTLE_SEPOLIA,
  8453: Chain.BASE,
  84532: Chain.BASE_SEPOLIA,
  42161: Chain.ARBITRUM,
  421614: Chain.ARBITRUM_SEPOLIA,
  42220: Chain.CELO,
  43113: Chain.AVALANCHE_FUJI,
  43114: Chain.AVALANCHE,
  44787: Chain.CELO_ALFAJORES,
  59141: Chain.LINEA_SEPOLIA,
  59144: Chain.LINEA,
  80002: Chain.POLYGON_AMOY,
  534351: Chain.SCROLL_SEPOLIA,
  534352: Chain.SCROLL,
  11155111: Chain.ETHEREUM_SEPOLIA,
  11155420: Chain.OPTIMISM_SEPOLIA,
};

const NON_EVM_SIWE_NETWORK_KEYS = new Set([
  'bitcoin',
  'bitcoin-signet',
  'solana',
  'solana-devnet',
  'tron',
  'tron-nile',
  'tron-shasta',
]);

export function chainFromEvmChainId(chainId: number): Chain | null {
  return CHAIN_ID_TO_LEGACY_CHAIN[chainId] ?? null;
}

export function isSiweEligibleNetworkKey(networkKey: string): boolean {
  return !NON_EVM_SIWE_NETWORK_KEYS.has(networkKey.toLowerCase());
}

export function parseEnabledNetworkKeys(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((network) => network.trim().toLowerCase())
      .filter(Boolean)
      .filter(isSiweEligibleNetworkKey),
  );
}
