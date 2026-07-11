export type Balance = {
  address: string;
  token?: string;
  value: string;
};

export type Tx = {
  hash: string;
  blockNumber?: number;
  from?: string;
  to?: string | null;
  value?: string;
  status?: number;
  blockHash?: string;
  logs?: RpcLog[];
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
};

export type BlockTransaction = {
  hash: string;
  blockNumber: number;
  from?: string;
  to?: string | null;
  value: string;
};

export type BlockWithTransactions = {
  number: number;
  transactions: BlockTransaction[];
};

export type LogFilter = {
  networkKey?: string;
  address?: string;
  topics?: Array<string | string[] | null>;
  fromBlock?: number | string;
  toBlock?: number | string;
};

export type RpcLog = {
  address: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  data: string;
  topics: string[];
};

export interface RpcProvider {
  getChainId(networkKey?: string): Promise<number>;
  getCode(address: string, networkKey?: string): Promise<string>;
  getErc20Metadata(address: string, networkKey?: string): Promise<{ symbol: string; decimals: number }>;
  getBalance(
    address: string,
    token?: string,
    networkKey?: string,
    tokenDecimals?: number,
  ): Promise<Balance>;
  getTransaction(txHash: string, networkKey?: string): Promise<Tx>;
  getBlockWithTransactions(blockNumber: number, networkKey?: string): Promise<BlockWithTransactions>;
  getLogs(filter: LogFilter): Promise<RpcLog[]>;
  getLatestBlockNumber(networkKey?: string): Promise<number>;
  sendTransaction(signedTx: string, networkKey?: string): Promise<string>;
  verifyMessage(input: {
    address: string;
    message: string;
    signature: string;
  }): Promise<boolean>;
}
