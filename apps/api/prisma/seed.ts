import {
  AssetType,
  Chain,
  CustodyAccountRole,
  CustodyAccountStatus,
  CustodyProvider,
  MarketStatus,
  MarketType,
  NetworkFamily,
  PrismaClient,
  TokenStandard,
  UserRole,
} from '@prisma/client';
import * as argon2 from 'argon2';
import * as fs from 'fs';
import * as path from 'path';
import { createPublicClient, getAddress, http, keccak256 } from 'viem';
import { lookupPolicyWithdrawalFee } from '../src/modules/withdrawals/withdrawal-fee.policy';

const prisma = new PrismaClient();

function policyWithdrawalFee(symbol: string, network: string, fallback = '0'): string {
  return lookupPolicyWithdrawalFee(symbol, network) ?? fallback;
}

async function main(): Promise<void> {
  await seedAdmin();
  validateMainnetSeedEnv();
  await seedNetworks();
  await seedAssets();
  await seedTokenContracts();
  await cleanupUnconfiguredNonEvmTestnetContracts();
  await seedExternalTokenAllowlist();
  await syncAssetTransferFlags();
  await seedMarkets();
  await seedTradingConfig();
  await seedCustodyAccounts();
}

async function seedAdmin(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email && !password) {
    return;
  }
  if (!email || !password || password.length < 16 || password === 'admin-secure-password') {
    throw new Error(
      'SEED_ADMIN_EMAIL and a unique SEED_ADMIN_PASSWORD of at least 16 characters are required',
    );
  }
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
  });

  await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {
      passwordHash,
      role: UserRole.ADMIN,
      status: 'ACTIVE',
    },
    create: {
      email: email.toLowerCase(),
      passwordHash,
      role: UserRole.ADMIN,
    },
  });
}

async function seedAssets(): Promise<void> {
  const chain = configuredLegacyChain();
  const isMainnet = Number(process.env.ONCHAIN_CHAIN_ID ?? 421614) === 42161;
  const assets = [
    {
      symbol: 'BTC',
      name: 'Bitcoin',
      type: AssetType.CRYPTO,
      tokenAddress: null,
      decimals: 8,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
    },
    {
      symbol: 'ETH',
      name: 'Ether',
      type: AssetType.CRYPTO,
      tokenAddress: null,
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
    },
    {
      symbol: 'SOL',
      name: 'Solana',
      type: AssetType.CRYPTO,
      tokenAddress: null,
      decimals: 9,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
    },
    {
      symbol: 'TRX',
      name: 'TRON',
      type: AssetType.CRYPTO,
      tokenAddress: null,
      decimals: 6,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
    },
    {
      symbol: 'BNB',
      name: 'BNB',
      type: AssetType.CRYPTO,
      tokenAddress: null,
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
    },
    {
      symbol: 'POL',
      name: 'Polygon Ecosystem Token',
      type: AssetType.CRYPTO,
      tokenAddress: null,
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
    },
    {
      symbol: 'AVAX',
      name: 'Avalanche',
      type: AssetType.CRYPTO,
      tokenAddress: null,
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
    },
    {
      symbol: 'USDC',
      name: 'USD Coin',
      type: AssetType.STABLECOIN,
      tokenAddress: isMainnet
        ? '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
        : process.env.ARBITRUM_SEPOLIA_USDC_ADDRESS || null,
      decimals: 6,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDT',
      name: 'Tether USD',
      type: AssetType.STABLECOIN,
      tokenAddress: isMainnet
        ? '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
        : process.env.ARBITRUM_SEPOLIA_USDT_ADDRESS || null,
      decimals: 6,
      withdrawalFeeAmount: '1',
      minWithdrawalAmount: '0',
    },
    {
      symbol: 'WETH',
      name: 'Wrapped Ether',
      type: AssetType.CRYPTO,
      tokenAddress: isMainnet
        ? '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
        : process.env.ARBITRUM_SEPOLIA_WETH_ADDRESS || null,
      decimals: 18,
      withdrawalFeeAmount: '0.0005',
      minWithdrawalAmount: '0.005',
    },
    {
      symbol: 'WBTC',
      name: 'Wrapped Bitcoin',
      type: AssetType.CRYPTO,
      tokenAddress: isMainnet
        ? '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'
        : process.env.ARBITRUM_SEPOLIA_WBTC_ADDRESS || null,
      decimals: 8,
      withdrawalFeeAmount: '0.00002',
      minWithdrawalAmount: '0.0002',
    },
    {
      symbol: 'ARB',
      name: 'Arbitrum',
      type: AssetType.CRYPTO,
      tokenAddress: isMainnet
        ? '0x912CE59144191C1204E64559FE8253a0e49E6548'
        : process.env.ARBITRUM_SEPOLIA_ARB_ADDRESS || null,
      decimals: 18,
      withdrawalFeeAmount: '1',
      minWithdrawalAmount: '10',
    },
  ];

  for (const asset of assets) {
    await prisma.asset.upsert({
      where: { symbol: asset.symbol },
      update: {
        ...asset,
        chain,
        iconUrl: assetIconUrl(asset.symbol),
        depositEnabled: Boolean(asset.tokenAddress),
        withdrawalEnabled: Boolean(asset.tokenAddress),
      },
      create: {
        ...asset,
        chain,
        iconUrl: assetIconUrl(asset.symbol),
        depositEnabled: Boolean(asset.tokenAddress),
        withdrawalEnabled: Boolean(asset.tokenAddress),
      },
    });
  }
}

async function seedNetworks(): Promise<void> {
  const isMainnet = Number(process.env.ONCHAIN_CHAIN_ID ?? 421614) === 42161;
  const mainnetMode = isMainnetSeedMode();
  const networks = [
    {
      chainKey: 'arbitrum-sepolia',
      displayName: 'Arbitrum Sepolia',
      family: NetworkFamily.EVM,
      legacyChain: Chain.ARBITRUM_SEPOLIA,
      caip2: 'eip155:421614',
      chainId: 421614,
      mainnet: false,
      rpcPrimaryEnv: 'ARBITRUM_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'ARBITRUM_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: !isMainnet,
      withdrawalEnabled: !isMainnet,
    },
    {
      chainKey: 'arbitrum',
      displayName: 'Arbitrum One',
      family: NetworkFamily.EVM,
      legacyChain: Chain.ARBITRUM,
      caip2: 'eip155:42161',
      chainId: 42161,
      mainnet: true,
      rpcPrimaryEnv: 'ARBITRUM_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'ARBITRUM_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: isMainnet,
      withdrawalEnabled: isMainnet,
    },
    {
      chainKey: 'ethereum-sepolia',
      displayName: 'Ethereum Sepolia',
      family: NetworkFamily.EVM,
      legacyChain: Chain.ETHEREUM_SEPOLIA,
      caip2: 'eip155:11155111',
      chainId: 11155111,
      mainnet: false,
      rpcPrimaryEnv: 'ETHEREUM_SEPOLIA_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'ETHEREUM_SEPOLIA_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 64,
      depositEnabled: !isMainnet,
      withdrawalEnabled: !isMainnet,
    },
    {
      chainKey: 'ethereum',
      displayName: 'Ethereum',
      family: NetworkFamily.EVM,
      legacyChain: Chain.ETHEREUM,
      caip2: 'eip155:1',
      chainId: 1,
      mainnet: true,
      rpcPrimaryEnv: 'ETHEREUM_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'ETHEREUM_RPC_FALLBACK_URL',
      confirmations: 15,
      reorgOverlapBlocks: 64,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'base-sepolia',
      displayName: 'Base Sepolia',
      family: NetworkFamily.EVM,
      legacyChain: Chain.BASE_SEPOLIA,
      caip2: 'eip155:84532',
      chainId: 84532,
      mainnet: false,
      rpcPrimaryEnv: 'BASE_SEPOLIA_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'BASE_SEPOLIA_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: !isMainnet,
      withdrawalEnabled: !isMainnet,
    },
    {
      chainKey: 'base',
      displayName: 'Base',
      family: NetworkFamily.EVM,
      legacyChain: Chain.BASE,
      caip2: 'eip155:8453',
      chainId: 8453,
      mainnet: true,
      rpcPrimaryEnv: 'BASE_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'BASE_RPC_FALLBACK_URL',
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'optimism-sepolia',
      displayName: 'OP Sepolia',
      family: NetworkFamily.EVM,
      legacyChain: Chain.OPTIMISM_SEPOLIA,
      caip2: 'eip155:11155420',
      chainId: 11155420,
      mainnet: false,
      rpcPrimaryEnv: 'OPTIMISM_SEPOLIA_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'OPTIMISM_SEPOLIA_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: !isMainnet,
      withdrawalEnabled: !isMainnet,
    },
    {
      chainKey: 'optimism',
      displayName: 'Optimism',
      family: NetworkFamily.EVM,
      legacyChain: Chain.OPTIMISM,
      caip2: 'eip155:10',
      chainId: 10,
      mainnet: true,
      rpcPrimaryEnv: 'OPTIMISM_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'OPTIMISM_RPC_FALLBACK_URL',
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'polygon-amoy',
      displayName: 'Polygon Amoy',
      family: NetworkFamily.EVM,
      legacyChain: Chain.POLYGON_AMOY,
      caip2: 'eip155:80002',
      chainId: 80002,
      mainnet: false,
      rpcPrimaryEnv: 'POLYGON_AMOY_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'POLYGON_AMOY_RPC_FALLBACK_URL',
      confirmations: 24,
      reorgOverlapBlocks: 128,
      depositEnabled: !isMainnet,
      withdrawalEnabled: !isMainnet,
    },
    {
      chainKey: 'polygon',
      displayName: 'Polygon',
      family: NetworkFamily.EVM,
      legacyChain: Chain.POLYGON,
      caip2: 'eip155:137',
      chainId: 137,
      mainnet: true,
      rpcPrimaryEnv: 'POLYGON_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'POLYGON_RPC_FALLBACK_URL',
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'bnb-testnet',
      displayName: 'BNB Smart Chain Testnet',
      family: NetworkFamily.EVM,
      legacyChain: Chain.BNB_TESTNET,
      caip2: 'eip155:97',
      chainId: 97,
      mainnet: false,
      rpcPrimaryEnv: 'BNB_TESTNET_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'BNB_TESTNET_RPC_FALLBACK_URL',
      confirmations: 15,
      reorgOverlapBlocks: 64,
      depositEnabled: !isMainnet,
      withdrawalEnabled: !isMainnet,
    },
    {
      chainKey: 'bnb',
      displayName: 'BNB Chain',
      family: NetworkFamily.EVM,
      legacyChain: Chain.BNB,
      caip2: 'eip155:56',
      chainId: 56,
      mainnet: true,
      rpcPrimaryEnv: 'BNB_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'BNB_RPC_FALLBACK_URL',
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'avalanche-fuji',
      displayName: 'Avalanche Fuji',
      family: NetworkFamily.EVM,
      legacyChain: Chain.AVALANCHE_FUJI,
      caip2: 'eip155:43113',
      chainId: 43113,
      mainnet: false,
      rpcPrimaryEnv: 'AVALANCHE_FUJI_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'AVALANCHE_FUJI_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: !isMainnet,
      withdrawalEnabled: !isMainnet,
    },
    {
      chainKey: 'avalanche',
      displayName: 'Avalanche C-Chain',
      family: NetworkFamily.EVM,
      legacyChain: Chain.AVALANCHE,
      caip2: 'eip155:43114',
      chainId: 43114,
      mainnet: true,
      rpcPrimaryEnv: 'AVALANCHE_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'AVALANCHE_RPC_FALLBACK_URL',
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'zksync-sepolia',
      displayName: 'zkSync Sepolia',
      family: NetworkFamily.EVM,
      legacyChain: Chain.ZKSYNC_SEPOLIA,
      caip2: 'eip155:300',
      chainId: 300,
      mainnet: false,
      rpcPrimaryEnv: 'ZKSYNC_SEPOLIA_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'ZKSYNC_SEPOLIA_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'zksync',
      displayName: 'zkSync Era',
      family: NetworkFamily.EVM,
      legacyChain: Chain.ZKSYNC,
      caip2: 'eip155:324',
      chainId: 324,
      mainnet: true,
      rpcPrimaryEnv: 'ZKSYNC_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'ZKSYNC_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'linea-sepolia',
      displayName: 'Linea Sepolia',
      family: NetworkFamily.EVM,
      legacyChain: Chain.LINEA_SEPOLIA,
      caip2: 'eip155:59141',
      chainId: 59141,
      mainnet: false,
      rpcPrimaryEnv: 'LINEA_SEPOLIA_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'LINEA_SEPOLIA_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'linea',
      displayName: 'Linea',
      family: NetworkFamily.EVM,
      legacyChain: Chain.LINEA,
      caip2: 'eip155:59144',
      chainId: 59144,
      mainnet: true,
      rpcPrimaryEnv: 'LINEA_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'LINEA_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'scroll-sepolia',
      displayName: 'Scroll Sepolia',
      family: NetworkFamily.EVM,
      legacyChain: Chain.SCROLL_SEPOLIA,
      caip2: 'eip155:534351',
      chainId: 534351,
      mainnet: false,
      rpcPrimaryEnv: 'SCROLL_SEPOLIA_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'SCROLL_SEPOLIA_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'scroll',
      displayName: 'Scroll',
      family: NetworkFamily.EVM,
      legacyChain: Chain.SCROLL,
      caip2: 'eip155:534352',
      chainId: 534352,
      mainnet: true,
      rpcPrimaryEnv: 'SCROLL_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'SCROLL_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'mantle-sepolia',
      displayName: 'Mantle Sepolia',
      family: NetworkFamily.EVM,
      legacyChain: Chain.MANTLE_SEPOLIA,
      caip2: 'eip155:5003',
      chainId: 5003,
      mainnet: false,
      rpcPrimaryEnv: 'MANTLE_SEPOLIA_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'MANTLE_SEPOLIA_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'mantle',
      displayName: 'Mantle',
      family: NetworkFamily.EVM,
      legacyChain: Chain.MANTLE,
      caip2: 'eip155:5000',
      chainId: 5000,
      mainnet: true,
      rpcPrimaryEnv: 'MANTLE_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'MANTLE_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'celo-alfajores',
      displayName: 'Celo Alfajores',
      family: NetworkFamily.EVM,
      legacyChain: Chain.CELO_ALFAJORES,
      caip2: 'eip155:44787',
      chainId: 44787,
      mainnet: false,
      rpcPrimaryEnv: 'CELO_ALFAJORES_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'CELO_ALFAJORES_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'celo',
      displayName: 'Celo',
      family: NetworkFamily.EVM,
      legacyChain: Chain.CELO,
      caip2: 'eip155:42220',
      chainId: 42220,
      mainnet: true,
      rpcPrimaryEnv: 'CELO_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'CELO_RPC_FALLBACK_URL',
      confirmations: 12,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'solana-devnet',
      displayName: 'Solana Devnet',
      family: NetworkFamily.SVM,
      legacyChain: Chain.SOLANA_DEVNET,
      caip2: 'solana:devnet',
      mainnet: false,
      rpcPrimaryEnv: 'SOLANA_DEVNET_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'SOLANA_DEVNET_RPC_FALLBACK_URL',
      confirmations: 32,
      reorgOverlapBlocks: 150,
      depositEnabled: true,
      withdrawalEnabled: true,
    },
    {
      chainKey: 'solana',
      displayName: 'Solana',
      family: NetworkFamily.SVM,
      legacyChain: Chain.SOLANA,
      caip2: 'solana:mainnet',
      mainnet: true,
      rpcPrimaryEnv: 'SOLANA_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'SOLANA_RPC_FALLBACK_URL',
      confirmations: 32,
      reorgOverlapBlocks: 150,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'tron-nile',
      displayName: 'TRON Nile',
      family: NetworkFamily.TVM,
      legacyChain: Chain.TRON_NILE,
      caip2: 'tron:nile',
      mainnet: false,
      rpcPrimaryEnv: 'TRON_NILE_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'TRON_NILE_RPC_FALLBACK_URL',
      confirmations: 20,
      reorgOverlapBlocks: 30,
      depositEnabled: true,
      withdrawalEnabled: true,
    },
    {
      chainKey: 'tron-shasta',
      displayName: 'TRON Shasta',
      family: NetworkFamily.TVM,
      legacyChain: Chain.TRON_SHASTA,
      caip2: 'tron:shasta',
      mainnet: false,
      rpcPrimaryEnv: 'TRON_SHASTA_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'TRON_SHASTA_RPC_FALLBACK_URL',
      confirmations: 20,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'tron',
      displayName: 'TRON',
      family: NetworkFamily.TVM,
      legacyChain: Chain.TRON,
      caip2: 'tron:mainnet',
      mainnet: true,
      rpcPrimaryEnv: 'TRON_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'TRON_RPC_FALLBACK_URL',
      confirmations: 20,
      reorgOverlapBlocks: 30,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
    {
      chainKey: 'bitcoin-signet',
      displayName: 'Bitcoin Signet',
      family: NetworkFamily.UTXO,
      legacyChain: Chain.BITCOIN_SIGNET,
      caip2: 'bip122:signet',
      mainnet: false,
      rpcPrimaryEnv: 'BITCOIN_SIGNET_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'BITCOIN_SIGNET_RPC_FALLBACK_URL',
      confirmations: 3,
      reorgOverlapBlocks: 6,
      depositEnabled: true,
      withdrawalEnabled: true,
    },
    {
      chainKey: 'bitcoin',
      displayName: 'Bitcoin',
      family: NetworkFamily.UTXO,
      legacyChain: Chain.BITCOIN,
      caip2: 'bip122:000000000019d6689c085ae165831e93',
      mainnet: true,
      rpcPrimaryEnv: 'BITCOIN_RPC_PRIMARY_URL',
      rpcFallbackEnv: 'BITCOIN_RPC_FALLBACK_URL',
      confirmations: 3,
      reorgOverlapBlocks: 6,
      depositEnabled: false,
      withdrawalEnabled: false,
    },
  ];

  for (const network of networks) {
    const data = {
      ...network,
      depositEnabled: network.mainnet
        ? isMainnetNetworkEnabled(network.chainKey)
        : !mainnetMode && network.depositEnabled,
      withdrawalEnabled: network.mainnet
        ? isMainnetNetworkEnabled(network.chainKey)
        : !mainnetMode && network.withdrawalEnabled,
      iconUrl: networkIconUrl(network.chainKey),
    };
    await prisma.network.upsert({
      where: { chainKey: network.chainKey },
      update: data,
      create: data,
    });
  }
}

async function seedTokenContracts(): Promise<void> {
  const networks = await prisma.network.findMany();
  const networkByKey = new Map(networks.map((network) => [network.chainKey, network]));
  await seedNativeTokenContracts(networkByKey);
  const contractAllowlist = [
    {
      symbol: 'USDC',
      network: 'ethereum',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      decimals: 6,
      withdrawalFeeAmount: policyWithdrawalFee('USDC', 'ethereum'),
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'arbitrum',
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      decimals: 6,
      withdrawalFeeAmount: policyWithdrawalFee('USDC', 'arbitrum'),
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDT',
      network: 'arbitrum',
      address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      decimals: 6,
      withdrawalFeeAmount: policyWithdrawalFee('USDT', 'arbitrum'),
      minWithdrawalAmount: '0',
    },
    {
      symbol: 'WETH',
      network: 'arbitrum',
      address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      decimals: 18,
      withdrawalFeeAmount: '0.0005',
      minWithdrawalAmount: '0.005',
    },
    {
      symbol: 'WBTC',
      network: 'arbitrum',
      address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
      decimals: 8,
      withdrawalFeeAmount: '0.00002',
      minWithdrawalAmount: '0.0002',
    },
    {
      symbol: 'ARB',
      network: 'arbitrum',
      address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
      decimals: 18,
      withdrawalFeeAmount: '1',
      minWithdrawalAmount: '10',
    },
    {
      symbol: 'LINK',
      network: 'arbitrum',
      address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
      spotOnly: true,
    },
    {
      symbol: 'UNI',
      network: 'arbitrum',
      address: '0xFa7F8980b0f1E64A2062791CC3b0871572F1F7f0',
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
      spotOnly: true,
    },
    {
      symbol: 'AAVE',
      network: 'arbitrum',
      address: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196',
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
      spotOnly: true,
    },
    {
      symbol: 'PENDLE',
      network: 'arbitrum',
      address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
      spotOnly: true,
    },
    {
      symbol: 'GMX',
      network: 'arbitrum',
      address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
      spotOnly: true,
    },
    {
      symbol: 'DAI',
      network: 'arbitrum',
      address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
      spotOnly: true,
    },
    {
      symbol: 'CRV',
      network: 'arbitrum',
      address: '0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978',
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
      spotOnly: true,
    },
    {
      symbol: 'LDO',
      network: 'arbitrum',
      address: '0x13Ad51ed4f1B7e9dc168d8A00cb3F4dDD85Efa60',
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
      spotOnly: true,
    },
    {
      symbol: 'GRT',
      network: 'arbitrum',
      address: '0x9623063377ad1B27544c965ccd7342f7EA7e88C7',
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
      spotOnly: true,
    },
    {
      symbol: 'SUSHI',
      network: 'arbitrum',
      address: '0xd4d42F0b6DEF4ce0383636770ef773390d85c61A',
      decimals: 18,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0',
      spotOnly: true,
    },
    {
      symbol: 'USDC',
      network: 'base',
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      withdrawalFeeAmount: policyWithdrawalFee('USDC', 'base'),
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'optimism',
      address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      decimals: 6,
      withdrawalFeeAmount: policyWithdrawalFee('USDC', 'optimism'),
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'polygon',
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      decimals: 6,
      withdrawalFeeAmount: policyWithdrawalFee('USDC', 'polygon'),
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'avalanche',
      address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      decimals: 6,
      withdrawalFeeAmount: policyWithdrawalFee('USDC', 'avalanche'),
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'bnb',
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      decimals: 18,
      withdrawalFeeAmount: policyWithdrawalFee('USDC', 'bnb'),
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDT',
      network: 'bnb',
      address: '0x55d398326f99059fF775485246999027B3197955',
      decimals: 18,
      withdrawalFeeAmount: policyWithdrawalFee('USDT', 'bnb'),
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'arbitrum-sepolia',
      address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      decimals: 6,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'ethereum-sepolia',
      address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      decimals: 6,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'base-sepolia',
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      decimals: 6,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'optimism-sepolia',
      address: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
      decimals: 6,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'polygon-amoy',
      address: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
      decimals: 6,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'bnb-testnet',
      address: process.env.MOCK_USDC_BNB_TESTNET_ADDRESS || null,
      decimals: 6,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDC',
      network: 'avalanche-fuji',
      address: '0x5425890298aed601595a70AB815c96711a31Bc65',
      decimals: 6,
      withdrawalFeeAmount: '0',
      minWithdrawalAmount: '0.000001',
    },
    {
      symbol: 'USDT',
      network: 'arbitrum-sepolia',
      address: process.env.ARBITRUM_SEPOLIA_USDT_ADDRESS || null,
      decimals: 6,
      withdrawalFeeAmount: '1',
      minWithdrawalAmount: '0',
    },
    {
      symbol: 'WETH',
      network: 'arbitrum-sepolia',
      address: process.env.ARBITRUM_SEPOLIA_WETH_ADDRESS || null,
      decimals: 18,
      withdrawalFeeAmount: '0.0005',
      minWithdrawalAmount: '0.005',
    },
    {
      symbol: 'WBTC',
      network: 'arbitrum-sepolia',
      address: process.env.ARBITRUM_SEPOLIA_WBTC_ADDRESS || null,
      decimals: 8,
      withdrawalFeeAmount: '0.00002',
      minWithdrawalAmount: '0.0002',
    },
    {
      symbol: 'ARB',
      network: 'arbitrum-sepolia',
      address: process.env.ARBITRUM_SEPOLIA_ARB_ADDRESS || null,
      decimals: 18,
      withdrawalFeeAmount: '1',
      minWithdrawalAmount: '10',
    },
  ];

  for (const contract of contractAllowlist) {
    const asset = await prisma.asset.findUnique({ where: { symbol: contract.symbol } });
    const network = networkByKey.get(contract.network);
    if (!asset || !network) continue;
    const address = contract.address?.trim() ? contract.address : null;
    const transfersEnabled = !('spotOnly' in contract && contract.spotOnly);
    const verification = await verifyErc20ContractForSeed(network, address);
    await prisma.tokenContract.upsert({
      where: {
        assetId_networkId_standard: {
          assetId: asset.id,
          networkId: network.id,
          standard: TokenStandard.ERC20,
        },
      },
      update: {
        address,
        decimals: contract.decimals,
        depositEnabled: transfersEnabled && Boolean(address) && isAutoEnabledNetwork(contract.network),
        withdrawalEnabled: transfersEnabled && Boolean(address) && isAutoEnabledNetwork(contract.network),
        withdrawalFeeAmount: contract.withdrawalFeeAmount,
        minWithdrawalAmount: contract.minWithdrawalAmount,
        contractVerifiedAt: verification?.verifiedAt,
        contractCodeHash: verification?.codeHash,
        verifiedChainId: verification?.chainId,
      },
      create: {
        assetId: asset.id,
        networkId: network.id,
        standard: TokenStandard.ERC20,
        address,
        decimals: contract.decimals,
        depositEnabled: transfersEnabled && Boolean(address) && isAutoEnabledNetwork(contract.network),
        withdrawalEnabled: transfersEnabled && Boolean(address) && isAutoEnabledNetwork(contract.network),
        withdrawalFeeAmount: contract.withdrawalFeeAmount,
        minWithdrawalAmount: contract.minWithdrawalAmount,
        contractVerifiedAt: verification?.verifiedAt,
        contractCodeHash: verification?.codeHash,
        verifiedChainId: verification?.chainId,
      },
    });
  }

  const btc = await prisma.asset.findUnique({ where: { symbol: 'BTC' } });
  const bitcoin = networkByKey.get('bitcoin');
  if (btc && bitcoin) {
    await prisma.tokenContract.upsert({
      where: {
        assetId_networkId_standard: {
          assetId: btc.id,
          networkId: bitcoin.id,
          standard: TokenStandard.BTC,
        },
      },
      update: {
        decimals: 8,
        depositEnabled: isMainnetNetworkEnabled('bitcoin'),
        withdrawalEnabled: isMainnetNetworkEnabled('bitcoin'),
        contractVerifiedAt: isMainnetNetworkEnabled('bitcoin') ? new Date() : null,
        metadata: isMainnetNetworkEnabled('bitcoin')
          ? { verification: { kind: 'utxo-native', network: 'bitcoin' } }
          : undefined,
      },
      create: {
        assetId: btc.id,
        networkId: bitcoin.id,
        standard: TokenStandard.BTC,
        decimals: 8,
        depositEnabled: isMainnetNetworkEnabled('bitcoin'),
        withdrawalEnabled: isMainnetNetworkEnabled('bitcoin'),
        contractVerifiedAt: isMainnetNetworkEnabled('bitcoin') ? new Date() : undefined,
        metadata: isMainnetNetworkEnabled('bitcoin')
          ? { verification: { kind: 'utxo-native', network: 'bitcoin' } }
          : undefined,
      },
    });
  }
  const bitcoinSignet = networkByKey.get('bitcoin-signet');
  if (btc && bitcoinSignet) {
    await prisma.tokenContract.upsert({
      where: {
        assetId_networkId_standard: {
          assetId: btc.id,
          networkId: bitcoinSignet.id,
          standard: TokenStandard.BTC,
        },
      },
      update: {
        decimals: 8,
        depositEnabled: true,
        withdrawalEnabled: true,
        contractVerifiedAt: new Date(),
        metadata: { verification: { kind: 'utxo-native', network: 'bitcoin-signet' } },
      },
      create: {
        assetId: btc.id,
        networkId: bitcoinSignet.id,
        standard: TokenStandard.BTC,
        decimals: 8,
        depositEnabled: true,
        withdrawalEnabled: true,
        contractVerifiedAt: new Date(),
        metadata: { verification: { kind: 'utxo-native', network: 'bitcoin-signet' } },
      },
    });
  }
  const sol = await prisma.asset.findUnique({ where: { symbol: 'SOL' } });
  const solana = networkByKey.get('solana');
  if (sol && solana) {
    const enabled = isMainnetNetworkEnabled('solana');
    await prisma.tokenContract.upsert({
      where: {
        assetId_networkId_standard: {
          assetId: sol.id,
          networkId: solana.id,
          standard: TokenStandard.NATIVE,
        },
      },
      update: {
        decimals: 9,
        depositEnabled: enabled,
        withdrawalEnabled: enabled,
        contractVerifiedAt: enabled ? new Date() : null,
        metadata: enabled
          ? { verification: { kind: 'svm-native', network: 'solana' } }
          : undefined,
      },
      create: {
        assetId: sol.id,
        networkId: solana.id,
        standard: TokenStandard.NATIVE,
        decimals: 9,
        depositEnabled: enabled,
        withdrawalEnabled: enabled,
        contractVerifiedAt: enabled ? new Date() : undefined,
        metadata: enabled
          ? { verification: { kind: 'svm-native', network: 'solana' } }
          : undefined,
      },
    });
  }
  const solanaDevnet = networkByKey.get('solana-devnet');
  if (sol && solanaDevnet) {
    await prisma.tokenContract.upsert({
      where: {
        assetId_networkId_standard: {
          assetId: sol.id,
          networkId: solanaDevnet.id,
          standard: TokenStandard.NATIVE,
        },
      },
      update: {
        decimals: 9,
        depositEnabled: true,
        withdrawalEnabled: true,
        contractVerifiedAt: new Date(),
        metadata: { verification: { kind: 'svm-native', network: 'solana-devnet' } },
      },
      create: {
        assetId: sol.id,
        networkId: solanaDevnet.id,
        standard: TokenStandard.NATIVE,
        decimals: 9,
        depositEnabled: true,
        withdrawalEnabled: true,
        contractVerifiedAt: new Date(),
        metadata: { verification: { kind: 'svm-native', network: 'solana-devnet' } },
      },
    });
  }
  const trx = await prisma.asset.findUnique({ where: { symbol: 'TRX' } });
  for (const networkKey of ['tron-nile', 'tron-shasta', 'tron']) {
    const network = networkByKey.get(networkKey);
    if (!trx || !network) {
      continue;
    }
    const enabled = networkKey === 'tron-nile' || isMainnetNetworkEnabled(networkKey);
    await prisma.tokenContract.upsert({
      where: {
        assetId_networkId_standard: {
          assetId: trx.id,
          networkId: network.id,
          standard: TokenStandard.NATIVE,
        },
      },
      update: {
        decimals: 6,
        depositEnabled: enabled,
        withdrawalEnabled: enabled,
        contractVerifiedAt: enabled ? new Date() : undefined,
        metadata: enabled
          ? { verification: { kind: 'tvm-native', network: networkKey } }
          : undefined,
      },
      create: {
        assetId: trx.id,
        networkId: network.id,
        standard: TokenStandard.NATIVE,
        decimals: 6,
        depositEnabled: enabled,
        withdrawalEnabled: enabled,
        contractVerifiedAt: enabled ? new Date() : undefined,
        metadata: enabled
          ? { verification: { kind: 'tvm-native', network: networkKey } }
          : undefined,
      },
    });
  }
  const usdt = await prisma.asset.findUnique({ where: { symbol: 'USDT' } });
  const tronMainnet = networkByKey.get('tron');
  if (usdt && tronMainnet) {
    await prisma.tokenContract.upsert({
      where: {
        assetId_networkId_standard: {
          assetId: usdt.id,
          networkId: tronMainnet.id,
          standard: TokenStandard.TRC20,
        },
      },
      update: {
        address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        decimals: 6,
        depositEnabled: isMainnetNetworkEnabled('tron'),
        withdrawalEnabled: isMainnetNetworkEnabled('tron'),
        withdrawalFeeAmount: policyWithdrawalFee('USDT', 'tron'),
        minWithdrawalAmount: '0',
        contractVerifiedAt: isMainnetNetworkEnabled('tron') ? new Date() : null,
        metadata: isMainnetNetworkEnabled('tron')
          ? { verification: { kind: 'trc20', network: 'tron' } }
          : undefined,
      },
      create: {
        assetId: usdt.id,
        networkId: tronMainnet.id,
        standard: TokenStandard.TRC20,
        address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        decimals: 6,
        depositEnabled: isMainnetNetworkEnabled('tron'),
        withdrawalEnabled: isMainnetNetworkEnabled('tron'),
        contractVerifiedAt: isMainnetNetworkEnabled('tron') ? new Date() : undefined,
        metadata: isMainnetNetworkEnabled('tron')
          ? { verification: { kind: 'trc20', network: 'tron' } }
          : undefined,
        withdrawalFeeAmount: policyWithdrawalFee('USDT', 'tron'),
        minWithdrawalAmount: '0',
      },
    });
  }
  const tronNile = networkByKey.get('tron-nile');
  if (usdt && tronNile) {
    const tronNileUsdtConfigured = Boolean(process.env.TRON_NILE_USDT_TRC20_ADDRESS);
    await prisma.tokenContract.upsert({
      where: {
        assetId_networkId_standard: {
          assetId: usdt.id,
          networkId: tronNile.id,
          standard: TokenStandard.TRC20,
        },
      },
      update: {
        address: process.env.TRON_NILE_USDT_TRC20_ADDRESS || null,
        decimals: 6,
        depositEnabled: tronNileUsdtConfigured,
        withdrawalEnabled: tronNileUsdtConfigured,
        contractVerifiedAt: tronNileUsdtConfigured ? new Date() : null,
        metadata: tronNileUsdtConfigured
          ? { verification: { kind: 'trc20', network: 'tron-nile' } }
          : undefined,
      },
      create: {
        assetId: usdt.id,
        networkId: tronNile.id,
        standard: TokenStandard.TRC20,
        address: process.env.TRON_NILE_USDT_TRC20_ADDRESS || null,
        decimals: 6,
        depositEnabled: tronNileUsdtConfigured,
        withdrawalEnabled: tronNileUsdtConfigured,
        contractVerifiedAt: tronNileUsdtConfigured ? new Date() : undefined,
        metadata: tronNileUsdtConfigured
          ? { verification: { kind: 'trc20', network: 'tron-nile' } }
          : undefined,
        withdrawalFeeAmount: '1',
        minWithdrawalAmount: '0',
      },
    });
  }
}

async function cleanupUnconfiguredNonEvmTestnetContracts(): Promise<void> {
  await prisma.tokenContract.deleteMany({
    where: {
      address: null,
      standard: { in: [TokenStandard.SPL, TokenStandard.TRC20] },
      network: {
        chainKey: { in: ['solana-devnet', 'tron-nile'] },
      },
    },
  });
}

async function seedNativeTokenContracts(
  networkByKey: Map<string, Awaited<ReturnType<typeof prisma.network.findMany>>[number]>,
): Promise<void> {
  const nativeContracts = [
    { symbol: 'ETH', network: 'arbitrum-sepolia', decimals: 18 },
    { symbol: 'ETH', network: 'arbitrum', decimals: 18 },
    { symbol: 'ETH', network: 'ethereum-sepolia', decimals: 18 },
    { symbol: 'ETH', network: 'ethereum', decimals: 18 },
    { symbol: 'ETH', network: 'base-sepolia', decimals: 18 },
    { symbol: 'ETH', network: 'base', decimals: 18 },
    { symbol: 'ETH', network: 'optimism-sepolia', decimals: 18 },
    { symbol: 'ETH', network: 'optimism', decimals: 18 },
    { symbol: 'BNB', network: 'bnb-testnet', decimals: 18 },
    { symbol: 'BNB', network: 'bnb', decimals: 18 },
    { symbol: 'POL', network: 'polygon-amoy', decimals: 18 },
    { symbol: 'POL', network: 'polygon', decimals: 18 },
    { symbol: 'AVAX', network: 'avalanche-fuji', decimals: 18 },
    { symbol: 'AVAX', network: 'avalanche', decimals: 18 },
  ];

  for (const contract of nativeContracts) {
    const asset = await prisma.asset.findUnique({ where: { symbol: contract.symbol } });
    const network = networkByKey.get(contract.network);
    if (!asset || !network) {
      continue;
    }
    const enabled = network.mainnet ? isMainnetNetworkEnabled(network.chainKey) : true;
    await prisma.tokenContract.upsert({
      where: {
        assetId_networkId_standard: {
          assetId: asset.id,
          networkId: network.id,
          standard: TokenStandard.NATIVE,
        },
      },
      update: {
        decimals: contract.decimals,
        depositEnabled: enabled,
        withdrawalEnabled: network.mainnet ? enabled : false,
        contractVerifiedAt: enabled ? new Date() : undefined,
        verifiedChainId: network.chainId,
        metadata: enabled
          ? { verification: { kind: 'evm-native', network: network.chainKey } }
          : undefined,
      },
      create: {
        assetId: asset.id,
        networkId: network.id,
        standard: TokenStandard.NATIVE,
        decimals: contract.decimals,
        depositEnabled: enabled,
        withdrawalEnabled: network.mainnet ? enabled : false,
        contractVerifiedAt: enabled ? new Date() : undefined,
        verifiedChainId: network.chainId,
        metadata: enabled
          ? { verification: { kind: 'evm-native', network: network.chainKey } }
          : undefined,
      },
    });
  }
}

type ExternalTokenAllowlist = {
  assets?: ExternalTokenAllowlistAsset[];
};

type ExternalTokenAllowlistAsset = {
  symbol: string;
  name: string;
  iconUrl?: string | null;
  type?: 'CRYPTO' | 'STABLECOIN';
  decimals: number;
  networks: Array<{
    network: string;
    standard?: 'ERC20' | 'SPL' | 'BTC' | 'TRC20' | 'NATIVE';
    address?: string | null;
    decimals?: number;
    withdrawalFeeAmount?: string;
    minWithdrawalAmount?: string;
  }>;
};

async function seedExternalTokenAllowlist(): Promise<void> {
  const filePath = process.env.TOKEN_ALLOWLIST_PATH ||
    'apps/api/prisma/allowlists/top-100-uniswap-default.json';

  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : resolveAllowlistPath(filePath);
  if (!resolvedPath) {
    throw new Error(`TOKEN_ALLOWLIST_PATH does not exist: ${filePath}`);
  }

  const payload = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as
    | ExternalTokenAllowlist
    | ExternalTokenAllowlistAsset[];
  const entries = Array.isArray(payload) ? payload : payload.assets ?? [];
  const networks = await prisma.network.findMany();
  const networkByKey = new Map(networks.map((network) => [network.chainKey, network]));

  for (const entry of entries) {
    if (!entry.symbol || !entry.name || !Array.isArray(entry.networks)) {
      throw new Error('Invalid TOKEN_ALLOWLIST_PATH entry: symbol, name and networks are required');
    }
    const symbol = entry.symbol.trim().toUpperCase();
    const asset = await prisma.asset.upsert({
      where: { symbol },
      update: {
        name: entry.name,
        iconUrl: entry.iconUrl ?? assetIconUrl(symbol),
        type: entry.type ?? AssetType.CRYPTO,
        decimals: entry.decimals,
      },
      create: {
        symbol,
        name: entry.name,
        iconUrl: entry.iconUrl ?? assetIconUrl(symbol),
        type: entry.type ?? AssetType.CRYPTO,
        decimals: entry.decimals,
        depositEnabled: false,
        withdrawalEnabled: false,
      },
    });

    for (const contract of entry.networks) {
      const network = networkByKey.get(contract.network.trim().toLowerCase());
      if (!network) {
        throw new Error(`Unknown network in TOKEN_ALLOWLIST_PATH: ${contract.network}`);
      }
      const standard = (contract.standard ?? TokenStandard.ERC20) as TokenStandard;
      const address = contract.address?.trim()
        ? standard === TokenStandard.ERC20
          ? getAddress(contract.address)
          : contract.address.trim()
        : null;
      const where = {
        assetId_networkId_standard: {
          assetId: asset.id,
          networkId: network.id,
          standard,
        },
      };
      const existing = await prisma.tokenContract.findUnique({ where });
      const addressChanged =
        Boolean(existing?.address || address) &&
        (existing?.address ?? '').toLowerCase() !== (address ?? '').toLowerCase();

      if (existing) {
        await prisma.tokenContract.update({
          where,
          data: {
            address,
            decimals: contract.decimals ?? entry.decimals,
            withdrawalFeeAmount: contract.withdrawalFeeAmount ?? '0',
            minWithdrawalAmount: contract.minWithdrawalAmount ?? '0',
            ...(addressChanged
              ? {
                  depositEnabled: false,
                  withdrawalEnabled: false,
                  contractVerifiedAt: null,
                  contractCodeHash: null,
                  verifiedChainId: null,
                }
              : {}),
          },
        });
        continue;
      }

      await prisma.tokenContract.create({
        data: {
          assetId: asset.id,
          networkId: network.id,
          standard,
          address,
          decimals: contract.decimals ?? entry.decimals,
          withdrawalFeeAmount: contract.withdrawalFeeAmount ?? '0',
          minWithdrawalAmount: contract.minWithdrawalAmount ?? '0',
          depositEnabled: false,
          withdrawalEnabled: false,
        },
      });
    }
  }
}

async function verifyErc20ContractForSeed(
  network: Awaited<ReturnType<typeof prisma.network.findMany>>[number],
  address: string | null,
): Promise<{ verifiedAt: Date; codeHash: string; chainId: number } | null> {
  if (!address || network.family !== NetworkFamily.EVM || !isAutoEnabledNetwork(network.chainKey)) {
    return null;
  }
  if (!network.rpcPrimaryEnv || !network.chainId) {
    return null;
  }
  const rpcUrl =
    process.env[network.rpcPrimaryEnv] ||
    (network.rpcFallbackEnv ? process.env[network.rpcFallbackEnv] : '');
  if (!rpcUrl) {
    return null;
  }

  try {
    const client = createPublicClient({ transport: http(rpcUrl) });
    const code = await client.getCode({ address: getAddress(address) });
    if (!code || code === '0x') {
      return null;
    }
    return {
      verifiedAt: new Date(),
      codeHash: keccak256(code),
      chainId: network.chainId!,
    };
  } catch (_error) {
    return null;
  }
}

async function syncAssetTransferFlags(): Promise<void> {
  const assets = await prisma.asset.findMany({
    select: { id: true },
  });

  for (const asset of assets) {
    const [depositContract, withdrawalContract] = await Promise.all([
      prisma.tokenContract.findFirst({
        where: {
          assetId: asset.id,
          depositEnabled: true,
          network: { depositEnabled: true },
        },
        select: { id: true },
      }),
      prisma.tokenContract.findFirst({
        where: {
          assetId: asset.id,
          withdrawalEnabled: true,
          network: { withdrawalEnabled: true },
        },
        select: { id: true },
      }),
    ]);

    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        depositEnabled: Boolean(depositContract),
        withdrawalEnabled: Boolean(withdrawalContract),
      },
    });
  }
}

function resolveAllowlistPath(filePath: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), filePath),
    path.resolve(process.cwd(), '..', '..', filePath),
    path.resolve(__dirname, '..', filePath),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function seedTradingConfig(): Promise<void> {
  const markets = await prisma.market.findMany({
    where: { type: MarketType.PERP },
  });
  for (const market of markets) {
    await prisma.riskConfig.upsert({
      where: { marketId: market.id },
      update: {},
      create: {
        marketId: market.id,
        bbookEnabled: true,
        maxLeverage: market.symbol.startsWith('SOL') ? 5 : 10,
      },
    });
    await prisma.feeConfig.upsert({
      where: { marketId: market.id },
      update: {},
      create: { marketId: market.id },
    });
    await prisma.bBookExposure.upsert({
      where: { marketId: market.id },
      update: {},
      create: { marketId: market.id },
    });
  }
}

async function seedCustodyAccounts(): Promise<void> {
  const enabledNetworks = await prisma.network.findMany({
    where: {
      family: NetworkFamily.EVM,
      OR: [{ depositEnabled: true }, { withdrawalEnabled: true }],
    },
  });
  const targetNetworks = enabledNetworks
    .map((network) => network.legacyChain)
    .filter((network): network is Chain => Boolean(network));
  if (targetNetworks.length === 0) {
    targetNetworks.push(configuredLegacyChain());
  }
  const accounts = [
    {
      role: CustodyAccountRole.DEPOSIT_TREASURY,
      provider: CustodyProvider.PRIVY,
      address:
        process.env.DEPOSIT_TREASURY_ADDRESS ??
        process.env.ARBITRUM_DEPOSIT_ADDRESS,
      providerWalletRef: process.env.PRIVY_DEPOSIT_TREASURY_WALLET_ID,
    },
    {
      role: CustodyAccountRole.WITHDRAWAL_HOT,
      provider: CustodyProvider.PRIVY,
      address: process.env.WITHDRAWAL_HOT_ADDRESS,
      providerWalletRef: process.env.PRIVY_SERVER_WALLET_ID,
    },
    {
      role: CustodyAccountRole.SWEEP_GAS,
      provider: CustodyProvider.PRIVY,
      address: process.env.SWEEP_GAS_ADDRESS,
      providerWalletRef: process.env.PRIVY_SWEEP_GAS_WALLET_ID,
      policyRef: process.env.PRIVY_SWEEP_GAS_POLICY_ID,
    },
    {
      role: CustodyAccountRole.SPOT_LIQUIDITY,
      provider: CustodyProvider.PRIVY,
      address: process.env.SPOT_LIQUIDITY_ADDRESS,
      providerWalletRef: process.env.PRIVY_SPOT_LIQUIDITY_WALLET_ID,
      policyRef: process.env.PRIVY_SPOT_LIQUIDITY_POLICY_ID,
    },
    {
      role: CustodyAccountRole.SAFE_RESERVE,
      provider: CustodyProvider.SAFE,
      address: process.env.SAFE_RESERVE_ADDRESS,
    },
    {
      role: CustodyAccountRole.HYPERLIQUID_COLLATERAL,
      provider: CustodyProvider.HYPERLIQUID,
      address: process.env.HYPERLIQUID_MASTER_ADDRESS,
      providerWalletRef: process.env.PRIVY_HYPERLIQUID_MASTER_WALLET_ID,
    },
    {
      role: CustodyAccountRole.PLATFORM_CAPITAL,
      provider: CustodyProvider.PRIVY,
      address: process.env.PLATFORM_CAPITAL_ADDRESS,
      providerWalletRef: process.env.PRIVY_PLATFORM_CAPITAL_WALLET_ID,
      policyRef: process.env.PRIVY_PLATFORM_CAPITAL_POLICY_ID,
    },
    {
      role: CustodyAccountRole.INSURANCE,
      provider: CustodyProvider.PRIVY,
      address: process.env.INSURANCE_ADDRESS,
      providerWalletRef: process.env.PRIVY_INSURANCE_WALLET_ID,
      policyRef: process.env.PRIVY_INSURANCE_POLICY_ID,
    },
  ];

  for (const network of targetNetworks) {
    for (const account of accounts) {
      if (!account.address || !/^0x[a-fA-F0-9]{40}$/.test(account.address)) {
        continue;
      }
      await prisma.custodyAccount.upsert({
        where: { role_network: { role: account.role, network } },
        update: {
          provider: account.provider,
          address: account.address.toLowerCase(),
          providerWalletRef: account.providerWalletRef,
          policyRef: 'policyRef' in account ? account.policyRef : undefined,
        },
        create: {
          role: account.role,
          provider: account.provider,
          network,
          address: account.address.toLowerCase(),
          providerWalletRef: account.providerWalletRef,
          policyRef: 'policyRef' in account ? account.policyRef : undefined,
        },
      });
    }
  }

  const externalHotAccounts = [
    { network: Chain.SOLANA, env: 'SOLANA_WITHDRAWAL_HOT_ADDRESS' },
    { network: Chain.SOLANA_DEVNET, env: 'SOLANA_DEVNET_WITHDRAWAL_HOT_ADDRESS' },
    { network: Chain.BITCOIN, env: 'BITCOIN_WITHDRAWAL_HOT_ADDRESS' },
    { network: Chain.BITCOIN_SIGNET, env: 'BITCOIN_SIGNET_WITHDRAWAL_HOT_ADDRESS' },
    { network: Chain.TRON, env: 'TRON_WITHDRAWAL_HOT_ADDRESS' },
    { network: Chain.TRON_NILE, env: 'TRON_NILE_WITHDRAWAL_HOT_ADDRESS' },
    { network: Chain.TRON_SHASTA, env: 'TRON_SHASTA_WITHDRAWAL_HOT_ADDRESS' },
  ];

  for (const account of externalHotAccounts) {
    const address = process.env[account.env]?.trim();
    if (!address) {
      continue;
    }
    if (account.network === Chain.TRON && process.env.PRIVY_TRON_WALLET_ID?.trim()) {
      continue;
    }
    await prisma.custodyAccount.upsert({
      where: {
        role_network: {
          role: CustodyAccountRole.WITHDRAWAL_HOT,
          network: account.network,
        },
      },
      update: {
        provider: CustodyProvider.EXTERNAL,
        address,
        providerWalletRef: null,
        policyRef: null,
        status: CustodyAccountStatus.ACTIVE,
      },
      create: {
        role: CustodyAccountRole.WITHDRAWAL_HOT,
        provider: CustodyProvider.EXTERNAL,
        network: account.network,
        address,
        status: CustodyAccountStatus.ACTIVE,
      },
    });
  }

  const tronPrivyWalletId = process.env.PRIVY_TRON_WALLET_ID?.trim();
  const tronHotAddress = process.env.TRON_WITHDRAWAL_HOT_ADDRESS?.trim();
  if (tronPrivyWalletId && tronHotAddress) {
    await prisma.custodyAccount.upsert({
      where: {
        role_network: {
          role: CustodyAccountRole.WITHDRAWAL_HOT,
          network: Chain.TRON,
        },
      },
      update: {
        provider: CustodyProvider.PRIVY,
        address: tronHotAddress,
        providerWalletRef: tronPrivyWalletId,
        policyRef: process.env.PRIVY_TRON_RESERVE_POLICY_ID ?? null,
        status: CustodyAccountStatus.ACTIVE,
      },
      create: {
        role: CustodyAccountRole.WITHDRAWAL_HOT,
        provider: CustodyProvider.PRIVY,
        network: Chain.TRON,
        address: tronHotAddress,
        providerWalletRef: tronPrivyWalletId,
        policyRef: process.env.PRIVY_TRON_RESERVE_POLICY_ID ?? null,
        status: CustodyAccountStatus.ACTIVE,
      },
    });
  }
}

async function seedMarkets(): Promise<void> {
  await upsertMarket('BTC-PERP', 'BTC', 'USDC', MarketType.PERP, 1, 5, '0.00001', {
    providerName: 'HYPERLIQUID',
    providerSymbol: 'BTC',
    tradingViewSymbol: 'HYPERLIQUID:BTCUSDC.P',
    orderbookEnabled: true,
  });
  await upsertMarket('ETH-PERP', 'ETH', 'USDC', MarketType.PERP, 2, 4, '0.0001', {
    providerName: 'HYPERLIQUID',
    providerSymbol: 'ETH',
    tradingViewSymbol: 'HYPERLIQUID:ETHUSDC.P',
    orderbookEnabled: true,
  });
  await upsertMarket('SOL-PERP', 'SOL', 'USDC', MarketType.PERP, 3, 2, '0.01', {
    providerName: 'HYPERLIQUID',
    providerSymbol: 'SOL',
    tradingViewSymbol: 'HYPERLIQUID:SOLUSDC.P',
    orderbookEnabled: true,
  });
  await upsertMarket('TRX-PERP', 'TRX', 'USDC', MarketType.PERP, 5, 2, '1', {
    providerName: 'HYPERLIQUID',
    providerSymbol: 'TRX',
    tradingViewSymbol: 'HYPERLIQUID:TRXUSDC.P',
    orderbookEnabled: true,
  });
  const { syncHyperliquidPerpMarkets } = await import('../src/modules/markets/hyperliquid-perp-market.sync');
  const syncResult = await syncHyperliquidPerpMarkets(prisma);
  console.log('Hyperliquid PERP sync:', syncResult);
  await seedSpotValuationMarkets();
}

async function seedSpotValuationMarkets(): Promise<void> {
  const [usdc, assets, existingMarkets] = await Promise.all([
    prisma.asset.findUniqueOrThrow({ where: { symbol: 'USDC' } }),
    prisma.asset.findMany({ orderBy: { symbol: 'asc' } }),
    prisma.market.findMany({
      where: {
        status: MarketStatus.ACTIVE,
        quoteAsset: { symbol: 'USDC' },
        type: MarketType.SPOT,
      },
      select: { baseAssetId: true },
    }),
  ]);
  const coveredAssetIds = new Set(existingMarkets.map((market) => market.baseAssetId));
  const spotConfig: Record<
    string,
    { pricePrecision: number; sizePrecision: number; minOrderSize: string }
  > = {
    BTC: { pricePrecision: 1, sizePrecision: 5, minOrderSize: '0.00001' },
    ETH: { pricePrecision: 2, sizePrecision: 6, minOrderSize: '0.001' },
    WETH: { pricePrecision: 2, sizePrecision: 6, minOrderSize: '0.001' },
    WBTC: { pricePrecision: 2, sizePrecision: 6, minOrderSize: '0.0001' },
    SOL: { pricePrecision: 3, sizePrecision: 2, minOrderSize: '0.01' },
    BNB: { pricePrecision: 2, sizePrecision: 4, minOrderSize: '0.01' },
    AVAX: { pricePrecision: 3, sizePrecision: 2, minOrderSize: '0.01' },
    ARB: { pricePrecision: 4, sizePrecision: 2, minOrderSize: '1' },
    TRX: { pricePrecision: 5, sizePrecision: 2, minOrderSize: '1' },
    POL: { pricePrecision: 5, sizePrecision: 2, minOrderSize: '1' },
    USDT: { pricePrecision: 4, sizePrecision: 2, minOrderSize: '1' },
  };
  const defaultSpot = { pricePrecision: 4, sizePrecision: 4, minOrderSize: '0.01' };

  for (const asset of assets) {
    if (asset.id === usdc.id || coveredAssetIds.has(asset.id)) {
      continue;
    }

    const config = spotConfig[asset.symbol] ?? defaultSpot;
    await upsertMarket(
      `${asset.symbol}-USDC`,
      asset.symbol,
      'USDC',
      MarketType.SPOT,
      config.pricePrecision,
      config.sizePrecision,
      config.minOrderSize,
    );
    coveredAssetIds.add(asset.id);
  }
}

async function upsertMarket(
  symbol: string,
  baseAssetSymbol: string,
  quoteAssetSymbol: string,
  type: MarketType,
  pricePrecision: number,
  sizePrecision: number,
  minOrderSize: string,
  provider?: {
    providerName: string;
    providerSymbol: string;
    tradingViewSymbol: string;
    orderbookEnabled: boolean;
  },
): Promise<void> {
  const [baseAsset, quoteAsset] = await Promise.all([
    prisma.asset.findUniqueOrThrow({ where: { symbol: baseAssetSymbol } }),
    prisma.asset.findUniqueOrThrow({ where: { symbol: quoteAssetSymbol } }),
  ]);

  await prisma.market.upsert({
    where: { symbol },
    update: {
      status: MarketStatus.ACTIVE,
      baseAssetId: baseAsset.id,
      quoteAssetId: quoteAsset.id,
      pricePrecision,
      sizePrecision,
      minOrderSize,
      providerName: provider?.providerName,
      providerSymbol: provider?.providerSymbol,
      tradingViewSymbol: provider?.tradingViewSymbol,
      orderbookEnabled: provider?.orderbookEnabled ?? false,
    },
    create: {
      symbol,
      type,
      status: MarketStatus.ACTIVE,
      baseAssetId: baseAsset.id,
      quoteAssetId: quoteAsset.id,
      pricePrecision,
      sizePrecision,
      minOrderSize,
      providerName: provider?.providerName,
      providerSymbol: provider?.providerSymbol,
      tradingViewSymbol: provider?.tradingViewSymbol,
      orderbookEnabled: provider?.orderbookEnabled ?? false,
    },
  });
}

function configuredLegacyChain(): Chain {
  const chains: Record<number, Chain> = {
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
    42220: Chain.CELO,
    44787: Chain.CELO_ALFAJORES,
    59141: Chain.LINEA_SEPOLIA,
    59144: Chain.LINEA,
    42161: Chain.ARBITRUM,
    421614: Chain.ARBITRUM_SEPOLIA,
    43113: Chain.AVALANCHE_FUJI,
    43114: Chain.AVALANCHE,
    80002: Chain.POLYGON_AMOY,
    534351: Chain.SCROLL_SEPOLIA,
    534352: Chain.SCROLL,
    11155111: Chain.ETHEREUM_SEPOLIA,
    11155420: Chain.OPTIMISM_SEPOLIA,
  };
  return chains[Number(process.env.ONCHAIN_CHAIN_ID ?? 421614)] ?? Chain.ARBITRUM_SEPOLIA;
}

function chainKeyForChainId(chainId: number): string {
  const keys: Record<number, string> = {
    1: 'ethereum',
    10: 'optimism',
    56: 'bnb',
    97: 'bnb-testnet',
    137: 'polygon',
    300: 'zksync-sepolia',
    324: 'zksync',
    5000: 'mantle',
    5003: 'mantle-sepolia',
    8453: 'base',
    84532: 'base-sepolia',
    42220: 'celo',
    44787: 'celo-alfajores',
    59141: 'linea-sepolia',
    59144: 'linea',
    42161: 'arbitrum',
    421614: 'arbitrum-sepolia',
    43113: 'avalanche-fuji',
    43114: 'avalanche',
    80002: 'polygon-amoy',
    534351: 'scroll-sepolia',
    534352: 'scroll',
    11155111: 'ethereum-sepolia',
    11155420: 'optimism-sepolia',
  };
  return keys[chainId] ?? 'arbitrum-sepolia';
}

function isAutoEnabledNetwork(chainKey: string): boolean {
  return chainKey === 'arbitrum-sepolia' || isMainnetNetworkEnabled(chainKey);
}

function isMainnetSeedMode(): boolean {
  return process.env.MAINNET_ENABLED === 'true' || enabledMainnetNetworkKeys().size > 0;
}

function isMainnetNetworkEnabled(chainKey: string): boolean {
  const enabled = enabledMainnetNetworkKeys();
  if (enabled.size > 0) {
    return enabled.has(chainKey);
  }
  if (process.env.MAINNET_ENABLED !== 'true') {
    return false;
  }
  return chainKeyForChainId(Number(process.env.ONCHAIN_CHAIN_ID ?? 421614)) === chainKey;
}

function validateMainnetSeedEnv(): void {
  if (!isMainnetSeedMode()) {
    return;
  }

  const enabled = enabledMainnetNetworkKeys();
  const networks = enabled.size > 0
    ? [...enabled]
    : [chainKeyForChainId(Number(process.env.ONCHAIN_CHAIN_ID ?? 421614))];
  const evmNetworks = new Set([
    'ethereum',
    'arbitrum',
    'base',
    'optimism',
    'polygon',
    'bnb',
    'avalanche',
    'zksync',
    'linea',
    'scroll',
    'mantle',
    'celo',
  ]);
  const networkRequiredEnv: Record<string, string[]> = {
    ethereum: ['ETHEREUM_RPC_PRIMARY_URL'],
    arbitrum: ['ARBITRUM_RPC_PRIMARY_URL'],
    base: ['BASE_RPC_PRIMARY_URL'],
    optimism: ['OPTIMISM_RPC_PRIMARY_URL'],
    polygon: ['POLYGON_RPC_PRIMARY_URL'],
    bnb: ['BNB_RPC_PRIMARY_URL'],
    avalanche: ['AVALANCHE_RPC_PRIMARY_URL'],
    zksync: ['ZKSYNC_RPC_PRIMARY_URL'],
    linea: ['LINEA_RPC_PRIMARY_URL'],
    scroll: ['SCROLL_RPC_PRIMARY_URL'],
    mantle: ['MANTLE_RPC_PRIMARY_URL'],
    celo: ['CELO_RPC_PRIMARY_URL'],
    solana: [
      'SOLANA_RPC_PRIMARY_URL',
      'SOLANA_WITHDRAWAL_HOT_ADDRESS',
      'PRIVY_SOLANA_WALLET_ID',
      'PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64',
    ],
    bitcoin: ['BITCOIN_WITHDRAWAL_WIF', 'BITCOIN_WITHDRAWAL_HOT_ADDRESS'],
    tron: process.env.PRIVY_TRON_WALLET_ID
      ? [
          'TRON_RPC_PRIMARY_URL',
          'PRIVY_TRON_WALLET_ID',
          'PRIVY_TRON_POLICY_ID',
          'TRON_WITHDRAWAL_HOT_ADDRESS',
          'PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64',
        ]
      : ['TRON_RPC_PRIMARY_URL', 'TRON_WITHDRAWAL_PRIVATE_KEY', 'TRON_WITHDRAWAL_HOT_ADDRESS'],
  };
  const missing = new Set<string>();
  const invalid: string[] = [];
  const unknownNetworks = networks.filter((network) => !networkRequiredEnv[network]);

  if (process.env.MAINNET_ENABLED !== 'true') {
    invalid.push('MAINNET_ENABLED must be true');
  }

  for (const network of networks) {
    for (const envName of networkRequiredEnv[network] ?? []) {
      if (!envValue(envName)) {
        missing.add(envName);
      }
    }
    if (network === 'bitcoin' && !envValue('BITCOIN_RPC_PRIMARY_URL') && !envValue('BITCOIN_EXPLORER_URL')) {
      missing.add('BITCOIN_RPC_PRIMARY_URL or BITCOIN_EXPLORER_URL');
    }
  }

  if (networks.some((network) => evmNetworks.has(network))) {
    for (const envName of [
      'WITHDRAWAL_HOT_ADDRESS',
      'DEPOSIT_TREASURY_ADDRESS',
      'PRIVY_SERVER_WALLET_ID',
      'PRIVY_DEPOSIT_TREASURY_WALLET_ID',
    ]) {
      if (!envValue(envName)) {
        missing.add(envName);
      }
    }
    if (process.env.PRIVY_CUSTODY_ENABLED !== 'true') {
      invalid.push('PRIVY_CUSTODY_ENABLED must be true for EVM mainnet custody');
    }
  }
  if (networks.includes('solana') && process.env.PRIVY_CUSTODY_ENABLED !== 'true') {
    invalid.push('PRIVY_CUSTODY_ENABLED must be true for Solana mainnet custody');
  }

  for (const envName of [
    'ETHEREUM_RPC_PRIMARY_URL',
    'ARBITRUM_RPC_PRIMARY_URL',
    'BASE_RPC_PRIMARY_URL',
    'OPTIMISM_RPC_PRIMARY_URL',
    'POLYGON_RPC_PRIMARY_URL',
    'BNB_RPC_PRIMARY_URL',
    'AVALANCHE_RPC_PRIMARY_URL',
    'ZKSYNC_RPC_PRIMARY_URL',
    'LINEA_RPC_PRIMARY_URL',
    'SCROLL_RPC_PRIMARY_URL',
    'MANTLE_RPC_PRIMARY_URL',
    'CELO_RPC_PRIMARY_URL',
    'SOLANA_RPC_PRIMARY_URL',
    'BITCOIN_RPC_PRIMARY_URL',
    'BITCOIN_EXPLORER_URL',
    'TRON_RPC_PRIMARY_URL',
  ]) {
    const value = envValue(envName);
    if (value && /sepolia|testnet|amoy|fuji|devnet|nile|shasta|signet/i.test(value)) {
      invalid.push(`${envName} appears to point to a testnet/devnet endpoint`);
    }
  }

  if (unknownNetworks.length > 0 || missing.size > 0 || invalid.length > 0) {
    throw new Error(
      [
        'Mainnet seed env is incomplete.',
        unknownNetworks.length > 0 ? `Unknown networks: ${unknownNetworks.join(', ')}` : null,
        missing.size > 0 ? `Missing env: ${[...missing].sort().join(', ')}` : null,
        invalid.length > 0 ? `Invalid env: ${invalid.sort().join(', ')}` : null,
      ].filter(Boolean).join(' '),
    );
  }
}

function envValue(name: string): string {
  return (process.env[name] ?? '').trim();
}

function enabledMainnetNetworkKeys(): Set<string> {
  return new Set(
    (process.env.MAINNET_ENABLED_NETWORKS ?? '')
      .split(',')
      .map((network) => network.trim().toLowerCase())
      .filter(Boolean),
  );
}

function assetIconUrl(symbol: string): string | null {
  const icons: Record<string, string> = {
    ARB: 'https://assets.coingecko.com/coins/images/16547/large/arb.jpg',
    AVAX: 'https://assets.coingecko.com/coins/images/12559/large/Avalanche_Circle_RedWhite_Trans.png',
    BNB: 'https://assets.coingecko.com/coins/images/825/large/bnb-icon2_2x.png',
    BTC: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
    ETH: 'https://assets.coingecko.com/coins/images/279/large/ethereum.png',
    POL: 'https://assets.coingecko.com/coins/images/32440/large/polygon.png',
    SOL: 'https://assets.coingecko.com/coins/images/4128/large/solana.png',
    TRX: 'https://assets.coingecko.com/coins/images/1094/large/tron-logo.png',
    USDC: 'https://assets.coingecko.com/coins/images/6319/large/usdc.png',
    USDT: 'https://assets.coingecko.com/coins/images/325/large/Tether.png',
    WBTC: 'https://assets.coingecko.com/coins/images/7598/large/wrapped_bitcoin_wbtc.png',
    WETH: 'https://assets.coingecko.com/coins/images/2518/large/weth.png',
  };
  return icons[symbol.toUpperCase()] ?? null;
}

function networkIconUrl(chainKey: string): string | null {
  const icons: Record<string, string> = {
    arbitrum: 'https://icons.llamao.fi/icons/chains/rsz_arbitrum.jpg',
    'arbitrum-sepolia': 'https://icons.llamao.fi/icons/chains/rsz_arbitrum.jpg',
    avalanche: 'https://icons.llamao.fi/icons/chains/rsz_avalanche.jpg',
    'avalanche-fuji': 'https://icons.llamao.fi/icons/chains/rsz_avalanche.jpg',
    base: 'https://icons.llamao.fi/icons/chains/rsz_base.jpg',
    'base-sepolia': 'https://icons.llamao.fi/icons/chains/rsz_base.jpg',
    bitcoin: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
    'bitcoin-signet': 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png',
    bnb: 'https://icons.llamao.fi/icons/chains/rsz_bsc.jpg',
    'bnb-testnet': 'https://icons.llamao.fi/icons/chains/rsz_bsc.jpg',
    ethereum: 'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg',
    'ethereum-sepolia': 'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg',
    celo: 'https://icons.llamao.fi/icons/chains/rsz_celo.jpg',
    'celo-alfajores': 'https://icons.llamao.fi/icons/chains/rsz_celo.jpg',
    linea: 'https://icons.llamao.fi/icons/chains/rsz_linea.jpg',
    'linea-sepolia': 'https://icons.llamao.fi/icons/chains/rsz_linea.jpg',
    mantle: 'https://icons.llamao.fi/icons/chains/rsz_mantle.jpg',
    'mantle-sepolia': 'https://icons.llamao.fi/icons/chains/rsz_mantle.jpg',
    optimism: 'https://icons.llamao.fi/icons/chains/rsz_optimism.jpg',
    'optimism-sepolia': 'https://icons.llamao.fi/icons/chains/rsz_optimism.jpg',
    polygon: 'https://icons.llamao.fi/icons/chains/rsz_polygon.jpg',
    'polygon-amoy': 'https://icons.llamao.fi/icons/chains/rsz_polygon.jpg',
    scroll: 'https://icons.llamao.fi/icons/chains/rsz_scroll.jpg',
    'scroll-sepolia': 'https://icons.llamao.fi/icons/chains/rsz_scroll.jpg',
    solana: 'https://icons.llamao.fi/icons/chains/rsz_solana.jpg',
    'solana-devnet': 'https://icons.llamao.fi/icons/chains/rsz_solana.jpg',
    tron: 'https://icons.llamao.fi/icons/chains/rsz_tron.jpg',
    'tron-nile': 'https://icons.llamao.fi/icons/chains/rsz_tron.jpg',
    'tron-shasta': 'https://icons.llamao.fi/icons/chains/rsz_tron.jpg',
    zksync: 'https://icons.llamao.fi/icons/chains/rsz_zksync-era.jpg',
    'zksync-sepolia': 'https://icons.llamao.fi/icons/chains/rsz_zksync-era.jpg',
  };
  return icons[chainKey] ?? null;
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
