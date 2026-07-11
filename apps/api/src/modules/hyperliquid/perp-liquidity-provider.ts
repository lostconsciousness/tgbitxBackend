import { OrderSide, OrderType } from '@prisma/client';

export type ProviderOrderInput = {
  providerSymbol: string;
  cloid: `0x${string}`;
  side: OrderSide;
  type: OrderType;
  size: string;
  price: string;
  triggerPrice?: string;
  reduceOnly: boolean;
};

export type ProviderOrderResult = {
  providerOrderId?: string;
  status: 'OPEN' | 'FILLED' | 'PENDING' | 'REJECTED';
  filledSize?: string;
  averagePrice?: string;
  reason?: string;
  raw: unknown;
};

export type ProviderOrderSnapshot = {
  status: 'UNKNOWN' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  providerOrderId?: string;
  originalSize?: string;
  remainingSize?: string;
  reason?: string;
  raw: unknown;
};

export type ProviderFillResult = {
  providerFillId: string;
  providerOrderId: string;
  price: string;
  size: string;
  feeAmount: string;
  occurredAt: Date;
  raw: unknown;
};

export type ProviderReadiness = {
  ready: boolean;
  reasons: string[];
  accountValue?: string;
  masterAddressConfigured: boolean;
  agentAddressConfigured: boolean;
  agentRegistered: boolean;
};

export interface PerpLiquidityProvider {
  isExecutionEnabled(): boolean;
  placeOrder(input: ProviderOrderInput): Promise<ProviderOrderResult>;
  cancelOrder(input: {
    providerSymbol: string;
    providerOrderId?: string;
    cloid?: `0x${string}`;
  }): Promise<void>;
  getOrderSnapshot(cloid: `0x${string}`): Promise<ProviderOrderSnapshot>;
  getOrderFills(cloid: `0x${string}`): Promise<ProviderFillResult[]>;
  getReadiness(): Promise<ProviderReadiness>;
  getAccountState(): Promise<unknown>;
  getOpenOrders(): Promise<unknown>;
  getFills(): Promise<unknown>;
}
