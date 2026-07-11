import { TokenStandard } from '@prisma/client';
import { Prisma } from '@prisma/client';

/** Reference on-chain gas cost multiplier (for estimatedNetworkCostUsd display). */
export const WITHDRAWAL_NETWORK_COST_MARKUP = 1.2;

/** Exchange margin on top of network cost (~20% platform revenue). */
export const WITHDRAWAL_PLATFORM_MARGIN = 1.2;

/** Combined markup used in gas-cost estimates (network × platform). */
export const WITHDRAWAL_FEE_MARKUP =
  WITHDRAWAL_NETWORK_COST_MARKUP * WITHDRAWAL_PLATFORM_MARGIN;

const ERC20_TRANSFER_GAS = 65_000n;
const NATIVE_TRANSFER_GAS = 21_000n;

/** Conservative reference gas prices (gwei) for fee breakdown display. */
const REFERENCE_GAS_GWEI: Record<string, number> = {
  bnb: 3,
  arbitrum: 0.12,
  base: 0.05,
  optimism: 0.05,
  polygon: 30,
  avalanche: 25,
  ethereum: 12,
};

/** Rough USD reference for native gas (display only). */
const REFERENCE_NATIVE_USD: Record<string, number> = {
  BNB: 600,
  ETH: 3_000,
  POL: 0.35,
  AVAX: 35,
  TRX: 0.25,
  SOL: 150,
};

/**
 * Network withdrawal fees charged to the user in the same asset (ledger GAS_FEES).
 * Covers on-chain gas + ~20% platform margin (WITHDRAWAL_PLATFORM_MARGIN).
 * Values are rounded up for clean UI (e.g. 0.75 USDT on L2, 1 USDT on BSC).
 */
export const WITHDRAWAL_FEE_POLICY: Record<string, Record<string, string>> = {
  USDT: {
    bnb: '1',
    arbitrum: '0.75',
    base: '0.75',
    optimism: '0.75',
    polygon: '0.75',
    avalanche: '1',
    ethereum: '3',
    tron: '1.5',
  },
  USDC: {
    bnb: '1',
    arbitrum: '0.75',
    base: '0.75',
    optimism: '0.75',
    polygon: '0.75',
    avalanche: '1',
    ethereum: '3',
  },
  ETH: {
    arbitrum: '0.0004',
    base: '0.0003',
    optimism: '0.0003',
    ethereum: '0.0018',
  },
  BNB: {
    bnb: '0.00036',
  },
  SOL: {
    solana: '0.01',
  },
  TRX: {
    tron: '1.8',
  },
};

export type WithdrawalFeeBreakdown = {
  /** Flat network fee deducted from the user's balance (same asset as withdrawal). */
  withdrawalFeeAmount: string;
  estimatedNetworkCostUsd: string | null;
  referenceMarketFee: string | null;
  /** False = user pays network fee via withdrawalFeeAmount (standard CEX model). */
  gasPaidByExchange: boolean;
};

function nativeGasSymbolForNetwork(networkKey: string): string {
  const key = networkKey.toLowerCase();
  if (key === 'bnb' || key === 'bnb-testnet') return 'BNB';
  if (key.startsWith('tron')) return 'TRX';
  if (key.startsWith('solana')) return 'SOL';
  if (key === 'polygon' || key === 'polygon-amoy') return 'POL';
  if (key.startsWith('avalanche')) return 'AVAX';
  return 'ETH';
}

function isStablecoinSymbol(symbol: string): boolean {
  return symbol === 'USDT' || symbol === 'USDC';
}

export function lookupPolicyWithdrawalFee(
  assetSymbol: string,
  networkKey: string,
): string | null {
  const byAsset = WITHDRAWAL_FEE_POLICY[assetSymbol.toUpperCase()];
  if (!byAsset) {
    return null;
  }
  return byAsset[networkKey.toLowerCase()] ?? null;
}

export function resolveWithdrawalFeeAmount(input: {
  assetSymbol: string;
  networkKey: string;
  configuredAmount: Prisma.Decimal | string | number;
}): Prisma.Decimal {
  const configured = new Prisma.Decimal(input.configuredAmount.toString());
  const policy = lookupPolicyWithdrawalFee(input.assetSymbol, input.networkKey);
  if (policy) {
    return new Prisma.Decimal(policy);
  }
  return configured;
}

function estimateEvmGasCostUsd(
  networkKey: string,
  isNative: boolean,
  nativePricesUsd?: Partial<Record<string, string>>,
): Prisma.Decimal | null {
  const gasGwei = REFERENCE_GAS_GWEI[networkKey.toLowerCase()];
  if (!gasGwei) {
    return null;
  }
  const gasUnits = isNative ? NATIVE_TRANSFER_GAS : ERC20_TRANSFER_GAS;
  const nativeSymbol = nativeGasSymbolForNetwork(networkKey);
  const liveNativeUsd = nativePricesUsd?.[nativeSymbol];
  const nativeUsd = liveNativeUsd
    ? Number(liveNativeUsd)
    : REFERENCE_NATIVE_USD[nativeSymbol];
  if (!nativeUsd) {
    return null;
  }
  const nativeCost =
    (Number(gasUnits) * gasGwei) / 1e9;
  const usd = nativeCost * nativeUsd * WITHDRAWAL_FEE_MARKUP;
  return new Prisma.Decimal(usd.toFixed(4));
}

export function buildWithdrawalFeeBreakdown(input: {
  assetSymbol: string;
  networkKey: string;
  configuredAmount: Prisma.Decimal | string | number;
  tokenStandard: TokenStandard;
  nativePricesUsd?: Partial<Record<string, string>>;
}): WithdrawalFeeBreakdown {
  const fee = resolveWithdrawalFeeAmount({
    assetSymbol: input.assetSymbol,
    networkKey: input.networkKey,
    configuredAmount: input.configuredAmount,
  });
  const isNative =
    input.tokenStandard === TokenStandard.NATIVE ||
    input.tokenStandard === TokenStandard.BTC;
  const isStable = isStablecoinSymbol(input.assetSymbol);

  let estimatedNetworkCostUsd: string | null = null;
  if (isStable) {
    estimatedNetworkCostUsd =
      estimateEvmGasCostUsd(input.networkKey, false, input.nativePricesUsd)?.toString() ?? null;
  } else if (isNative) {
    estimatedNetworkCostUsd =
      estimateEvmGasCostUsd(input.networkKey, true, input.nativePricesUsd)?.toString() ?? null;
  }

  const referenceMarketFee = lookupPolicyWithdrawalFee(input.assetSymbol, input.networkKey);

  return {
    withdrawalFeeAmount: fee.toString(),
    estimatedNetworkCostUsd,
    referenceMarketFee,
    gasPaidByExchange: false,
  };
}
