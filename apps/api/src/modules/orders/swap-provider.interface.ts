import { OrderSide } from '@prisma/client';

export type SwapQuoteRequest = {
  symbol: string;
  side: OrderSide;
  size: string;
  slippageBps?: number;
};

export type SwapQuote = {
  provider: string;
  symbol: string;
  side: OrderSide;
  size: string;
  expectedPrice: string;
  expectedNotional: string;
  feeAmount: string;
};

export interface SwapProvider {
  getQuote(request: SwapQuoteRequest): Promise<SwapQuote>;
}
