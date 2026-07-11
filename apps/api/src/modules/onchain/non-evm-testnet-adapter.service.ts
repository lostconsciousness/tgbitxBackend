import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, Chain, Network, NetworkFamily, TokenContract, TokenStandard } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrivyCustodyService } from '../treasury/privy-custody.service';

type DepositAddressSecret = {
  kind: 'solana' | 'bitcoin' | 'tron';
  secret: string;
};

type DetectedDeposit = {
  depositAddressId: string;
  userId: string;
  fromAddress?: string;
  toAddress: string;
  txHash: string;
  outputIndex?: number;
  blockNumber?: number;
  amount: string;
  rawAmount: string;
  confirmations: number;
};

type NonEvmTokenContract = TokenContract & { network: Network; asset?: Asset };

type BitcoinExplorerTx = {
  txid: string;
  status?: {
    confirmed?: boolean;
    block_height?: number;
  };
  vin?: Array<{
    prevout?: {
      scriptpubkey_address?: string;
    };
  }>;
  vout?: Array<{
    scriptpubkey_address?: string;
    value?: number;
  }>;
};

type BitcoinExplorerUtxo = {
  txid: string;
  vout: number;
  value: number;
  status?: {
    confirmed?: boolean;
  };
};

@Injectable()
export class NonEvmTestnetAdapterService {
  constructor(
    private readonly config: ConfigService,
    private readonly custody: PrivyCustodyService,
  ) {}

  isImplemented(family: NetworkFamily): boolean {
    const implemented: NetworkFamily[] = [
      NetworkFamily.SVM,
      NetworkFamily.UTXO,
      NetworkFamily.TVM,
    ];
    return implemented.includes(family);
  }

  assertSupportedNetwork(network: Network): void {
    if (!this.isImplemented(network.family)) {
      throw new ServiceUnavailableException(`${network.family} adapter is not implemented`);
    }
    if (network.mainnet && !this.config.get<boolean>('MAINNET_ENABLED', false)) {
      throw new ServiceUnavailableException(`${network.chainKey} mainnet adapter is not enabled`);
    }
    if (!this.resolveRpcUrl(network) && network.family !== NetworkFamily.UTXO) {
      throw new ServiceUnavailableException(`${network.chainKey} RPC URL is not configured`);
    }
  }

  async provisionDepositAddress(network: Network): Promise<{
    address: string;
    providerWalletRef: string;
  }> {
    this.assertSupportedNetwork(network);
    if (network.family === NetworkFamily.SVM) {
      const { Keypair } = await import('@solana/web3.js');
      const keypair = Keypair.generate();
      return {
        address: keypair.publicKey.toBase58(),
        providerWalletRef: this.encodeSecret({
          kind: 'solana',
          secret: Buffer.from(keypair.secretKey).toString('base64'),
        }),
      };
    }
    if (network.family === NetworkFamily.UTXO) {
      const bitcoin = await import('bitcoinjs-lib');
      const tiny = await import('tiny-secp256k1');
      const { ECPairFactory } = await import('ecpair');
      const ECPair = ECPairFactory(tiny);
      const bitcoinNetwork = this.bitcoinNetworkParams(network, bitcoin);
      const keyPair = ECPair.makeRandom({ network: bitcoinNetwork });
      const payment = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network: bitcoinNetwork,
      });
      if (!payment.address) {
        throw new ServiceUnavailableException(`Could not generate ${network.displayName} deposit address`);
      }
      return {
        address: payment.address,
        providerWalletRef: this.encodeSecret({
          kind: 'bitcoin',
          secret: keyPair.toWIF(),
        }),
      };
    }
    if (network.family === NetworkFamily.TVM) {
      const TronWeb = await this.importTronWeb();
      const tronWeb = this.createTronWeb(network);
      const account =
        typeof TronWeb.createAccount === 'function'
          ? await TronWeb.createAccount()
          : await tronWeb.createAccount();
      return {
        address: account.address.base58 ?? account.address,
        providerWalletRef: this.encodeSecret({
          kind: 'tron',
          secret: account.privateKey,
        }),
      };
    }
    throw new ServiceUnavailableException(`${network.family} adapter is not implemented`);
  }

  normalizeAddress(network: Network, address: string): string {
    if (network.family === NetworkFamily.SVM) {
      return address.trim();
    }
    if (network.family === NetworkFamily.UTXO) {
      return address.trim();
    }
    if (network.family === NetworkFamily.TVM) {
      return address.trim();
    }
    return address.trim();
  }

  async validateAddress(network: Network, address: string): Promise<void> {
    this.assertSupportedNetwork(network);
    if (network.family === NetworkFamily.SVM) {
      const { PublicKey } = await import('@solana/web3.js');
      try {
        new PublicKey(address);
        return;
      } catch (_error) {
        throw new BadRequestException('Invalid Solana address');
      }
    }
    if (network.family === NetworkFamily.UTXO) {
      const bitcoin = await import('bitcoinjs-lib');
      try {
        bitcoin.address.toOutputScript(address, this.bitcoinNetworkParams(network, bitcoin));
        return;
      } catch (_error) {
        throw new BadRequestException(`Invalid ${network.displayName} address`);
      }
    }
    if (network.family === NetworkFamily.TVM) {
      const tronWeb = this.createTronWeb(network);
      if (!tronWeb.isAddress(address)) {
        throw new BadRequestException('Invalid TRON address');
      }
    }
  }

  async scanDeposits(input: {
    asset: Asset;
    tokenContract: NonEvmTokenContract;
    fromBlock: number;
    toBlock?: number;
    personalAddresses: Array<{ id: string; userId: string; address: string }>;
  }): Promise<{
    latestBlock: number;
    toBlock: number;
    scannedTransactions: number;
    deposits: DetectedDeposit[];
  }> {
    this.assertSupportedNetwork(input.tokenContract.network);
    if (input.tokenContract.network.family === NetworkFamily.SVM) {
      return this.scanSolanaDeposits(input);
    }
    if (input.tokenContract.network.family === NetworkFamily.UTXO) {
      if (this.shouldUseBitcoinExplorerForDeposits(input.tokenContract.network)) {
        return this.scanBitcoinExplorerDeposits(input);
      }
      return this.scanBitcoinDeposits(input);
    }
    if (input.tokenContract.network.family === NetworkFamily.TVM) {
      return this.scanTronDeposits(input);
    }
    throw new ServiceUnavailableException(`${input.tokenContract.network.family} adapter is not implemented`);
  }

  async getLatestBlock(network: Network): Promise<number> {
    this.assertSupportedNetwork(network);
    if (network.family === NetworkFamily.SVM) {
      const { Connection } = await import('@solana/web3.js');
      const connection = new Connection(this.resolveRpcUrl(network), 'confirmed');
      return connection.getSlot('confirmed');
    }
    if (network.family === NetworkFamily.UTXO) {
      return this.shouldUseBitcoinExplorerForDeposits(network)
        ? this.bitcoinExplorerGet<number>(network, '/blocks/tip/height')
        : this.bitcoinRpc<number>(network, 'getblockcount', []);
    }
    if (network.family === NetworkFamily.TVM) {
      return this.getTronLatestBlock(network);
    }
    throw new ServiceUnavailableException(`${network.family} adapter is not implemented`);
  }

  async getBalance(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    address: string;
  }): Promise<{ balance: string | null; rawBalance: string | null; status: 'AVAILABLE' | 'UNAVAILABLE' }> {
    try {
      this.assertSupportedNetwork(input.network);
      if (input.network.family === NetworkFamily.SVM) {
        return this.getSolanaBalance(input);
      }
      if (input.network.family === NetworkFamily.UTXO) {
        return this.getBitcoinBalance(input);
      }
      if (input.network.family === NetworkFamily.TVM) {
        return this.getTronBalance(input);
      }
      return { balance: null, rawBalance: null, status: 'UNAVAILABLE' };
    } catch (_error) {
      return { balance: null, rawBalance: null, status: 'UNAVAILABLE' };
    }
  }

  async sendWithdrawal(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    toAddress: string;
    amount: string;
    referenceId: string;
    broadcastAttempt?: number;
  }): Promise<{ txHash: string; providerRequestId?: string }> {
    this.assertSupportedNetwork(input.network);
    await this.validateAddress(input.network, input.toAddress);
    if (input.network.family === NetworkFamily.SVM) {
      return this.sendSolanaWithdrawal(input);
    }
    if (input.network.family === NetworkFamily.UTXO) {
      return this.sendBitcoinWithdrawal(input);
    }
    if (input.network.family === NetworkFamily.TVM) {
      return this.sendTronWithdrawal(input);
    }
    throw new ServiceUnavailableException(`${input.network.family} withdrawal adapter is not implemented`);
  }

  async confirmWithdrawal(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    txHash: string;
    toAddress: string;
    amount: string;
    requiredConfirmations: number;
  }): Promise<{ confirmed: boolean; gasUsed?: bigint; effectiveGasPrice?: bigint }> {
    this.assertSupportedNetwork(input.network);
    if (input.network.family === NetworkFamily.SVM) {
      return this.confirmSolanaWithdrawal(input);
    }
    if (input.network.family === NetworkFamily.UTXO) {
      return this.confirmBitcoinWithdrawal(input);
    }
    if (input.network.family === NetworkFamily.TVM) {
      return this.confirmTronWithdrawal(input);
    }
    return { confirmed: false };
  }

  private async scanSolanaDeposits(input: {
    asset: Asset;
    tokenContract: NonEvmTokenContract;
    fromBlock: number;
    toBlock?: number;
    personalAddresses: Array<{ id: string; userId: string; address: string }>;
  }) {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const connection = new Connection(this.resolveRpcUrl(input.tokenContract.network), 'confirmed');

    const latestBlock = await this.getLatestBlock(input.tokenContract.network);
    const toBlock = input.toBlock ?? latestBlock;
    const deposits: DetectedDeposit[] = [];
    let scannedTransactions = 0;

    for (const address of input.personalAddresses) {
      const publicKey = new PublicKey(address.address);
      const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 200 });
      for (const signature of signatures) {
        if (signature.err) {
          continue;
        }
        const slot = signature.slot;
        const tx = await connection.getParsedTransaction(signature.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.transaction) {
          continue;
        }
        scannedTransactions += 1;
        const confirmations = Math.max(0, latestBlock - slot + 1);
        if (input.tokenContract.standard === TokenStandard.NATIVE) {
          const instructions = tx.transaction.message.instructions as any[];
          for (let index = 0; index < instructions.length; index += 1) {
            const instruction = instructions[index] as any;
            if (
              instruction?.program === 'system' &&
              instruction?.parsed?.type === 'transfer' &&
              instruction.parsed.info?.destination === address.address
            ) {
              const rawAmount = String(instruction.parsed.info.lamports);
              deposits.push({
                depositAddressId: address.id,
                userId: address.userId,
                fromAddress: instruction.parsed.info.source,
                toAddress: address.address,
                txHash: signature.signature,
                outputIndex: index,
                blockNumber: slot,
                amount: this.formatRawAmount(rawAmount, input.tokenContract.decimals),
                rawAmount,
                confirmations,
              });
            }
          }
          continue;
        }
        if (input.tokenContract.standard === TokenStandard.SPL && input.tokenContract.address) {
          const preBalances = new Map<string, bigint>();
          for (const balance of tx.meta?.preTokenBalances ?? []) {
            if (balance.owner === address.address && balance.mint === input.tokenContract.address) {
              preBalances.set(String(balance.accountIndex), BigInt(balance.uiTokenAmount.amount));
            }
          }
          for (const balance of tx.meta?.postTokenBalances ?? []) {
            if (balance.owner !== address.address || balance.mint !== input.tokenContract.address) {
              continue;
            }
            const before = preBalances.get(String(balance.accountIndex)) ?? 0n;
            const after = BigInt(balance.uiTokenAmount.amount);
            const delta = after - before;
            if (delta <= 0n) {
              continue;
            }
            deposits.push({
              depositAddressId: address.id,
              userId: address.userId,
              toAddress: address.address,
              txHash: signature.signature,
              outputIndex: Number(balance.accountIndex),
              blockNumber: slot,
              amount: this.formatRawAmount(delta.toString(), input.tokenContract.decimals),
              rawAmount: delta.toString(),
              confirmations,
            });
          }
        }
      }
    }

    return { latestBlock, toBlock, scannedTransactions, deposits };
  }

  private async scanBitcoinDeposits(input: {
    asset: Asset;
    tokenContract: NonEvmTokenContract;
    fromBlock: number;
    toBlock?: number;
    personalAddresses: Array<{ id: string; userId: string; address: string }>;
  }) {
    const latestBlock = await this.getLatestBlock(input.tokenContract.network);
    const toBlock = input.toBlock ?? latestBlock;
    const addressByValue = new Map(input.personalAddresses.map((address) => [address.address, address]));
    const deposits: DetectedDeposit[] = [];
    let scannedTransactions = 0;

    for (let height = input.fromBlock; height <= toBlock; height += 1) {
      const hash = await this.bitcoinRpc<string>(input.tokenContract.network, 'getblockhash', [height]);
      const block = await this.bitcoinRpc<any>(input.tokenContract.network, 'getblock', [hash, 2]);
      for (const tx of block.tx ?? []) {
        scannedTransactions += 1;
        for (let voutIndex = 0; voutIndex < (tx.vout ?? []).length; voutIndex += 1) {
          const vout = tx.vout[voutIndex];
          const destinations = [
            vout.scriptPubKey?.address,
            ...(vout.scriptPubKey?.addresses ?? []),
          ].filter(Boolean);
          for (const destination of destinations) {
            const personal = addressByValue.get(destination);
            if (!personal) {
              continue;
            }
            const rawAmount = this.btcToSats(String(vout.value)).toString();
            deposits.push({
              depositAddressId: personal.id,
              userId: personal.userId,
              toAddress: personal.address,
              txHash: tx.txid,
              outputIndex: voutIndex,
              blockNumber: height,
              amount: this.formatRawAmount(rawAmount, input.tokenContract.decimals),
              rawAmount,
              confirmations: Math.max(0, latestBlock - height + 1),
            });
          }
        }
      }
    }

    return { latestBlock, toBlock, scannedTransactions, deposits };
  }

  private async scanTronDeposits(input: {
    asset: Asset;
    tokenContract: NonEvmTokenContract;
    fromBlock: number;
    toBlock?: number;
    personalAddresses: Array<{ id: string; userId: string; address: string }>;
  }) {
    const latestBlock = await this.getLatestBlock(input.tokenContract.network);
    const toBlock = input.toBlock ?? latestBlock;
    const deposits: DetectedDeposit[] = [];
    let scannedTransactions = 0;

    for (const address of input.personalAddresses) {
      if (input.tokenContract.standard === TokenStandard.NATIVE) {
        const data = await this.tronGridGet<any>(
          input.tokenContract.network,
          `/v1/accounts/${address.address}/transactions?only_to=true&limit=200`,
        );
        for (const tx of data.data ?? []) {
          const contract = tx.raw_data?.contract?.[0];
          const value = contract?.parameter?.value;
          const blockNumber = Number(tx.blockNumber ?? tx.block_number ?? 0);
          if (
            !blockNumber ||
            contract?.type !== 'TransferContract' ||
            value?.to_address !== this.tronHexAddress(input.tokenContract.network, address.address)
          ) {
            continue;
          }
          scannedTransactions += 1;
          const rawAmount = String(value.amount);
          deposits.push({
            depositAddressId: address.id,
            userId: address.userId,
            fromAddress: this.tronBase58Address(input.tokenContract.network, value.owner_address),
            toAddress: address.address,
            txHash: tx.txID ?? tx.txid,
            outputIndex: 0,
            blockNumber,
            amount: this.formatRawAmount(rawAmount, input.tokenContract.decimals),
            rawAmount,
            confirmations: Math.max(0, latestBlock - blockNumber + 1),
          });
        }
        continue;
      }
      if (input.tokenContract.standard === TokenStandard.TRC20 && input.tokenContract.address) {
        const data = await this.tronGridGet<any>(
          input.tokenContract.network,
          `/v1/accounts/${address.address}/transactions/trc20?only_to=true&contract_address=${input.tokenContract.address}&limit=200`,
        );
        const blockCache = new Map<string, number>();
        for (const tx of data.data ?? []) {
          const txHash = String(tx.transaction_id ?? tx.txID ?? tx.txid ?? '');
          if (!txHash || tx.to !== address.address) {
            continue;
          }
          const blockNumber = await this.resolveTronTransactionBlockNumber(
            input.tokenContract.network,
            txHash,
            blockCache,
          );
          if (!blockNumber) {
            continue;
          }
          scannedTransactions += 1;
          const rawAmount = String(tx.value);
          deposits.push({
            depositAddressId: address.id,
            userId: address.userId,
            fromAddress: tx.from,
            toAddress: tx.to,
            txHash,
            outputIndex: 0,
            blockNumber,
            amount: this.formatRawAmount(rawAmount, input.tokenContract.decimals),
            rawAmount,
            confirmations: Math.max(0, latestBlock - blockNumber + 1),
          });
        }
      }
    }

    return { latestBlock, toBlock, scannedTransactions, deposits };
  }

  private async getSolanaBalance(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    address: string;
  }) {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const connection = new Connection(this.resolveRpcUrl(input.network), 'confirmed');
    const owner = new PublicKey(input.address);
    if (input.tokenContract.standard === TokenStandard.NATIVE) {
      const lamports = await connection.getBalance(owner, 'confirmed');
      return {
        balance: this.formatRawAmount(String(lamports), input.tokenContract.decimals),
        rawBalance: String(lamports),
        status: 'AVAILABLE' as const,
      };
    }
    if (input.tokenContract.standard === TokenStandard.SPL && input.tokenContract.address) {
      const { getAssociatedTokenAddress } = await import('@solana/spl-token');
      const mint = new PublicKey(input.tokenContract.address);
      const ata = await getAssociatedTokenAddress(mint, owner);
      const balance = await connection.getTokenAccountBalance(ata).catch(() => null);
      const raw = balance?.value.amount ?? '0';
      return {
        balance: this.formatRawAmount(raw, input.tokenContract.decimals),
        rawBalance: raw,
        status: 'AVAILABLE' as const,
      };
    }
    return { balance: null, rawBalance: null, status: 'UNAVAILABLE' as const };
  }

  private async getBitcoinBalance(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    address: string;
  }) {
    if (this.shouldUseBitcoinExplorerForDeposits(input.network)) {
      const utxos = await this.bitcoinExplorerGet<BitcoinExplorerUtxo[]>(
        input.network,
        `/address/${input.address}/utxo`,
      );
      const raw = utxos
        .filter((utxo) => utxo.status?.confirmed !== false)
        .reduce((sum, utxo) => sum + BigInt(utxo.value), 0n)
        .toString();
      return {
        balance: this.formatRawAmount(raw, input.tokenContract.decimals),
        rawBalance: raw,
        status: 'AVAILABLE' as const,
      };
    }

    const result = await this.bitcoinRpc<any>(input.network, 'scantxoutset', [
      'start',
      [{ desc: `addr(${input.address})` }],
    ]);
    const raw = this.btcToSats(String(result?.total_amount ?? 0)).toString();
    return {
      balance: this.formatRawAmount(raw, input.tokenContract.decimals),
      rawBalance: raw,
      status: 'AVAILABLE' as const,
    };
  }

  private async getTronBalance(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    address: string;
  }) {
    const tronWeb = this.createTronWeb(input.network);
    if (input.tokenContract.standard === TokenStandard.NATIVE) {
      const raw = String(await tronWeb.trx.getBalance(input.address));
      return {
        balance: this.formatRawAmount(raw, input.tokenContract.decimals),
        rawBalance: raw,
        status: 'AVAILABLE' as const,
      };
    }
    if (input.tokenContract.standard === TokenStandard.TRC20 && input.tokenContract.address) {
      try {
        tronWeb.setAddress(input.address);
        const contract = await tronWeb.contract().at(input.tokenContract.address);
        const raw = String(
          await contract.balanceOf(input.address).call({ from: input.address }),
        );
        return {
          balance: this.formatRawAmount(raw, input.tokenContract.decimals),
          rawBalance: raw,
          status: 'AVAILABLE' as const,
        };
      } catch (_error) {
        return { balance: null, rawBalance: null, status: 'UNAVAILABLE' as const };
      }
    }
    return { balance: null, rawBalance: null, status: 'UNAVAILABLE' as const };
  }

  private async sendSolanaWithdrawal(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    toAddress: string;
    amount: string;
    referenceId: string;
  }) {
    const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = await import('@solana/web3.js');
    const connection = new Connection(this.resolveRpcUrl(input.network), 'confirmed');
    const usePrivy = input.network.mainnet && this.custody.isSolanaEnabled();
    const walletId = usePrivy
      ? this.config.getOrThrow<string>('PRIVY_SOLANA_WALLET_ID')
      : undefined;
    const payerAddress = usePrivy
      ? await this.custody.getWalletAddress(walletId)
      : this.solanaHotKeypair(input.network, Keypair).publicKey.toBase58();
    const payer = new PublicKey(payerAddress);
    const rawAmount = this.parseRawAmount(input.amount, input.tokenContract.decimals);
    const transaction = new Transaction();
    if (input.tokenContract.standard === TokenStandard.NATIVE) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: new PublicKey(input.toAddress),
          lamports: Number(rawAmount),
        }),
      );
    } else if (input.tokenContract.standard === TokenStandard.SPL && input.tokenContract.address) {
      const {
        createAssociatedTokenAccountInstruction,
        createTransferInstruction,
        getAccount,
        getAssociatedTokenAddress,
      } = await import('@solana/spl-token');
      const mint = new PublicKey(input.tokenContract.address);
      const destinationOwner = new PublicKey(input.toAddress);
      const sourceAta = await getAssociatedTokenAddress(mint, payer);
      const destinationAta = await getAssociatedTokenAddress(mint, destinationOwner);
      const destinationExists = await getAccount(connection, destinationAta).then(() => true).catch(() => false);
      if (!destinationExists) {
        transaction.add(
          createAssociatedTokenAccountInstruction(
            payer,
            destinationAta,
            destinationOwner,
            mint,
          ),
        );
      }
      transaction.add(
        createTransferInstruction(sourceAta, destinationAta, payer, rawAmount),
      );
    } else {
      throw new ServiceUnavailableException('Unsupported Solana withdrawal token standard');
    }
    transaction.feePayer = payer;
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    if (usePrivy) {
      return this.custody.sendSolanaTransaction({
        walletId,
        transaction: transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }).toString('base64'),
        referenceId: input.referenceId,
        mainnet: true,
      });
    }
    const localPayer = this.solanaHotKeypair(input.network, Keypair);
    transaction.sign(localPayer);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
    });
    return { txHash: signature, providerRequestId: input.referenceId };
  }

  private async sendBitcoinWithdrawal(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    toAddress: string;
    amount: string;
    referenceId: string;
    broadcastAttempt?: number;
  }) {
    if (input.tokenContract.standard !== TokenStandard.BTC) {
      throw new ServiceUnavailableException('Only BTC withdrawals are supported by the UTXO adapter');
    }
    const bitcoin = await import('bitcoinjs-lib');
    const tiny = await import('tiny-secp256k1');
    const { ECPairFactory } = await import('ecpair');
    const ECPair = ECPairFactory(tiny);
    const bitcoinNetwork = this.bitcoinNetworkParams(input.network, bitcoin);
    const envPrefix = this.resolveNetworkEnvPrefix(input.network);
    let keyPair: ReturnType<typeof ECPair.fromWIF>;
    try {
      keyPair = ECPair.fromWIF(this.resolveBitcoinWithdrawalWif(input.network), bitcoinNetwork);
    } catch {
      throw new ServiceUnavailableException(
        `${envPrefix}_WITHDRAWAL_WIF is invalid for ${input.network.chainKey}`,
      );
    }
    const hotAddress = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: bitcoinNetwork,
    }).address;
    if (!hotAddress) {
      throw new ServiceUnavailableException(`Could not derive ${input.network.displayName} hot wallet address`);
    }
    const utxos = this.usesBitcoinExplorer(input.network)
      ? await this.bitcoinExplorerGet<BitcoinExplorerUtxo[]>(
          input.network,
          `/address/${hotAddress}/utxo`,
        )
      : (await this.bitcoinRpc<any>(input.network, 'scantxoutset', [
          'start',
          [{ desc: `addr(${hotAddress})` }],
        ]))?.unspents ?? [];
    const targetValue = this.parseRawAmount(input.amount, input.tokenContract.decimals);
    const baseFee = BigInt(this.config.get<string>(`${envPrefix}_WITHDRAWAL_FEE_SATS`, '1000'));
    const feeStep = BigInt(this.config.get<string>(`${envPrefix}_RBF_FEE_STEP_SATS`, '1000'));
    const attempt = Math.max(1, input.broadcastAttempt ?? 1);
    const fee = baseFee + BigInt(attempt - 1) * feeStep;
    let selected = 0n;
    const psbt = new bitcoin.Psbt({ network: bitcoinNetwork });
    const script = bitcoin.address.toOutputScript(hotAddress, bitcoinNetwork);
    for (const utxo of utxos) {
      const value = this.usesBitcoinExplorer(input.network)
        ? BigInt(utxo.value)
        : this.btcToSats(String(utxo.amount));
      selected += value;
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        sequence: 0xfffffffd,
        witnessUtxo: {
          script,
          value,
        },
      });
      if (selected >= targetValue + fee) {
        break;
      }
    }
    if (selected < targetValue + fee) {
      throw new ServiceUnavailableException(`${input.network.displayName} hot wallet has insufficient UTXO balance`);
    }
    psbt.addOutput({ address: input.toAddress, value: targetValue });
    const change = selected - targetValue - fee;
    if (change > 0n) {
      psbt.addOutput({ address: hotAddress, value: change });
    }
    psbt.signAllInputs(keyPair);
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    const txHash = this.usesBitcoinExplorer(input.network)
      ? await this.bitcoinExplorerPostText(input.network, '/tx', txHex)
      : await this.bitcoinRpc<string>(input.network, 'sendrawtransaction', [txHex]);
    return { txHash, providerRequestId: input.referenceId };
  }

  private async sendTronWithdrawal(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    toAddress: string;
    amount: string;
    referenceId: string;
  }) {
    const usePrivy = input.network.mainnet && this.custody.isTronEnabled();
    const rawAmount = this.parseRawAmount(input.amount, input.tokenContract.decimals);
    if (usePrivy) {
      const walletId = this.config.getOrThrow<string>('PRIVY_TRON_WALLET_ID');
      const fromAddress = await this.custody.getWalletAddress(walletId);
      if (input.tokenContract.standard === TokenStandard.NATIVE) {
        return this.custody.sendTronNativeTransfer({
          walletId,
          fromAddress,
          toAddress: input.toAddress,
          amountSun: this.toSafeTronSunAmount(rawAmount),
          referenceId: input.referenceId,
          mainnet: true,
        });
      }
      if (input.tokenContract.standard === TokenStandard.TRC20 && input.tokenContract.address) {
        return this.custody.sendTronTrc20Transfer({
          walletId,
          fromAddress,
          toAddress: input.toAddress,
          contractAddress: input.tokenContract.address,
          rawAmount,
          referenceId: input.referenceId,
          mainnet: true,
        });
      }
      throw new ServiceUnavailableException('Unsupported TRON withdrawal token standard');
    }
    const privateKey = this.resolveWithdrawalPrivateKey(input.network);
    const tronWeb = this.createTronWeb(input.network, privateKey);
    if (input.tokenContract.standard === TokenStandard.NATIVE) {
      const amountSun = this.toSafeTronSunAmount(rawAmount);
      const receipt = await tronWeb.trx.sendTransaction(input.toAddress, amountSun, privateKey);
      if (!receipt?.result) {
        throw new ServiceUnavailableException(receipt?.message ?? 'TRON withdrawal broadcast failed');
      }
      return { txHash: receipt.txid, providerRequestId: input.referenceId };
    }
    if (input.tokenContract.standard === TokenStandard.TRC20 && input.tokenContract.address) {
      const contract = await tronWeb.contract().at(input.tokenContract.address);
      const txid = await contract.transfer(input.toAddress, rawAmount.toString()).send({
        feeLimit: Number(this.config.get<string>(`${this.resolveNetworkEnvPrefix(input.network)}_TRC20_FEE_LIMIT_SUN`, '150000000')),
      });
      return { txHash: txid, providerRequestId: input.referenceId };
    }
    throw new ServiceUnavailableException('Unsupported TRON withdrawal token standard');
  }

  private async confirmSolanaWithdrawal(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    txHash: string;
    toAddress: string;
    amount: string;
    requiredConfirmations: number;
  }) {
    const { Connection } = await import('@solana/web3.js');
    const connection = new Connection(this.resolveRpcUrl(input.network), 'confirmed');
    const latest = await connection.getSlot('confirmed');
    const tx = await connection.getParsedTransaction(input.txHash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.slot || tx.meta?.err) {
      return { confirmed: false };
    }
    return { confirmed: latest - tx.slot + 1 >= input.requiredConfirmations };
  }

  private async confirmBitcoinWithdrawal(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    txHash: string;
    toAddress: string;
    amount: string;
    requiredConfirmations: number;
  }) {
    const rawAmount = this.parseRawAmount(input.amount, input.tokenContract.decimals);
    if (this.usesBitcoinExplorer(input.network)) {
      const latest = await this.getLatestBlock(input.network);
      const tx = await this.bitcoinExplorerGet<BitcoinExplorerTx>(
        input.network,
        `/tx/${input.txHash}`,
      ).catch(() => null);
      if (!tx?.status?.confirmed || !tx.status.block_height) {
        return { confirmed: false };
      }
      const confirmations = Math.max(0, latest - tx.status.block_height + 1);
      if (confirmations < input.requiredConfirmations) {
        return { confirmed: false };
      }
      const matches = (tx.vout ?? []).some((vout) =>
        vout.scriptpubkey_address === input.toAddress &&
        BigInt(vout.value ?? 0) === rawAmount,
      );
      return { confirmed: matches };
    }

    const tx = await this.bitcoinRpc<any>(input.network, 'getrawtransaction', [input.txHash, true]).catch(() => null);
    if (!tx || Number(tx.confirmations ?? 0) < input.requiredConfirmations) {
      return { confirmed: false };
    }
    const matches = (tx.vout ?? []).some((vout: any) => {
      const destinations = [vout.scriptPubKey?.address, ...(vout.scriptPubKey?.addresses ?? [])].filter(Boolean);
      return destinations.includes(input.toAddress) && this.btcToSats(String(vout.value)) === rawAmount;
    });
    return { confirmed: matches };
  }

  private async confirmTronWithdrawal(input: {
    network: Network;
    tokenContract: Pick<TokenContract, 'standard' | 'address' | 'decimals'>;
    txHash: string;
    toAddress: string;
    amount: string;
    requiredConfirmations: number;
  }) {
    const info = await this.tronPost<any>(input.network, '/wallet/gettransactioninfobyid', {
      value: input.txHash,
    }).catch(() => null);
    if (!info?.blockNumber || info.receipt?.result === 'FAILED') {
      return { confirmed: false };
    }
    const latest = await this.getTronLatestBlock(input.network);
    return { confirmed: latest - Number(info.blockNumber) + 1 >= input.requiredConfirmations };
  }

  private solanaHotKeypair(network: Network, Keypair: any) {
    const raw = this.resolveWithdrawalPrivateKey(network);
    if (raw.startsWith('[')) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    }
    if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length > 80) {
      return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(raw, 'base64')));
    }
    return Keypair.fromSecretKey(Uint8Array.from(this.bs58Decode(raw)));
  }

  private resolveNetworkEnvPrefix(network: Network): string {
    if (network.rpcPrimaryEnv?.endsWith('_RPC_PRIMARY_URL')) {
      return network.rpcPrimaryEnv.replace(/_RPC_PRIMARY_URL$/, '');
    }
    return network.chainKey.toUpperCase().replace(/-/g, '_');
  }

  private resolveWithdrawalPrivateKey(network: Network): string {
    const prefix = this.resolveNetworkEnvPrefix(network);
    const key = this.config.get<string>(`${prefix}_WITHDRAWAL_PRIVATE_KEY`, '')?.trim();
    if (!key) {
      throw new ServiceUnavailableException(
        `${prefix}_WITHDRAWAL_PRIVATE_KEY is not configured for ${network.chainKey}`,
      );
    }
    return key.replace(/^0x/i, '');
  }

  private resolveBitcoinWithdrawalWif(network: Network): string {
    const prefix = this.resolveNetworkEnvPrefix(network);
    const wif = this.config.get<string>(`${prefix}_WITHDRAWAL_WIF`, '')?.trim();
    if (!wif) {
      throw new ServiceUnavailableException(
        `${prefix}_WITHDRAWAL_WIF is not configured for ${network.chainKey}`,
      );
    }
    return wif;
  }

  private bitcoinNetworkParams(network: Network, bitcoin: typeof import('bitcoinjs-lib')) {
    return network.legacyChain === Chain.BITCOIN ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  }

  private toSafeTronSunAmount(rawAmount: bigint): number {
    if (rawAmount <= 0n) {
      throw new ServiceUnavailableException('TRON withdrawal amount must be positive');
    }
    if (rawAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ServiceUnavailableException('TRON withdrawal amount exceeds supported precision');
    }
    return Number(rawAmount);
  }

  private async bitcoinRpc<T>(network: Network, method: string, params: unknown[]): Promise<T> {
    const url = new URL(this.resolveRpcUrl(network));
    const username = url.username;
    const password = url.password;
    url.username = '';
    url.password = '';
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(username || password
          ? {
              authorization: `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString('base64')}`,
            }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: randomBytes(8).toString('hex'),
        method,
        params,
      }),
    });
    const payload = await response.json() as { result?: T; error?: { message?: string } };
    if (!response.ok || payload.error) {
      throw new ServiceUnavailableException(payload.error?.message ?? `Bitcoin RPC ${method} failed`);
    }
    return payload.result as T;
  }

  private async scanBitcoinExplorerDeposits(input: {
    asset: Asset;
    tokenContract: NonEvmTokenContract;
    fromBlock: number;
    toBlock?: number;
    personalAddresses: Array<{ id: string; userId: string; address: string }>;
  }) {
    const latestBlock = await this.getLatestBlock(input.tokenContract.network);
    const toBlock = input.toBlock ?? latestBlock;
    const deposits: DetectedDeposit[] = [];
    let scannedTransactions = 0;

    for (const personal of input.personalAddresses) {
      const transactions = await this.listBitcoinExplorerAddressTransactions(
        input.tokenContract.network,
        personal.address,
      );
      for (const tx of transactions) {
        const blockNumber = tx.status?.block_height ?? 0;
        const isConfirmed = tx.status?.confirmed === true;
        if (isConfirmed) {
          if (blockNumber > toBlock) {
            continue;
          }
          if (blockNumber > 0 && blockNumber < input.fromBlock) {
            continue;
          }
        }
        scannedTransactions += 1;
        const outputs = tx.vout ?? [];
        for (let index = 0; index < outputs.length; index += 1) {
          const output = outputs[index];
          if (!output) {
            continue;
          }
          if (output.scriptpubkey_address !== personal.address || !output.value) {
            continue;
          }
          const rawAmount = String(output.value);
          deposits.push({
            depositAddressId: personal.id,
            userId: personal.userId,
            fromAddress: tx.vin?.[0]?.prevout?.scriptpubkey_address,
            toAddress: personal.address,
            txHash: tx.txid,
            outputIndex: index,
            blockNumber: isConfirmed ? blockNumber : undefined,
            amount: this.formatRawAmount(rawAmount, input.tokenContract.decimals),
            rawAmount,
            confirmations:
              isConfirmed && blockNumber > 0
                ? Math.max(0, latestBlock - blockNumber + 1)
                : 0,
          });
        }
      }
    }

    return { latestBlock, toBlock, scannedTransactions, deposits };
  }

  private async listBitcoinExplorerAddressTransactions(
    network: Network,
    address: string,
  ): Promise<BitcoinExplorerTx[]> {
    const transactions: BitcoinExplorerTx[] = [];
    let path = `/address/${address}/txs`;
    for (let page = 0; page < 20; page += 1) {
      const chunk = await this.bitcoinExplorerGet<BitcoinExplorerTx[]>(network, path);
      if (chunk.length === 0) {
        break;
      }
      transactions.push(...chunk);
      if (chunk.length < 25) {
        break;
      }
      const last = chunk[chunk.length - 1];
      if (!last) {
        break;
      }
      path = `/address/${address}/txs/chain/${last.txid}`;
    }
    return transactions;
  }

  private async bitcoinExplorerGet<T>(network: Network, path: string): Promise<T> {
    const base = this.resolveBitcoinExplorerUrl(network);
    const response = await fetch(`${base}${path}`);
    if (!response.ok) {
      throw new ServiceUnavailableException(`Bitcoin Signet API request failed: ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch (_error) {
      return text as T;
    }
  }

  private async bitcoinExplorerPostText(
    network: Network,
    path: string,
    body: string,
  ): Promise<string> {
    const base = this.resolveBitcoinExplorerUrl(network);
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ServiceUnavailableException(text || `Bitcoin Signet API request failed: ${response.status}`);
    }
    return text.trim();
  }

  private shouldUseBitcoinExplorerForDeposits(network: Network): boolean {
    if (this.usesBitcoinExplorer(network)) {
      return true;
    }
    const configured = this.config
      .get<string>(`${this.resolveNetworkEnvPrefix(network)}_EXPLORER_URL`, '')
      .trim();
    return Boolean(configured);
  }

  private usesBitcoinExplorer(network: Network): boolean {
    if (network.family !== NetworkFamily.UTXO) {
      return false;
    }
    const raw = this.resolveRpcUrl(network);
    return !raw || /mempool\.space|blockstream\.info|\/api\/?$/i.test(raw);
  }

  private resolveBitcoinExplorerUrl(network: Network): string {
    const override = this.config
      .get<string>(`${this.resolveNetworkEnvPrefix(network)}_EXPLORER_URL`, '')
      .trim();
    if (override) {
      return override.replace(/\/$/, '');
    }
    const configured = this.resolveRpcUrl(network);
    if (configured && /mempool\.space|blockstream\.info|\/api\/?$/i.test(configured)) {
      return configured.replace(/\/$/, '');
    }
    return network.legacyChain === Chain.BITCOIN
      ? 'https://mempool.space/api'
      : 'https://mempool.space/signet/api';
  }

  private async resolveTronTransactionBlockNumber(
    network: Network,
    txHash: string,
    cache: Map<string, number>,
  ): Promise<number> {
    const cached = cache.get(txHash);
    if (cached) {
      return cached;
    }
    const info = await this.tronPost<{ blockNumber?: number; block_number?: number }>(
      network,
      '/wallet/gettransactioninfobyid',
      { value: txHash },
    );
    const blockNumber = Number(info.blockNumber ?? info.block_number ?? 0);
    if (blockNumber > 0) {
      cache.set(txHash, blockNumber);
    }
    return blockNumber;
  }

  private async tronGridGet<T>(network: Network, path: string): Promise<T> {
    const base = this.resolveTronGridBaseUrl(network).replace(/\/$/, '');
    const response = await fetch(`${base}${path}`, {
      headers: this.tronApiHeaders(network),
    });
    if (!response.ok) {
      throw new ServiceUnavailableException(`TRON API request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  private async tronPost<T>(network: Network, path: string, body: unknown): Promise<T> {
    const base = this.resolveRpcUrl(network).replace(/\/$/, '');
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: this.tronApiHeaders(network, true),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new ServiceUnavailableException(`TRON API request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  private async getTronLatestBlock(network: Network): Promise<number> {
    const block = await this.tronPost<any>(network, '/wallet/getnowblock', {});
    return Number(block?.block_header?.raw_data?.number ?? 0);
  }

  private async importTronWeb(): Promise<any> {
    const mod = await import('tronweb');
    return (mod as any).TronWeb ?? (mod as any).default ?? mod;
  }

  private createTronWeb(network: Network, privateKey?: string): any {
    const TronWeb = require('tronweb').TronWeb ?? require('tronweb');
    return new TronWeb({
      fullHost: this.resolveRpcUrl(network),
      headers: this.tronApiHeaders(network),
      ...(privateKey ? { privateKey } : {}),
    });
  }

  private tronApiHeaders(network: Network, json = false): Record<string, string> {
    const apiKey = this.config.get<string>(
      network.chainKey === 'tron-nile' ? 'TRON_NILE_PRO_API_KEY' : 'TRON_PRO_API_KEY',
      '',
    ).trim();
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}),
    };
  }

  private tronHexAddress(network: Network, address: string): string {
    return this.createTronWeb(network).address.toHex(address);
  }

  private tronBase58Address(network: Network, hexAddress: string): string {
    return this.createTronWeb(network).address.fromHex(hexAddress);
  }

  private resolveRpcUrl(network: Network): string {
    const primary = network.rpcPrimaryEnv ? this.config.get<string>(network.rpcPrimaryEnv, '') : '';
    const fallback = network.rpcFallbackEnv ? this.config.get<string>(network.rpcFallbackEnv, '') : '';
    return (primary || fallback || '').trim();
  }

  private resolveTronGridBaseUrl(network: Network): string {
    const prefix = this.resolveNetworkEnvPrefix(network);
    const configured = this.config.get<string>(`${prefix}_GRID_API_URL`, '').trim();
    if (configured) {
      return configured;
    }
    if (network.chainKey === 'tron-nile') {
      return 'https://nile.trongrid.io';
    }
    if (network.chainKey === 'tron-shasta') {
      return 'https://api.shasta.trongrid.io';
    }
    return 'https://api.trongrid.io';
  }

  private encodeSecret(secret: DepositAddressSecret): string {
    return `testnet-secret:v1:${Buffer.from(JSON.stringify(secret), 'utf8').toString('base64url')}`;
  }

  private formatRawAmount(rawAmount: string, decimals: number): string {
    const raw = BigInt(rawAmount);
    const scale = 10n ** BigInt(decimals);
    const whole = raw / scale;
    const fraction = raw % scale;
    if (fraction === 0n) {
      return whole.toString();
    }
    return `${whole}.${fraction.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
  }

  private parseRawAmount(amount: string, decimals: number): bigint {
    const [whole, fraction = ''] = amount.split('.');
    const normalizedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(normalizedFraction || '0');
  }

  private btcToSats(amountBtc: string): bigint {
    return this.parseRawAmount(amountBtc, 8);
  }

  private bs58Decode(value: string): Buffer {
    const mod = require('bs58');
    const decode = mod.default?.decode ?? mod.decode;
    return Buffer.from(decode(value));
  }
}
