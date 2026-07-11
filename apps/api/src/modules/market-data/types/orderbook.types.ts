export type OrderBookLevel = {
  price: string;
  size: string;
  orders: number;
};

export type OrderBookSnapshot = {
  symbol: string;
  provider: string;
  providerSymbol: string;
  time: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
};

export type OrderBookSubscriptionPayload = {
  symbol: string;
};
