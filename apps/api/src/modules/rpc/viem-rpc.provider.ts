import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Address,
  Hex,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  hashMessage,
  hexToNumber,
  parseAbi,
  verifyMessage,
} from 'viem';
import {
  Balance,
  BalanceRequest,
  LogFilter,
  RpcLog,
  RpcProvider,
  Tx,
} from './rpc-provider.interface';

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
const ERC1271_ABI = parseAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);
const ERC1271_MAGIC_VALUE = '0x1626ba7e';
const MULTICALL3_ADDRESS = getAddress('0xcA11bde05977b3631167028862bE2a173976CA11');
const MULTICALL3_ABI = parseAbi([
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);

type JsonRpcResponse<T> = {
  result?: T;
  error?: {
    code: number;
    message: string;
  };
};

type RawTransaction = {
  hash: Hex;
  blockNumber?: Hex | null;
  from?: Address;
  to?: Address | null;
  value?: Hex;
};

type RawBlockWithTransactions = {
  number: Hex;
  transactions: RawTransaction[];
};

type RawReceipt = {
  status?: Hex;
  blockHash?: Hex;
  logs?: RawLog[];
  gasUsed?: Hex;
  effectiveGasPrice?: Hex;
};

type RawLog = {
  address: Address;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  data: Hex;
  topics: Hex[];
};

export class ViemRpcProvider implements RpcProvider {
  private readonly rpcCooldownUntil = new Map<string, number>();
  private readonly latestBlockCache = new Map<
    string,
    { expiresAt: number; value: Promise<number> }
  >();
  private readonly erc20DecimalsCache = new Map<string, Promise<number>>();

  constructor(private readonly config: ConfigService) {}

  async getChainId(networkKey?: string): Promise<number> {
    return hexToNumber(await this.requestRpc<Hex>('eth_chainId', [], networkKey));
  }

  async getCode(address: string, networkKey?: string): Promise<string> {
    return this.requestRpc<Hex>('eth_getCode', [getAddress(address), 'latest'], networkKey);
  }

  async getErc20Metadata(
    address: string,
    networkKey?: string,
  ): Promise<{ symbol: string; decimals: number }> {
    const tokenAddress = getAddress(address);
    const [symbol, decimals] = await Promise.all([
      this.readErc20Symbol(tokenAddress, networkKey),
      this.readErc20Decimals(tokenAddress, networkKey),
    ]);
    return { symbol, decimals };
  }

  async getBalance(
    address: string,
    token?: string,
    networkKey?: string,
    tokenDecimals?: number,
  ): Promise<Balance> {
    const normalizedAddress = getAddress(address);
    if (token) {
      const tokenAddress = getAddress(token);
      const rawBalance = await this.readErc20Balance(
        tokenAddress,
        normalizedAddress,
        networkKey,
      );
      const decimals =
        tokenDecimals ?? (await this.readErc20Decimals(tokenAddress, networkKey));

      return {
        address: normalizedAddress,
        token: tokenAddress,
        value: formatUnits(rawBalance, decimals),
      };
    }

    const value = await this.requestRpc<Hex>('eth_getBalance', [normalizedAddress, 'latest'], networkKey);
    return {
      address: normalizedAddress,
      value: BigInt(value).toString(),
    };
  }

  async getBalances(
    address: string,
    requests: BalanceRequest[],
    networkKey?: string,
  ): Promise<Balance[]> {
    const owner = getAddress(address);
    if (requests.length === 0) return [];
    try {
      const calls = requests.map((request) =>
        request.token
          ? {
              target: getAddress(request.token),
              allowFailure: true,
              callData: encodeFunctionData({
                abi: ERC20_ABI,
                functionName: 'balanceOf',
                args: [owner],
              }),
            }
          : {
              target: MULTICALL3_ADDRESS,
              allowFailure: true,
              callData: encodeFunctionData({
                abi: MULTICALL3_ABI,
                functionName: 'getEthBalance',
                args: [owner],
              }),
            },
      );
      const data = encodeFunctionData({
        abi: MULTICALL3_ABI,
        functionName: 'aggregate3',
        args: [calls],
      });
      const raw = await this.requestRpc<Hex>(
        'eth_call',
        [{ to: MULTICALL3_ADDRESS, data }, 'latest'],
        networkKey,
      );
      const results = decodeFunctionResult({
        abi: MULTICALL3_ABI,
        functionName: 'aggregate3',
        data: raw,
      });
      return Promise.all(results.map(async (result, index) => {
        const request = requests[index];
        if (!result.success) {
          return this.getBalance(
            owner,
            request?.token,
            networkKey,
            request?.tokenDecimals,
          );
        }
        if (!request?.token) {
          const value = decodeFunctionResult({
            abi: MULTICALL3_ABI,
            functionName: 'getEthBalance',
            data: result.returnData,
          });
          return { address: owner, value: value.toString() };
        }
        const value = decodeFunctionResult({
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          data: result.returnData,
        });
        return {
          address: owner,
          token: getAddress(request.token),
          value: formatUnits(value, request.tokenDecimals ?? 18),
        };
      }));
    } catch (_error) {
      return Promise.all(
        requests.map((request) =>
          this.getBalance(
            owner,
            request.token,
            networkKey,
            request.tokenDecimals,
          ),
        ),
      );
    }
  }

  async getTransaction(txHash: string, networkKey?: string): Promise<Tx> {
    const tx = await this.requestRpc<RawTransaction | null>(
      'eth_getTransactionByHash',
      [txHash],
      networkKey,
    );
    const receipt = await this.requestRpc<RawReceipt | null>(
      'eth_getTransactionReceipt',
      [txHash],
      networkKey,
    );

    if (!tx) {
      throw new ServiceUnavailableException('Transaction was not found by configured RPC providers');
    }

    return {
      hash: tx.hash,
      blockNumber: tx.blockNumber ? hexToNumber(tx.blockNumber) : undefined,
      from: tx.from,
      to: tx.to,
      value: tx.value ? BigInt(tx.value).toString() : undefined,
      status: receipt?.status ? hexToNumber(receipt.status) : undefined,
      blockHash: receipt?.blockHash,
      gasUsed: receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined,
      effectiveGasPrice: receipt?.effectiveGasPrice
        ? BigInt(receipt.effectiveGasPrice)
        : undefined,
      logs: receipt?.logs?.map((log) => ({
        address: log.address,
        blockNumber: hexToNumber(log.blockNumber),
        transactionHash: log.transactionHash,
        logIndex: hexToNumber(log.logIndex),
        data: log.data,
        topics: [...log.topics],
      })),
    };
  }

  async getBlockWithTransactions(blockNumber: number, networkKey?: string) {
    const block = await this.requestRpc<RawBlockWithTransactions | null>(
      'eth_getBlockByNumber',
      [`0x${blockNumber.toString(16)}`, true],
      networkKey,
    );
    if (!block) {
      throw new ServiceUnavailableException('Block was not found by configured RPC providers');
    }
    const parsedBlockNumber = hexToNumber(block.number);
    return {
      number: parsedBlockNumber,
      transactions: block.transactions.map((tx) => ({
        hash: tx.hash,
        blockNumber: tx.blockNumber ? hexToNumber(tx.blockNumber) : parsedBlockNumber,
        from: tx.from,
        to: tx.to,
        value: tx.value ? BigInt(tx.value).toString() : '0',
      })),
    };
  }

  async getLogs(filter: LogFilter): Promise<RpcLog[]> {
    const rawLogs = await this.requestRpc<RawLog[]>('eth_getLogs', [
      {
        address: filter.address,
        topics: filter.topics,
        fromBlock: this.blockTagToRpc(filter.fromBlock),
        toBlock: this.blockTagToRpc(filter.toBlock),
      },
    ], filter.networkKey);

    return rawLogs.map((log) => ({
      address: log.address,
      blockNumber: hexToNumber(log.blockNumber),
      transactionHash: log.transactionHash,
      logIndex: hexToNumber(log.logIndex),
      data: log.data,
      topics: [...log.topics],
    }));
  }

  async getLatestBlockNumber(networkKey?: string): Promise<number> {
    const key = networkKey?.trim().toLowerCase() ?? '__default__';
    const cached = this.latestBlockCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const value = this.requestRpc<Hex>('eth_blockNumber', [], networkKey)
      .then((blockNumber) => hexToNumber(blockNumber));
    this.latestBlockCache.set(key, { expiresAt: Date.now() + 2_000, value });
    try {
      return await value;
    } catch (error) {
      this.latestBlockCache.delete(key);
      throw error;
    }
  }

  sendTransaction(signedTx: string, networkKey?: string): Promise<string> {
    return this.requestRpc<string>('eth_sendRawTransaction', [signedTx], networkKey);
  }

  async verifyMessage(input: {
    address: string;
    message: string;
    signature: string;
  }): Promise<boolean> {
    const address = getAddress(input.address);
    const signature = input.signature as Hex;

    try {
      if (await verifyMessage({ address, message: input.message, signature })) {
        return true;
      }
    } catch (_error) {
      // Contract wallets require an RPC-backed ERC-1271 check.
    }

    try {
      const data = encodeFunctionData({
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        args: [hashMessage(input.message), signature],
      });
      const result = await this.requestRpc<Hex>('eth_call', [{ to: address, data }, 'latest']);
      const magicValue = decodeFunctionResult({
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        data: result,
      });
      return magicValue.toLowerCase() === ERC1271_MAGIC_VALUE;
    } catch (_error) {
      return false;
    }
  }

  private async readErc20Balance(
    tokenAddress: Address,
    owner: Address,
    networkKey?: string,
  ): Promise<bigint> {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner],
    });
    const result = await this.requestRpc<Hex>(
      'eth_call',
      [{ to: tokenAddress, data }, 'latest'],
      networkKey,
    );
    return decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      data: result,
    });
  }

  private async readErc20Decimals(tokenAddress: Address, networkKey?: string): Promise<number> {
    const cacheKey = `${networkKey?.trim().toLowerCase() ?? '__default__'}:${tokenAddress.toLowerCase()}`;
    const cached = this.erc20DecimalsCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const value = this.fetchErc20Decimals(tokenAddress, networkKey);
    this.erc20DecimalsCache.set(cacheKey, value);
    try {
      return await value;
    } catch (error) {
      this.erc20DecimalsCache.delete(cacheKey);
      throw error;
    }
  }

  private async fetchErc20Decimals(tokenAddress: Address, networkKey?: string): Promise<number> {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    const result = await this.requestRpc<Hex>(
      'eth_call',
      [{ to: tokenAddress, data }, 'latest'],
      networkKey,
    );
    return decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: 'decimals',
      data: result,
    });
  }

  private async readErc20Symbol(tokenAddress: Address, networkKey?: string): Promise<string> {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'symbol',
    });
    const result = await this.requestRpc<Hex>(
      'eth_call',
      [{ to: tokenAddress, data }, 'latest'],
      networkKey,
    );
    return decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: 'symbol',
      data: result,
    });
  }

  private blockTagToRpc(block?: number | string): string | undefined {
    if (typeof block === 'number') {
      return `0x${block.toString(16)}`;
    }

    return block;
  }

  private async requestRpc<T>(method: string, params: unknown[], networkKey?: string): Promise<T> {
    const urls = this.orderRpcUrls(networkKey, this.getRpcUrls(networkKey));
    const maxAttempts = this.config.get<number>('RPC_RETRY_ATTEMPTS', 4) ?? 4;
    let lastError: unknown;

    for (const url of urls) {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.config.get<number>('RPC_REQUEST_TIMEOUT_MS', 5_000) ?? 5_000,
        );
        try {
          const response = await fetch(this.normalizeRpcUrl(url), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: Date.now(),
              method,
              params,
            }),
            signal: controller.signal,
          });

          if (response.status === 429) {
            this.markRpcRateLimited(networkKey, url, response.headers.get('retry-after'));
            lastError = new Error('RPC HTTP 429');
            break;
          }

          if (!response.ok) {
            let message = `RPC HTTP ${response.status}`;
            try {
              const errorPayload = (await response.json()) as JsonRpcResponse<T>;
              if (errorPayload.error?.message) {
                message = errorPayload.error.message;
              }
            } catch (_error) {
              // Keep HTTP status fallback when the body is not JSON.
            }
            lastError = new Error(message);
            const blockRangeLimited = /block range|eth_getLogs requests with up to/i.test(message);
            if (response.status >= 500 && attempt < maxAttempts - 1) {
              await this.sleep(Math.min(4_000, 250 * 2 ** attempt));
              continue;
            }
            if (blockRangeLimited) {
              break;
            }
            break;
          }

          const payload = (await response.json()) as JsonRpcResponse<T>;
          if (payload.error) {
            const message = payload.error.message;
            if (/limit exceeded|too many requests|rate limit|compute units per second/i.test(message)) {
              lastError = new Error(message);
              break;
            }
            throw new Error(message);
          }

          if (payload.result === undefined) {
            throw new Error('RPC response did not include result');
          }

          return payload.result;
        } catch (error) {
          lastError = error;
          const switchUrl =
            error instanceof Error &&
            (error.message === 'RPC HTTP 429' ||
              /limit exceeded|too many requests|rate limit|compute units per second/i.test(
                error.message,
              ));
          if (switchUrl) {
            break;
          }
          const retryable =
            error instanceof Error &&
            (error.message.startsWith('RPC HTTP 5') || error.name === 'AbortError');
          if (retryable && attempt < maxAttempts - 1) {
            await this.sleep(Math.min(4_000, 250 * 2 ** attempt));
            continue;
          }
          if (retryable) {
            break;
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ServiceUnavailableException(
          `Configured RPC providers are unavailable${networkKey ? ` for ${networkKey}` : ''}`,
        );
  }

  private orderRpcUrls(networkKey: string | undefined, urls: string[]): string[] {
    const ready = urls.filter((url) => !this.isRpcInCooldown(networkKey, url));
    const cooling = urls.filter((url) => this.isRpcInCooldown(networkKey, url));
    return [...ready, ...cooling];
  }

  private rpcCooldownKey(networkKey: string | undefined, url: string): string {
    return `${networkKey?.trim().toLowerCase() ?? '__default__'}::${url.trim()}`;
  }

  private isRpcInCooldown(networkKey: string | undefined, url: string): boolean {
    const until = this.rpcCooldownUntil.get(this.rpcCooldownKey(networkKey, url));
    return until !== undefined && until > Date.now();
  }

  private markRpcRateLimited(
    networkKey: string | undefined,
    url: string,
    retryAfterHeader: string | null,
  ): void {
    const defaultCooldown =
      this.config.get<number>('RPC_RATE_LIMIT_COOLDOWN_MS', 30_000) ?? 30_000;
    const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;
    const cooldownMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1_000
        : defaultCooldown;
    this.rpcCooldownUntil.set(
      this.rpcCooldownKey(networkKey, url),
      Date.now() + cooldownMs,
    );
  }

  private normalizeRpcUrl(url: string): string {
    return url
      .trim()
      .replace(/^wss:\/\//i, 'https://')
      .replace(/^ws:\/\//i, 'http://');
  }

  private getRpcUrls(networkKey?: string, required = true): string[] {
    const envNames = this.resolveRpcEnvNames(networkKey);
    const urls = envNames
      .map((name) => this.config.get<string>(name))
      .filter((url): url is string => Boolean(url?.trim()))
      .map((url) => this.normalizeRpcUrl(url));

    if (required && urls.length === 0) {
      throw new ServiceUnavailableException(
        `No RPC URL is configured for ${networkKey ?? 'arbitrum'}`,
      );
    }

    return [...new Set(urls)];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private resolveRpcEnvNames(networkKey?: string): string[] {
    const key = networkKey ?? 'arbitrum';
    const mapping: Record<string, string[]> = {
      arbitrum: ['ARBITRUM_RPC_PRIMARY_URL', 'ARBITRUM_RPC_FALLBACK_URL'],
      'arbitrum-sepolia': ['ARBITRUM_RPC_PRIMARY_URL', 'ARBITRUM_RPC_FALLBACK_URL'],
      ethereum: ['ETHEREUM_RPC_PRIMARY_URL', 'ETHEREUM_RPC_FALLBACK_URL'],
      'ethereum-sepolia': [
        'ETHEREUM_SEPOLIA_RPC_PRIMARY_URL',
        'ETHEREUM_SEPOLIA_RPC_FALLBACK_URL',
      ],
      base: ['BASE_RPC_PRIMARY_URL', 'BASE_RPC_FALLBACK_URL'],
      'base-sepolia': ['BASE_SEPOLIA_RPC_PRIMARY_URL', 'BASE_SEPOLIA_RPC_FALLBACK_URL'],
      optimism: ['OPTIMISM_RPC_PRIMARY_URL', 'OPTIMISM_RPC_FALLBACK_URL'],
      'optimism-sepolia': [
        'OPTIMISM_SEPOLIA_RPC_PRIMARY_URL',
        'OPTIMISM_SEPOLIA_RPC_FALLBACK_URL',
      ],
      polygon: ['POLYGON_RPC_PRIMARY_URL', 'POLYGON_RPC_FALLBACK_URL'],
      'polygon-amoy': ['POLYGON_AMOY_RPC_PRIMARY_URL', 'POLYGON_AMOY_RPC_FALLBACK_URL'],
      bnb: ['BNB_RPC_PRIMARY_URL', 'BNB_RPC_FALLBACK_URL'],
      'bnb-testnet': ['BNB_TESTNET_RPC_PRIMARY_URL', 'BNB_TESTNET_RPC_FALLBACK_URL'],
      avalanche: ['AVALANCHE_RPC_PRIMARY_URL', 'AVALANCHE_RPC_FALLBACK_URL'],
      'avalanche-fuji': [
        'AVALANCHE_FUJI_RPC_PRIMARY_URL',
        'AVALANCHE_FUJI_RPC_FALLBACK_URL',
      ],
      zksync: ['ZKSYNC_RPC_PRIMARY_URL', 'ZKSYNC_RPC_FALLBACK_URL'],
      'zksync-sepolia': ['ZKSYNC_SEPOLIA_RPC_PRIMARY_URL', 'ZKSYNC_SEPOLIA_RPC_FALLBACK_URL'],
      linea: ['LINEA_RPC_PRIMARY_URL', 'LINEA_RPC_FALLBACK_URL'],
      'linea-sepolia': ['LINEA_SEPOLIA_RPC_PRIMARY_URL', 'LINEA_SEPOLIA_RPC_FALLBACK_URL'],
      scroll: ['SCROLL_RPC_PRIMARY_URL', 'SCROLL_RPC_FALLBACK_URL'],
      'scroll-sepolia': ['SCROLL_SEPOLIA_RPC_PRIMARY_URL', 'SCROLL_SEPOLIA_RPC_FALLBACK_URL'],
      mantle: ['MANTLE_RPC_PRIMARY_URL', 'MANTLE_RPC_FALLBACK_URL'],
      'mantle-sepolia': ['MANTLE_SEPOLIA_RPC_PRIMARY_URL', 'MANTLE_SEPOLIA_RPC_FALLBACK_URL'],
      celo: ['CELO_RPC_PRIMARY_URL', 'CELO_RPC_FALLBACK_URL'],
      'celo-alfajores': ['CELO_ALFAJORES_RPC_PRIMARY_URL', 'CELO_ALFAJORES_RPC_FALLBACK_URL'],
    };

    const fallback = ['ARBITRUM_RPC_PRIMARY_URL', 'ARBITRUM_RPC_FALLBACK_URL'];
    return mapping[key] ?? fallback;
  }
}
