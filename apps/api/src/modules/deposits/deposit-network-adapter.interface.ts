import { Chain, TokenStandard } from '@prisma/client';

export type DepositAdapterTarget = {
  network: Chain;
  assetSymbol: string;
  tokenStandard: TokenStandard;
};

export type DetectedDeposit = {
  txHash: string;
  outputIndex?: number;
  logIndex?: number;
  fromAddress?: string;
  toAddress: string;
  rawAmount: string;
  blockNumber?: number;
  confirmations: number;
};

export interface DepositNetworkAdapter {
  readonly family: 'EVM' | 'SVM' | 'UTXO' | 'TVM';
  provisionAddress(input: {
    userId: string;
    target: DepositAdapterTarget;
  }): Promise<{ address: string; memo?: string | null; tag?: string | null }>;
  scanDeposits(input: {
    target: DepositAdapterTarget;
    fromBlock: number;
    toBlock?: number;
  }): Promise<DetectedDeposit[]>;
}

export interface WithdrawalNetworkAdapter {
  readonly family: 'EVM' | 'SVM' | 'UTXO' | 'TVM';
  broadcastWithdrawal(input: {
    target: DepositAdapterTarget;
    toAddress: string;
    rawAmount: string;
    referenceId: string;
  }): Promise<{ txHash: string; providerRequestId?: string }>;
}
