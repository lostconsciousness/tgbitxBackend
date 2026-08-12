import { createECDH, createPrivateKey, createPublicKey } from 'crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Address, encodeFunctionData, parseAbi } from 'viem';

const ERC20_ABI = parseAbi([
  'function transfer(address recipient, uint256 amount) returns (bool)',
]);

type PrivyReadClient = {
  wallets(): {
    get(walletId: string): Promise<{ address?: string }>;
    list(input: {
      chain_type?: string;
      external_id?: string;
    }): AsyncIterable<{ id: string; address?: string; external_id?: string }>;
    create(input: {
      chain_type: 'ethereum' | 'solana' | 'tron';
      display_name: string;
      external_id: string;
      owner: { public_key: string };
      policy_ids?: string[];
      'privy-idempotency-key': string;
    }): Promise<{ id: string; address?: string; external_id?: string }>;
    rpc(
      walletId: string,
      input: Record<string, unknown>,
    ): Promise<{ method: string; data: { hash: string; transaction_id?: string } }>;
    rawSign(
      walletId: string,
      input: {
        params: { bytes: string; encoding: 'hex'; hash_function: 'sha256' };
        idempotency_key: string;
        authorization_context: { authorization_private_keys: string[] };
      },
    ): Promise<{ signature: string }>;
    ethereum(): {
      signTransaction(
        walletId: string,
        input: {
          idempotency_key: string;
          authorization_context: { authorization_private_keys: string[] };
          params: {
            transaction: {
              chain_id: number;
              nonce: string;
              gas_limit: string;
              gas_price: string;
              to: string;
              value: string;
              data?: `0x${string}`;
              type: 0;
            };
          };
        },
      ): Promise<{ signed_transaction: string }>;
      sendTransaction(
        walletId: string,
        input: {
          caip2: string;
          idempotency_key: string;
          reference_id: string;
          authorization_context: { authorization_private_keys: string[] };
          params: {
            transaction: {
              chain_id: number;
              to: string;
              value: number | string;
              data?: `0x${string}`;
            };
          };
        },
      ): Promise<{
        hash: string;
        transaction_id?: string;
        reference_id?: string | null;
      }>;
    };
    solana(): {
      signAndSendTransaction(
        walletId: string,
        input: {
          caip2: string;
          idempotency_key: string;
          reference_id: string;
          authorization_context: { authorization_private_keys: string[] };
          transaction: string | Uint8Array;
        },
      ): Promise<{
        hash: string;
        transaction_id?: string;
        reference_id?: string | null;
      }>;
    };
  };
  transactions(): {
    get(transactionId: string): Promise<{
      status: string;
      transaction_hash: string | null;
      reference_id?: string | null;
    }>;
  };
  webhooks(): {
    verify(input: {
      payload: string;
      headers: {
        'svix-id': string;
        'svix-timestamp': string;
        'svix-signature': string;
      };
      signing_secret: string;
    }): unknown;
  };
};

type TronUnsignedTransaction = {
  txID?: string;
  raw_data_hex: string;
  raw_data: {
    contract: Array<{
      type: string;
      parameter?: { value?: Record<string, unknown> };
    }>;
    fee_limit?: number;
  };
  signature?: string[];
};

@Injectable()
export class PrivyCustodyService {
  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return Boolean(
      this.config.get<boolean>('PRIVY_CUSTODY_ENABLED', false) &&
      this.config.get<string>('PRIVY_APP_ID') &&
      this.config.get<string>('PRIVY_APP_SECRET') &&
      this.config.get<string>('PRIVY_SERVER_WALLET_ID') &&
      this.config.get<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64'),
    );
  }

  isDepositProvisioningEnabled(): boolean {
    const authorizationKey = this.config.get<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64');
    return Boolean(
      this.config.get<boolean>('PRIVY_CUSTODY_ENABLED', false) &&
      this.config.get<string>('PRIVY_APP_ID') &&
      this.config.get<string>('PRIVY_APP_SECRET') &&
      authorizationKey &&
      this.config.get<string>('PRIVY_DEPOSIT_SWEEP_POLICY_ID'),
    );
  }

  private isWalletProvisioningEnabled(): boolean {
    return Boolean(
      this.config.get<boolean>('PRIVY_CUSTODY_ENABLED', false) &&
        this.config.get<string>('PRIVY_APP_ID') &&
        this.config.get<string>('PRIVY_APP_SECRET') &&
        this.config.get<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64'),
    );
  }

  isSolanaEnabled(): boolean {
    return Boolean(
      this.config.get<boolean>('PRIVY_CUSTODY_ENABLED', false) &&
        this.config.get<string>('PRIVY_APP_ID') &&
        this.config.get<string>('PRIVY_APP_SECRET') &&
        this.config.get<string>('PRIVY_SOLANA_WALLET_ID') &&
        this.config.get<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64'),
    );
  }

  isTronEnabled(): boolean {
    return Boolean(
      this.config.get<boolean>('PRIVY_CUSTODY_ENABLED', false) &&
        this.config.get<string>('PRIVY_APP_ID') &&
        this.config.get<string>('PRIVY_APP_SECRET') &&
        this.config.get<string>('PRIVY_TRON_WALLET_ID') &&
        this.config.get<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64'),
    );
  }

  assertSafeAuthorizationConfiguration(chainId?: number): void {
    if (
      !this.config.get<boolean>('PRIVY_CUSTODY_ENABLED', false) ||
      !this.config.get<string>('PRIVY_APP_ID') ||
      !this.config.get<string>('PRIVY_APP_SECRET') ||
      !this.config.get<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64')
    ) {
      throw new ServiceUnavailableException('Privy custody execution is disabled');
    }
    if (
      this.config.get<string>('NODE_ENV', 'development') !== 'development' &&
      !this.config.get<boolean>('PRIVY_PRODUCTION_SIGNING_ENABLED', false)
    ) {
      throw new ServiceUnavailableException(
        'Privy production signing requires PRIVY_PRODUCTION_SIGNING_ENABLED=true',
      );
    }

    const testnetChainIds = new Set([
      97, 300, 5003, 84532, 421614, 43113, 44787, 59141, 80002, 534351,
      11155111, 11155420,
    ]);
    const targetChainId = chainId ?? this.config.get<number>('ONCHAIN_CHAIN_ID', 421614);
    const allowMainnetEnvAuth = this.config.get<boolean>(
      'PRIVY_ENV_AUTHORIZATION_MAINNET_ENABLED',
      false,
    );
    if (!testnetChainIds.has(targetChainId) && !allowMainnetEnvAuth) {
      throw new ServiceUnavailableException(
        'Environment authorization key on mainnet requires PRIVY_ENV_AUTHORIZATION_MAINNET_ENABLED=true',
      );
    }
  }

  async sendErc20(input: {
    tokenAddress: Address;
    recipient: Address;
    rawAmount: bigint;
    referenceId: string;
    chainId?: number;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    this.assertSafeAuthorizationConfiguration(input.chainId);

    const walletId = this.config.getOrThrow<string>('PRIVY_SERVER_WALLET_ID');
    return this.sendErc20FromWallet({ ...input, walletId });
  }

  async sendNative(input: {
    recipient: Address;
    value: bigint;
    referenceId: string;
    chainId?: number;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    this.assertSafeAuthorizationConfiguration(input.chainId);

    const walletId = this.config.getOrThrow<string>('PRIVY_SERVER_WALLET_ID');
    return this.sendFromWallet({ walletId, ...input });
  }

  async getWalletAddress(walletId?: string): Promise<string> {
    const client = await this.createClient();
    const wallet = await client.wallets().get(
      walletId ?? this.config.getOrThrow<string>('PRIVY_SERVER_WALLET_ID'),
    );
    if (!wallet.address) {
      throw new ServiceUnavailableException('Privy wallet address is missing');
    }
    return wallet.address;
  }

  async sendEvmTransaction(input: {
    recipient: Address;
    value: bigint;
    data?: `0x${string}`;
    referenceId: string;
    chainId?: number;
    walletId?: string;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    return this.sendFromWallet({
      walletId:
        input.walletId ?? this.config.getOrThrow<string>('PRIVY_SERVER_WALLET_ID'),
      recipient: input.recipient,
      value: input.value,
      data: input.data,
      referenceId: input.referenceId,
      chainId: input.chainId,
    });
  }

  async createOrGetSolanaWallet(input: {
    externalId: string;
    displayName: string;
    policyId: string;
  }): Promise<{ id: string; address: string }> {
    return this.createOrGetWalletForChain({ ...input, chainType: 'solana' });
  }

  async createOrGetTronWallet(input: {
    externalId: string;
    displayName: string;
    policyId?: string;
  }): Promise<{ id: string; address: string }> {
    return this.createOrGetWalletForChain({ ...input, chainType: 'tron' });
  }

  async sendTronNativeTransfer(input: {
    walletId: string;
    fromAddress: string;
    toAddress: string;
    amountSun: number;
    referenceId: string;
    mainnet?: boolean;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    const tronWeb = await this.createTronWebClient(input.mainnet !== false);
    const unsigned = await tronWeb.transactionBuilder.sendTrx(
      input.toAddress,
      input.amountSun,
      input.fromAddress,
    );
    return this.sendTronTransaction({
      walletId: input.walletId,
      transaction: unsigned as TronUnsignedTransaction,
      fromAddress: input.fromAddress,
      tronWeb,
      referenceId: input.referenceId,
      mainnet: input.mainnet,
    });
  }

  async sendTronTrc20Transfer(input: {
    walletId: string;
    fromAddress: string;
    toAddress: string;
    contractAddress: string;
    rawAmount: bigint;
    referenceId: string;
    feeLimitSun?: number;
    mainnet?: boolean;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    const tronWeb = await this.createTronWebClient(input.mainnet !== false);
    const feeLimit = input.feeLimitSun ?? Number(
      this.config.get<string>('TRON_TRC20_FEE_LIMIT_SUN', '150000000'),
    );
    const unsigned = await tronWeb.transactionBuilder.triggerSmartContract(
      input.contractAddress,
      'transfer(address,uint256)',
      { feeLimit, callValue: 0 },
      [
        { type: 'address', value: input.toAddress },
        { type: 'uint256', value: input.rawAmount.toString() },
      ],
      input.fromAddress,
    );
    const transaction = (unsigned.transaction ?? unsigned) as TronUnsignedTransaction;
    this.assertTronTrc20Transfer({
      transaction,
      fromAddress: input.fromAddress,
      toAddress: input.toAddress,
      contractAddress: input.contractAddress,
      rawAmount: input.rawAmount,
      tronWeb,
    });
    return this.sendTronTransaction({
      walletId: input.walletId,
      transaction,
      fromAddress: input.fromAddress,
      tronWeb,
      referenceId: input.referenceId,
      mainnet: input.mainnet,
    });
  }

  async sendSolanaTransaction(input: {
    transaction: string | Uint8Array;
    referenceId: string;
    walletId?: string;
    mainnet?: boolean;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    this.assertSafeAuthorizationConfiguration(input.mainnet === false ? 0 : 101);
    if (!this.isSolanaEnabled()) {
      throw new ServiceUnavailableException('Privy Solana execution is disabled');
    }
    const walletId =
      input.walletId ?? this.config.getOrThrow<string>('PRIVY_SOLANA_WALLET_ID');
    const client = await this.createClient();
    const response = await client.wallets().solana().signAndSendTransaction(walletId, {
      caip2: input.mainnet === false
        ? 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
        : 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      idempotency_key: input.referenceId,
      reference_id: input.referenceId,
      authorization_context: {
        authorization_private_keys: [this.getAuthorizationPrivateKey()],
      },
      transaction: input.transaction,
    });
    return {
      txHash: response.hash,
      providerRequestId: response.transaction_id ?? response.reference_id ?? undefined,
    };
  }

  async createOrGetWallet(input: {
    externalId: string;
    displayName: string;
    policyId: string;
  }): Promise<{ id: string; address: string }> {
    return this.createOrGetWalletForChain({ ...input, chainType: 'ethereum' });
  }

  async sendTronTransaction(input: {
    transaction: TronUnsignedTransaction;
    fromAddress: string;
    tronWeb?: any;
    referenceId: string;
    walletId?: string;
    mainnet?: boolean;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    this.assertSafeAuthorizationConfiguration(input.mainnet === false ? 0 : 103);
    if (!this.isTronEnabled()) {
      throw new ServiceUnavailableException('Privy Tron execution is disabled');
    }
    const walletId =
      input.walletId ?? this.config.getOrThrow<string>('PRIVY_TRON_WALLET_ID');
    const client = await this.createClient();
    const wallet = await client.wallets().get(walletId);
    if (!wallet.address || wallet.address !== input.fromAddress) {
      throw new ServiceUnavailableException('Privy Tron wallet address does not match transaction owner');
    }
    if (!/^[0-9a-f]+$/i.test(input.transaction.raw_data_hex ?? '') ||
        input.transaction.raw_data_hex.length % 2 !== 0) {
      throw new ServiceUnavailableException('Tron transaction raw_data_hex is missing or invalid');
    }
    const response = await client.wallets().rawSign(walletId, {
      params: {
        bytes: input.transaction.raw_data_hex,
        encoding: 'hex',
        hash_function: 'sha256',
      },
      idempotency_key: `${input.referenceId}:raw-sign`,
      authorization_context: {
        authorization_private_keys: [this.getAuthorizationPrivateKey()],
      },
    });
    const tronWeb = input.tronWeb ?? await this.createTronWebClient(input.mainnet !== false);
    const signature = this.normalizeTronSignature({
      signature: response.signature,
      transaction: input.transaction,
      expectedAddress: input.fromAddress,
      tronWeb,
    });
    const signedTransaction = { ...input.transaction, signature: [signature] };
    const broadcast = await tronWeb.trx.sendRawTransaction(signedTransaction);
    if (!broadcast?.result) {
      const message = this.decodeTronMessage(broadcast?.message);
      if (!/DUP_TRANSACTION/i.test(String(broadcast?.code ?? message))) {
        throw new ServiceUnavailableException(
          `Tron transaction broadcast failed${message ? `: ${message}` : ''}`,
        );
      }
    }
    const txHash = broadcast?.txid ?? broadcast?.transaction?.txID ?? input.transaction.txID;
    if (!txHash || !/^[0-9a-f]{64}$/i.test(txHash)) {
      throw new ServiceUnavailableException('Tron broadcast did not return a valid transaction hash');
    }
    return {
      txHash,
    };
  }

  private async createOrGetWalletForChain(input: {
    externalId: string;
    displayName: string;
    policyId?: string;
    chainType: 'ethereum' | 'solana' | 'tron';
  }): Promise<{ id: string; address: string }> {
    if (!this.isWalletProvisioningEnabled()) {
      throw new ServiceUnavailableException('Privy wallet provisioning is disabled');
    }
    const existing = await this.findWalletByExternalId(input.externalId, input.chainType);
    if (existing) {
      return existing;
    }

    const client = await this.createClient();
    try {
      const wallet = await client.wallets().create({
        chain_type: input.chainType,
        display_name: input.displayName,
        external_id: input.externalId,
        owner: { public_key: this.getAuthorizationPublicKey() },
        ...(input.policyId ? { policy_ids: [input.policyId] } : {}),
        'privy-idempotency-key': input.externalId,
      });
      if (!wallet.address) {
        throw new ServiceUnavailableException('Privy did not return a wallet address');
      }
      return { id: wallet.id, address: wallet.address };
    } catch (error) {
      const recovered = await this.findWalletByExternalId(input.externalId, input.chainType);
      if (recovered) {
        return recovered;
      }
      throw error;
    }
  }

  async findWalletByExternalId(
    externalId: string,
    chainType: 'ethereum' | 'solana' | 'tron' = 'ethereum',
  ): Promise<{ id: string; address: string } | null> {
    const client = await this.createClient();
    for await (const wallet of client.wallets().list({
      chain_type: chainType,
      external_id: externalId,
    })) {
      if (wallet.external_id === externalId && wallet.address) {
        return { id: wallet.id, address: wallet.address };
      }
    }
    return null;
  }

  async sendNativeFromWallet(input: {
    walletId: string;
    recipient: Address;
    value: bigint;
    referenceId: string;
    chainId?: number;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    return this.sendFromWallet({
      walletId: input.walletId,
      recipient: input.recipient,
      value: input.value,
      referenceId: input.referenceId,
      chainId: input.chainId,
    });
  }

  async sendErc20FromWallet(input: {
    walletId: string;
    tokenAddress: Address;
    recipient: Address;
    rawAmount: bigint;
    referenceId: string;
    chainId?: number;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [input.recipient, input.rawAmount],
    });
    return this.sendFromWallet({
      walletId: input.walletId,
      recipient: input.tokenAddress,
      value: 0n,
      data,
      referenceId: input.referenceId,
      chainId: input.chainId,
    });
  }

  async sendNativeFromSweepGas(input: {
    recipient: Address;
    value: bigint;
    referenceId: string;
    chainId?: number;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    const walletId = this.config.getOrThrow<string>('PRIVY_SWEEP_GAS_WALLET_ID');
    return this.sendFromWallet({ walletId, ...input });
  }

  private async sendFromWallet(input: {
    walletId: string;
    recipient: Address;
    value: bigint;
    data?: `0x${string}`;
    referenceId: string;
    chainId?: number;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    this.assertSafeAuthorizationConfiguration(input.chainId);
    const chainId = input.chainId ?? this.config.get<number>('ONCHAIN_CHAIN_ID', 421614);
    if (chainId === 56) {
      return this.signAndBroadcastBnbTransaction({ ...input, chainId });
    }
    const client = await this.createClient();
    const response = await client.wallets().ethereum().sendTransaction(input.walletId, {
      caip2: `eip155:${chainId}`,
      idempotency_key: input.referenceId,
      reference_id: input.referenceId,
      authorization_context: {
        authorization_private_keys: [this.getAuthorizationPrivateKey()],
      },
      params: {
        transaction: {
          chain_id: chainId,
          to: input.recipient,
          value: `0x${input.value.toString(16)}`,
          ...(input.data ? { data: input.data } : {}),
        },
      },
    });
    return {
      txHash: response.hash.toLowerCase(),
      providerRequestId: response.transaction_id ?? response.reference_id ?? undefined,
    };
  }

  private async signAndBroadcastBnbTransaction(input: {
    walletId: string;
    recipient: Address;
    value: bigint;
    data?: `0x${string}`;
    referenceId: string;
    chainId: number;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    const client = await this.createClient();
    const wallet = await client.wallets().get(input.walletId);
    if (!wallet.address) {
      throw new ServiceUnavailableException('Privy BNB wallet address is missing');
    }
    const transaction = {
      from: wallet.address,
      to: input.recipient,
      value: `0x${input.value.toString(16)}`,
      ...(input.data ? { data: input.data } : {}),
    };
    const [nonce, gasPrice, estimatedGas] = await Promise.all([
      this.requestBnbRpc<string>('eth_getTransactionCount', [wallet.address, 'pending']),
      this.requestBnbRpc<string>('eth_gasPrice', []),
      this.requestBnbRpc<string>('eth_estimateGas', [transaction]),
    ]);
    const gasLimit = (BigInt(estimatedGas) * 120n + 99n) / 100n;
    const signed = await client.wallets().ethereum().signTransaction(input.walletId, {
      idempotency_key: `${input.referenceId}:sign`,
      authorization_context: {
        authorization_private_keys: [this.getAuthorizationPrivateKey()],
      },
      params: {
        transaction: {
          chain_id: input.chainId,
          nonce,
          gas_limit: `0x${gasLimit.toString(16)}`,
          gas_price: gasPrice,
          to: input.recipient,
          value: `0x${input.value.toString(16)}`,
          ...(input.data ? { data: input.data } : {}),
          type: 0,
        },
      },
    });
    const txHash = await this.requestBnbRpc<string>('eth_sendRawTransaction', [
      signed.signed_transaction,
    ]);
    return { txHash: txHash.toLowerCase() };
  }

  private async requestBnbRpc<T>(method: string, params: unknown[]): Promise<T> {
    const urls = [
      this.config.get<string>('BNB_RPC_PRIMARY_URL', ''),
      this.config.get<string>('BNB_RPC_FALLBACK_URL', ''),
    ].filter((url, index, all): url is string => Boolean(url) && all.indexOf(url) === index);
    let lastError = 'BNB RPC is not configured';
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(10_000),
        });
        const payload = await response.json() as {
          result?: T;
          error?: { code?: number; message?: string };
        };
        if (!response.ok || payload.error || payload.result === undefined) {
          throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
        }
        return payload.result;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'unknown RPC error';
      }
    }
    throw new ServiceUnavailableException(`BNB RPC ${method} failed: ${lastError}`);
  }

  async assertConfiguredWalletAddress(expectedAddress: string): Promise<void> {
    this.assertSafeAuthorizationConfiguration();
    const client = await this.createClient();
    const wallet = await client.wallets().get(
      this.config.getOrThrow<string>('PRIVY_SERVER_WALLET_ID'),
    );
    if (!wallet.address || wallet.address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new ServiceUnavailableException('Privy wallet ID does not match withdrawal hot address');
    }
  }

  async getTransaction(providerTransactionId: string): Promise<{
    status: string;
    txHash?: string;
    referenceId?: string;
  }> {
    const client = await this.createClient();
    const transaction = await client.transactions().get(providerTransactionId);
    return {
      status: transaction.status,
      txHash: transaction.transaction_hash?.toLowerCase(),
      referenceId: transaction.reference_id ?? undefined,
    };
  }

  async verifyWebhook(input: {
    rawBody: string;
    id: string;
    timestamp: string;
    signature: string;
  }): Promise<Record<string, unknown>> {
    const secret = this.config.get<string>('PRIVY_WEBHOOK_SIGNING_SECRET');
    if (!secret) {
      throw new ServiceUnavailableException('Privy webhook signing secret is not configured');
    }
    const client = await this.createClient();
    return client.webhooks().verify({
      payload: input.rawBody,
      headers: {
        'svix-id': input.id,
        'svix-timestamp': input.timestamp,
        'svix-signature': input.signature,
      },
      signing_secret: secret,
    }) as unknown as Record<string, unknown>;
  }

  private async createClient(): Promise<PrivyReadClient> {
    const privyModule = await this.dynamicImport('@privy-io/node') as {
      PrivyClient: new (options: {
        appId: string;
        appSecret: string;
        apiUrl?: string;
        requestExpiry?: { defaultMs: number; defaultIntentMs: number };
      }) => PrivyReadClient;
    };
    return new privyModule.PrivyClient({
      appId: this.config.getOrThrow<string>('PRIVY_APP_ID'),
      appSecret: this.config.getOrThrow<string>('PRIVY_APP_SECRET'),
      apiUrl: this.getSdkApiUrl(),
      requestExpiry: { defaultMs: 60_000, defaultIntentMs: 60_000 },
    });
  }

  private getSdkApiUrl(): string | undefined {
    const configured = this.config.get<string>('PRIVY_API_URL');
    return configured?.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  }

  private getAuthorizationPublicKey(): string {
    const configuredPublicKey = this.config.get<string>('PRIVY_AUTHORIZATION_PUBLIC_KEY');
    if (configuredPublicKey) {
      try {
        return this.normalizePublicKey(configuredPublicKey);
      } catch (_error) {
        // Fall back to deriving from the authorization private key. Multi-line
        // PEM values are easy to break in .env files.
      }
    }

    const encoded = this.getAuthorizationPrivateKey();
    const privateKeyMaterial = this.isPrivyWalletAuthKey(encoded)
      ? encoded.slice('wallet-auth:'.length)
      : encoded;

    const decoded = Buffer.from(privateKeyMaterial, 'base64');
    try {
      const text = decoded.toString('utf8');
      const privateKey = text.includes('BEGIN PRIVATE KEY')
        ? createPrivateKey(text)
        : createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
      return createPublicKey(privateKey)
        .export({ format: 'der', type: 'spki' })
        .toString('base64');
    } catch (_error) {
      return this.deriveP256PublicKeyFromPkcs8Bytes(decoded);
    }
  }

  private getAuthorizationPrivateKey(): string {
    return this.config.getOrThrow<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64');
  }

  private isPrivyWalletAuthKey(value: string): boolean {
    return value.startsWith('wallet-auth:');
  }

  private normalizePublicKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed.includes('BEGIN PUBLIC KEY')) {
      return createPublicKey(trimmed)
        .export({ format: 'der', type: 'spki' })
        .toString('base64');
    }

    return trimmed;
  }

  private deriveP256PublicKeyFromPkcs8Bytes(pkcs8Bytes: Buffer): string {
    const privateKeyStart = pkcs8Bytes.indexOf(Buffer.from([0x04, 0x20]));
    if (privateKeyStart === -1) {
      throw new ServiceUnavailableException('Privy authorization private key is invalid');
    }

    const privateKeyBytes = pkcs8Bytes.subarray(privateKeyStart + 2, privateKeyStart + 34);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateKeyBytes);
    const publicKey = ecdh.getPublicKey();
    const spkiP256Header = Buffer.from(
      '3059301306072a8648ce3d020106082a8648ce3d030107034200',
      'hex',
    );
    return Buffer.concat([spkiP256Header, publicKey]).toString('base64');
  }

  private dynamicImport(specifier: string): Promise<unknown> {
    const importer = new Function('moduleName', 'return import(moduleName)') as (
      moduleName: string,
    ) => Promise<unknown>;
    return importer(specifier);
  }

  private async createTronWebClient(mainnet = true): Promise<any> {
    const rpcUrl = mainnet
      ? this.config.get<string>('TRON_RPC_PRIMARY_URL', '')
      : this.config.get<string>('TRON_NILE_RPC_PRIMARY_URL', '');
    const fallback = mainnet
      ? this.config.get<string>('TRON_RPC_FALLBACK_URL', '')
      : this.config.get<string>('TRON_NILE_RPC_FALLBACK_URL', '');
    const publicFullNode = mainnet
      ? this.config.get<string>('TRON_PUBLIC_FULLNODE_URL', 'https://tron-rpc.publicnode.com')
      : '';
    const fullHosts = [...new Set([rpcUrl, fallback, publicFullNode]
      .map((value) => value.trim().replace(/\/$/, ''))
      .filter(Boolean))];
    if (fullHosts.length === 0) {
      throw new ServiceUnavailableException('TRON RPC is not configured');
    }
    const tronModule = await this.dynamicImport('tronweb') as {
      TronWeb?: new (options: { fullHost: string; headers?: Record<string, string> }) => any;
      default?: new (options: { fullHost: string; headers?: Record<string, string> }) => any;
    };
    const TronWebCtor = tronModule.TronWeb ?? tronModule.default;
    if (!TronWebCtor) {
      throw new ServiceUnavailableException('TronWeb is unavailable');
    }
    const apiKey = this.config.get<string>(
      mainnet ? 'TRON_PRO_API_KEY' : 'TRON_NILE_PRO_API_KEY',
      '',
    ).trim();
    let lastStatus = 0;
    for (const fullHost of fullHosts) {
      const useApiKey = apiKey && fullHost === rpcUrl.trim().replace(/\/$/, '');
      const headers = useApiKey ? { 'TRON-PRO-API-KEY': apiKey } : undefined;
      try {
        const probe = await fetch(`${fullHost}/wallet/getnowblock`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(headers ?? {}) },
          body: '{}',
          signal: AbortSignal.timeout(8_000),
        });
        lastStatus = probe.status;
        if (!probe.ok) continue;
        return new TronWebCtor({ fullHost, ...(headers ? { headers } : {}) });
      } catch (_error) {
        continue;
      }
    }
    throw new ServiceUnavailableException(
      `No healthy TRON FullNode is available${lastStatus ? ` (last HTTP ${lastStatus})` : ''}`,
    );
  }

  private assertTronTrc20Transfer(input: {
    transaction: TronUnsignedTransaction;
    fromAddress: string;
    toAddress: string;
    contractAddress: string;
    rawAmount: bigint;
    tronWeb: any;
  }): void {
    const contracts = input.transaction.raw_data?.contract ?? [];
    if (contracts.length !== 1 || contracts[0]?.type !== 'TriggerSmartContract') {
      throw new ServiceUnavailableException('Expected one Tron TriggerSmartContract transaction');
    }
    const value = contracts[0].parameter?.value ?? {};
    if (Number(value.call_value ?? 0) !== 0) {
      throw new ServiceUnavailableException('Tron TRC20 transfer must have zero call_value');
    }
    const ownerAddress = String(value.owner_address ?? '');
    const contractAddress = String(value.contract_address ?? '');
    const calldata = String(value.data ?? '').replace(/^0x/i, '').toLowerCase();
    const expectedOwner = String(input.tronWeb.address.toHex(input.fromAddress)).replace(/^0x/i, '');
    const expectedContract = String(input.tronWeb.address.toHex(input.contractAddress)).replace(/^0x/i, '');
    const expectedRecipient = String(input.tronWeb.address.toHex(input.toAddress))
      .replace(/^0x/i, '')
      .slice(2)
      .toLowerCase();
    if (ownerAddress.toLowerCase() !== expectedOwner.toLowerCase() ||
        contractAddress.toLowerCase() !== expectedContract.toLowerCase()) {
      throw new ServiceUnavailableException('Tron TRC20 transaction owner or contract mismatch');
    }
    if (!/^a9059cbb[0-9a-f]{128}$/.test(calldata)) {
      throw new ServiceUnavailableException('Tron TRC20 transfer calldata is missing or malformed');
    }
    const encodedRecipient = calldata.slice(8, 72).slice(-40);
    const encodedAmount = BigInt(`0x${calldata.slice(72, 136)}`);
    if (encodedRecipient !== expectedRecipient || encodedAmount !== input.rawAmount) {
      throw new ServiceUnavailableException('Tron TRC20 transfer calldata does not match request');
    }
  }

  private normalizeTronSignature(input: {
    signature: string;
    transaction: TronUnsignedTransaction;
    expectedAddress: string;
    tronWeb: any;
  }): string {
    const raw = input.signature.replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]+$/.test(raw)) {
      throw new ServiceUnavailableException('Privy returned a non-hex Tron signature');
    }
    const candidates = raw.length === 128
      ? [`${raw}1b`, `${raw}1c`]
      : raw.length === 130
        ? [
            raw.endsWith('00') ? `${raw.slice(0, -2)}1b` : raw,
            raw.endsWith('01') ? `${raw.slice(0, -2)}1c` : raw,
          ]
        : [];
    for (const candidate of [...new Set(candidates)]) {
      if (!/^[0-9a-f]{130}$/.test(candidate)) continue;
      try {
        const recovered = input.tronWeb.trx.ecRecover({
          ...input.transaction,
          signature: [candidate],
        });
        if (recovered === input.expectedAddress) {
          return candidate;
        }
      } catch (_error) {
        continue;
      }
    }
    throw new ServiceUnavailableException('Privy Tron signature does not match wallet address');
  }

  private decodeTronMessage(value: unknown): string {
    if (typeof value !== 'string' || !value) return '';
    try {
      return Buffer.from(value.replace(/^0x/i, ''), 'hex').toString('utf8');
    } catch (_error) {
      return value;
    }
  }
}
