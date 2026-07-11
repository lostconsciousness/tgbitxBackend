type HyperliquidFormatUtils = {
  formatPrice: (price: string | number, szDecimals: number, type?: 'perp' | 'spot') => string;
  formatSize: (size: string | number, szDecimals: number) => string;
};

// Package subpath export; resolved at runtime by Node, not by TS moduleResolution "node".
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hyperliquidFormat = require('@nktkas/hyperliquid/utils') as HyperliquidFormatUtils;

export function formatHyperliquidPrice(price: string, szDecimals: number): string {
  return hyperliquidFormat.formatPrice(price, szDecimals);
}

export function formatHyperliquidSize(size: string, szDecimals: number): string {
  return hyperliquidFormat.formatSize(size, szDecimals);
}
