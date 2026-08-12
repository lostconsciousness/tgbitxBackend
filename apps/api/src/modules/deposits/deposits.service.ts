import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  Chain,
  CustodyAccountRole,
  CustodyAccountStatus,
  DepositChannel,
  DepositIntentStatus,
  DepositStatus,
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
  NetworkFamily,
  Prisma,
  TokenStandard,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  Address,
  Hex,
  decodeEventLog,
  formatUnits,
  getAddress,
  parseAbiItem,
  parseUnits,
} from 'viem';
import { PrismaService } from '../../database/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletsService } from '../wallets/wallets.service';
import { RPC_PROVIDER } from '../rpc/rpc.module';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { DepositAddressService } from './deposit-address.service';
import { AssetValuationService } from '../account/asset-valuation.service';
import { NonEvmTestnetAdapterService } from '../onchain/non-evm-testnet-adapter.service';
import { PrivateRealtimeGateway } from '../realtime/private-realtime.gateway';

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assetsService: AssetsService,
    private readonly walletsService: WalletsService,
    private readonly ledgerService: LedgerService,
    private readonly config: ConfigService,
    @Inject(RPC_PROVIDER) private readonly rpcProvider: RpcProvider,
    private readonly depositAddresses: DepositAddressService,
    private readonly assetValuation: AssetValuationService,
    private readonly nonEvm: NonEvmTestnetAdapterService,
    @Optional() private readonly realtime?: PrivateRealtimeGateway,
  ) {}

  async createIntent(input: {
    userId: string;
    assetSymbol: string;
    amount: string;
    walletId: string;
    network?: string;
  }) {
    const target = await this.getDepositTarget(input.assetSymbol, input.network);
    const { asset, tokenContract, network } = target;

    let rawAmount: bigint;
    try {
      rawAmount = parseUnits(input.amount, tokenContract.decimals);
    } catch (_error) {
      throw new BadRequestException('Invalid deposit amount precision');
    }
    if (rawAmount <= 0n) {
      throw new BadRequestException('Deposit amount must be positive');
    }

    const wallet = await this.prisma.wallet.findFirst({
      where: {
        id: input.walletId,
        userId: input.userId,
        status: 'ACTIVE',
      },
    });
    if (!wallet) {
      throw new BadRequestException('Active deposit wallet was not found');
    }
    this.assertWalletSupportsNetwork(wallet.chain, network.family);

    const personalAddress = await this.depositAddresses.provision(
      input.userId,
      asset.symbol,
      network.chainKey,
    );
    const ttlSeconds = this.config.get<number>('DEPOSIT_INTENT_TTL_SECONDS', 900);

    const intent = await this.prisma.$transaction(async (tx) => {
      await tx.depositIntent.updateMany({
        where: {
          userId: input.userId,
          walletId: wallet.id,
          assetId: asset.id,
          tokenContractId: tokenContract.id,
          status: {
            in: [
              DepositIntentStatus.PENDING,
              DepositIntentStatus.SUBMITTED,
              DepositIntentStatus.DETECTED,
              DepositIntentStatus.CONFIRMED,
            ],
          },
        },
        data: {
          status: DepositIntentStatus.CANCELLED,
          failureReason: 'Superseded by a newer deposit intent',
        },
      });
      return tx.depositIntent.create({
        data: {
          userId: input.userId,
          assetId: asset.id,
          tokenContractId: tokenContract.id,
          walletId: wallet.id,
          network: target.legacyChain,
          fromAddress: wallet.address,
          treasuryAddress: personalAddress.address.toLowerCase(),
          amount: new Prisma.Decimal(input.amount),
          rawAmount: rawAmount.toString(),
          expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return {
      id: intent.id,
      status: intent.status,
      expiresAt: intent.expiresAt,
      transfer: {
        network: network.chainKey,
        caip2: network.caip2,
        chainId: network.chainId,
        tokenStandard: tokenContract.standard,
        tokenAddress: tokenContract.address ? getAddress(tokenContract.address) : null,
        recipient: this.formatAddressForNetwork(intent.treasuryAddress, network.family),
        amount: intent.amount.toString(),
        rawAmount: intent.rawAmount,
        decimals: tokenContract.decimals,
        assetSymbol: asset.symbol,
        fromAddress: this.formatAddressForNetwork(intent.fromAddress, network.family),
        memo: null,
        tag: null,
      },
    };
  }

  async submitIntent(input: { userId: string; intentId: string; txHash: string }) {
    const intent = await this.prisma.depositIntent.findFirst({
      where: { id: input.intentId, userId: input.userId },
      include: { asset: true, tokenContract: { include: { network: true } }, wallet: true, deposit: true },
    });
    if (!intent) {
      throw new NotFoundException('Deposit intent not found');
    }
    if (intent.status === DepositIntentStatus.CREDITED) {
      return intent;
    }
    if (intent.expiresAt.getTime() <= Date.now() && !intent.txHash) {
      await this.prisma.depositIntent.update({
        where: { id: intent.id },
        data: { status: DepositIntentStatus.EXPIRED },
      });
      throw new BadRequestException('Deposit intent has expired');
    }
    if (!intent.tokenContract) {
      throw new BadRequestException('Deposit token contract is not configured');
    }
    if (intent.tokenContract.network.family !== NetworkFamily.EVM) {
      return this.prisma.depositIntent.update({
        where: { id: intent.id },
        data: {
          txHash: input.txHash,
          status: DepositIntentStatus.SUBMITTED,
          submittedAt: intent.submittedAt ?? new Date(),
        },
      });
    }

    const tx = await this.rpcProvider.getTransaction(
      input.txHash,
      intent.tokenContract.network.chainKey,
    );
    if (intent.tokenContract.standard === TokenStandard.NATIVE) {
      return this.submitNativeIntent({ intent, txHash: input.txHash, tx });
    }
    if (!intent.tokenContract.address) {
      throw new BadRequestException('Deposit asset is not an ERC20 token');
    }

    if (!tx.blockNumber) {
      return this.prisma.depositIntent.update({
        where: { id: intent.id },
        data: {
          txHash: input.txHash.toLowerCase(),
          status: DepositIntentStatus.SUBMITTED,
          submittedAt: new Date(),
        },
      });
    }
    if (tx.status === 0) {
      throw new BadRequestException('Deposit transaction reverted');
    }

    const logs =
      tx.logs ??
      (await this.rpcProvider.getLogs({
        networkKey: intent.tokenContract.network.chainKey,
        address: intent.tokenContract.address,
        fromBlock: tx.blockNumber,
        toBlock: tx.blockNumber,
      }));
    const matchingLog = logs.find((log) => {
      if (log.transactionHash.toLowerCase() !== input.txHash.toLowerCase()) {
        return false;
      }
      if (log.address.toLowerCase() !== intent.tokenContract!.address!.toLowerCase()) {
        return false;
      }
      try {
        const parsed = decodeEventLog({
          abi: [TRANSFER_EVENT],
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data as Hex,
        });
        const args = parsed.args as { from: Address; to: Address; value: bigint };
        return (
          getAddress(args.from).toLowerCase() === intent.fromAddress.toLowerCase() &&
          getAddress(args.to).toLowerCase() === intent.treasuryAddress.toLowerCase() &&
          args.value.toString() === intent.rawAmount
        );
      } catch (_error) {
        return false;
      }
    });
    if (!matchingLog) {
      throw new BadRequestException('ERC20 transfer does not match deposit intent');
    }

    const latestBlock = await this.rpcProvider.getLatestBlockNumber(
      intent.tokenContract.network.chainKey,
    );
    const requiredConfirmations = intent.tokenContract.network.confirmations;
    const confirmations = Math.max(0, latestBlock - tx.blockNumber + 1);
    const deposit = await this.recordDetectedDeposit({
      intentId: intent.id,
      assetId: intent.assetId,
      tokenContractId: intent.tokenContractId ?? undefined,
      network: intent.network,
      fromAddress: intent.fromAddress,
      toAddress: intent.treasuryAddress,
      txHash: input.txHash.toLowerCase(),
      logIndex: matchingLog.logIndex,
      blockNumber: matchingLog.blockNumber,
      amount: intent.amount.toString(),
      rawAmount: intent.rawAmount,
      confirmations,
    });

    await this.prisma.depositIntent.update({
      where: { id: intent.id },
      data: {
        txHash: input.txHash.toLowerCase(),
        submittedAt: intent.submittedAt ?? new Date(),
        detectedAt: new Date(),
        confirmedAt:
          confirmations >= requiredConfirmations
            ? new Date()
            : undefined,
        creditedAt: deposit.status === DepositStatus.CREDITED ? new Date() : undefined,
        status:
          deposit.status === DepositStatus.CREDITED
            ? DepositIntentStatus.CREDITED
            : confirmations >= requiredConfirmations
              ? DepositIntentStatus.CONFIRMED
              : DepositIntentStatus.DETECTED,
      },
      include: { asset: true, wallet: true, deposit: true },
    });

    return this.prisma.depositIntent.findUniqueOrThrow({
      where: { id: intent.id },
      include: { asset: true, wallet: true, deposit: true },
    });
  }

  private assertWalletSupportsNetwork(
    walletChain: Chain,
    networkFamily: NetworkFamily,
  ): void {
    const nonEvmChains = new Set<Chain>([
      Chain.SOLANA,
      Chain.SOLANA_DEVNET,
      Chain.BITCOIN,
      Chain.BITCOIN_SIGNET,
      Chain.TRON,
      Chain.TRON_NILE,
      Chain.TRON_SHASTA,
    ]);
    const svmChains = new Set<Chain>([Chain.SOLANA, Chain.SOLANA_DEVNET]);
    const utxoChains = new Set<Chain>([Chain.BITCOIN, Chain.BITCOIN_SIGNET]);
    const tronChains = new Set<Chain>([
      Chain.TRON,
      Chain.TRON_NILE,
      Chain.TRON_SHASTA,
    ]);
    const compatible =
      networkFamily === NetworkFamily.EVM
        ? !nonEvmChains.has(walletChain)
        : networkFamily === NetworkFamily.SVM
          ? svmChains.has(walletChain)
          : networkFamily === NetworkFamily.UTXO
            ? utxoChains.has(walletChain)
            : tronChains.has(walletChain);
    if (!compatible) {
      throw new BadRequestException({
        code: 'DEPOSIT_WALLET_NETWORK_MISMATCH',
        message: `Selected wallet does not support ${networkFamily} deposits`,
      });
    }
  }

  private async submitNativeIntent(input: {
    intent: {
      id: string;
      assetId: string;
      tokenContractId: string | null;
      network: Chain;
      fromAddress: string;
      treasuryAddress: string;
      rawAmount: string;
      amount: { toString(): string };
      submittedAt: Date | null;
      tokenContract: {
        decimals: number;
        network: { chainKey: string; confirmations: number };
      } | null;
    };
    txHash: string;
    tx: {
      from?: string;
      to?: string | null;
      value?: string;
      blockNumber?: number;
      status?: number;
    };
  }) {
    const { intent, txHash, tx } = input;
    if (
      !tx.from ||
      getAddress(tx.from).toLowerCase() !== intent.fromAddress.toLowerCase() ||
      !tx.to ||
      getAddress(tx.to).toLowerCase() !== intent.treasuryAddress.toLowerCase() ||
      BigInt(tx.value ?? '0').toString() !== intent.rawAmount
    ) {
      throw new BadRequestException('Transaction does not match native deposit intent');
    }

    if (!tx.blockNumber) {
      return this.prisma.depositIntent.update({
        where: { id: intent.id },
        data: {
          txHash: txHash.toLowerCase(),
          status: DepositIntentStatus.SUBMITTED,
          submittedAt: new Date(),
        },
      });
    }
    if (tx.status === 0) {
      throw new BadRequestException('Deposit transaction reverted');
    }

    const latestBlock = await this.rpcProvider.getLatestBlockNumber(
      intent.tokenContract!.network.chainKey,
    );
    const confirmations = Math.max(0, latestBlock - tx.blockNumber + 1);
    const deposit = await this.recordDetectedDeposit({
      intentId: intent.id,
      assetId: intent.assetId,
      tokenContractId: intent.tokenContractId ?? undefined,
      network: intent.network,
      fromAddress: intent.fromAddress,
      toAddress: intent.treasuryAddress,
      txHash: txHash.toLowerCase(),
      blockNumber: tx.blockNumber,
      amount: formatUnits(BigInt(intent.rawAmount), intent.tokenContract!.decimals),
      rawAmount: intent.rawAmount,
      confirmations,
    });

    await this.prisma.depositIntent.update({
      where: { id: intent.id },
      data: {
        txHash: txHash.toLowerCase(),
        submittedAt: intent.submittedAt ?? new Date(),
        detectedAt: new Date(),
        confirmedAt:
          confirmations >= intent.tokenContract!.network.confirmations
            ? new Date()
            : undefined,
        creditedAt: deposit.status === DepositStatus.CREDITED ? new Date() : undefined,
        status:
          deposit.status === DepositStatus.CREDITED
            ? DepositIntentStatus.CREDITED
            : confirmations >= intent.tokenContract!.network.confirmations
              ? DepositIntentStatus.CONFIRMED
              : DepositIntentStatus.DETECTED,
      },
    });

    return this.prisma.depositIntent.findUniqueOrThrow({
      where: { id: intent.id },
      include: { asset: true, wallet: true, deposit: true },
    });
  }

  async getIntent(userId: string, intentId: string) {
    const intent = await this.prisma.depositIntent.findFirst({
      where: { id: intentId, userId },
      include: {
        asset: true,
        wallet: true,
        deposit: true,
        tokenContract: { include: { network: true } },
      },
    });
    if (!intent) {
      throw new NotFoundException('Deposit intent not found');
    }

    const refreshed = await this.refreshIntentConfirmationState(intent);
    return this.toUserDepositIntentResponse(refreshed);
  }

  async creditReadyDeposits(limit = 50): Promise<number> {
    const ready = await this.prisma.deposit.findMany({
      where: {
        status: DepositStatus.DETECTED,
        userId: { not: null },
        OR: [{ intentId: null }, { intent: { status: DepositIntentStatus.CONFIRMED } }],
      },
      take: limit,
      orderBy: { updatedAt: 'asc' },
    });

    let credited = 0;
    for (const deposit of ready) {
      try {
        const result = await this.creditDeposit(deposit.id);
        if (result.status === DepositStatus.CREDITED) {
          credited += 1;
        }
      } catch (_error) {
        // Skip deposits that fail idempotent credit or race with another worker.
      }
    }
    return credited;
  }

  private async refreshIntentConfirmationState(
    intent: NonNullable<Awaited<ReturnType<DepositsService['loadIntentForRefresh']>>>,
  ) {
    if (!intent.tokenContract) {
      return intent;
    }

    if (intent.txHash && (!intent.deposit || intent.deposit.blockNumber === null)) {
      try {
        await this.submitIntent({
          userId: intent.userId,
          intentId: intent.id,
          txHash: intent.txHash,
        });
      } catch (_error) {
        // Transaction may still be pending in the mempool.
      }
      intent = await this.loadIntentForRefresh(intent.id, intent.userId);
    }

    const deposit = intent.deposit;
    const tokenContract = intent.tokenContract;
    if (
      deposit &&
      tokenContract &&
      deposit.blockNumber !== null &&
      deposit.status !== DepositStatus.CREDITED
    ) {
      const latestBlock = await this.rpcProvider.getLatestBlockNumber(
        tokenContract.network.chainKey,
      );
      await this.recordDetectedDeposit({
        intentId: intent.id,
        assetId: intent.assetId,
        tokenContractId: intent.tokenContractId ?? undefined,
        network: intent.network,
        fromAddress: deposit.fromAddress ?? intent.fromAddress,
        toAddress: deposit.toAddress,
        txHash: deposit.txHash,
        logIndex: deposit.logIndex ?? undefined,
        blockNumber: deposit.blockNumber,
        amount: deposit.amount.toString(),
        rawAmount: deposit.rawAmount ?? undefined,
        confirmations: Math.max(0, latestBlock - deposit.blockNumber + 1),
      });
      intent = await this.loadIntentForRefresh(intent.id, intent.userId);
    }

    if (
      intent.deposit &&
      intent.deposit.status === DepositStatus.DETECTED &&
      intent.status !== DepositIntentStatus.CREDITED
    ) {
      await this.creditDeposit(intent.deposit.id);
      intent = await this.loadIntentForRefresh(intent.id, intent.userId);
    }

    return intent;
  }

  private loadIntentForRefresh(intentId: string, userId: string) {
    return this.prisma.depositIntent.findFirstOrThrow({
      where: { id: intentId, userId },
      include: {
        asset: true,
        wallet: true,
        deposit: true,
        tokenContract: { include: { network: true } },
      },
    });
  }

  private toUserDepositIntentResponse(
    intent: NonNullable<Awaited<ReturnType<DepositsService['loadIntentForRefresh']>>>,
  ) {
    const requiredConfirmations =
      intent.tokenContract?.network.confirmations ??
      this.config.get<number>('DEPOSIT_CONFIRMATIONS', 12);
    const confirmations = intent.deposit?.confirmations ?? 0;
    const depositStatus = intent.deposit?.status ?? null;
    const isConfirmed =
      confirmations >= requiredConfirmations ||
      intent.status === DepositIntentStatus.CONFIRMED ||
      intent.status === DepositIntentStatus.CREDITED;
    const isCredited = intent.status === DepositIntentStatus.CREDITED;
    const progressStep = this.resolveDepositProgressStep(intent.status, isCredited);
    const network = intent.tokenContract?.network;

    return {
      id: intent.id,
      status: intent.status,
      progressStep,
      asset: {
        id: intent.asset.id,
        symbol: intent.asset.symbol,
        name: intent.asset.name,
        iconUrl: intent.asset.iconUrl,
        type: intent.asset.type,
        decimals: intent.asset.decimals,
      },
      network: network
        ? {
            network: network.chainKey,
            displayName: network.displayName,
            iconUrl: network.iconUrl,
            caip2: network.caip2,
            chainId: network.chainId,
          }
        : {
            network: intent.network,
            displayName: intent.network,
            iconUrl: null,
            caip2: null,
            chainId: null,
          },
      fromAddress: intent.fromAddress,
      depositAddress: intent.treasuryAddress,
      amount: intent.amount.toString(),
      rawAmount: intent.rawAmount,
      txHash: intent.txHash,
      expiresAt: intent.expiresAt,
      submittedAt: intent.submittedAt,
      detectedAt: intent.detectedAt,
      confirmedAt: intent.confirmedAt,
      creditedAt: intent.creditedAt,
      failureReason: intent.failureReason,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
      confirmations,
      requiredConfirmations,
      depositStatus,
      isConfirmed,
      isCredited,
      deposit: intent.deposit
        ? {
            id: intent.deposit.id,
            status: intent.deposit.status,
            confirmations: intent.deposit.confirmations,
            blockNumber: intent.deposit.blockNumber,
            txHash: intent.deposit.txHash,
            creditedAt: intent.deposit.creditedAt,
          }
        : null,
      wallet: intent.wallet
        ? {
            id: intent.wallet.id,
            address: intent.wallet.address,
            chain: intent.wallet.chain,
            type: intent.wallet.type,
            provider: intent.wallet.provider,
          }
        : null,
    };
  }

  async listDepositOptions(input: { userId: string; includeDisabled?: boolean }) {
    const includeDisabled = input.includeDisabled ?? false;
    const mainnetOnly = this.isMainnetDisplayMode();
    const contracts = await this.prisma.tokenContract.findMany({
      where: includeDisabled
        ? mainnetOnly
          ? { network: { mainnet: true } }
          : undefined
        : {
            depositEnabled: true,
            network: {
              depositEnabled: true,
              ...(mainnetOnly ? { mainnet: true } : {}),
              family: { in: [NetworkFamily.EVM, NetworkFamily.SVM, NetworkFamily.UTXO, NetworkFamily.TVM] },
            },
            OR: [
              { standard: TokenStandard.NATIVE },
              { standard: TokenStandard.BTC },
              {
                standard: TokenStandard.ERC20,
                address: { not: null },
                contractVerifiedAt: { not: null },
                contractCodeHash: { not: null },
              },
              {
                standard: TokenStandard.SPL,
                address: { not: null },
                contractVerifiedAt: { not: null },
              },
              {
                standard: TokenStandard.TRC20,
                address: { not: null },
                contractVerifiedAt: { not: null },
              },
            ],
          },
      include: {
        asset: true,
        network: true,
      },
    });
    const grouped = new Map<
      string,
      {
        id: string;
        symbol: string;
        name: string;
        iconUrl: string | null;
        type: string;
        decimals: number;
        availableBalance: string;
        networks: Array<ReturnType<DepositsService['toDepositOptionNetwork']>>;
      }
    >();

    for (const contract of contracts) {
      const asset = grouped.get(contract.asset.symbol) ?? {
        id: contract.asset.id,
        symbol: contract.asset.symbol,
        name: contract.asset.name,
        iconUrl: contract.asset.iconUrl,
        type: contract.asset.type,
        decimals: contract.asset.decimals,
        availableBalance: '0',
        networks: [],
      };
      asset.networks.push(this.toDepositOptionNetwork(contract));
      grouped.set(contract.asset.symbol, asset);
    }

    const assets = await Promise.all(
      [...grouped.values()].map(async (asset) => ({
        ...asset,
        availableBalance: (
          await this.ledgerService.getUserSpotBalance({
            userId: input.userId,
            assetId: asset.id,
          })
        ).toString(),
        networks: asset.networks.sort((left, right) =>
          left.network.localeCompare(right.network),
        ),
      })),
    );

    return {
      balanceScope: 'EXCHANGE_LEDGER' as const,
      assets: await this.assetValuation.enrichAndSortByBalanceUsdc(
        assets,
        (asset) => asset.availableBalance,
      ),
    };
  }

  async getDepositInstructions(input: { userId: string; assetSymbol: string; network?: string }) {
    const target = await this.getDepositTarget(input.assetSymbol, input.network);

    const personalAddress = await this.depositAddresses.getExisting(
      input.userId,
      target.asset.symbol,
      target.network.chainKey,
    );

    return {
      network: target.network.chainKey,
      caip2: target.network.caip2,
      chainId: target.network.chainId,
      asset: {
        id: target.asset.id,
        symbol: target.asset.symbol,
        name: target.asset.name,
        iconUrl: target.asset.iconUrl,
        tokenAddress: target.tokenContract.address,
        tokenStandard: target.tokenContract.standard,
        decimals: target.tokenContract.decimals,
      },
      depositAddress: personalAddress.address,
      requiredConfirmations: target.network.confirmations,
      matchRule:
        target.tokenContract.standard === TokenStandard.NATIVE
          ? 'Native deposits are matched by personal destination address and transaction value.'
          : `${target.tokenContract.standard} deposits are matched by token contract/mint and personal destination address.`,
      memo: null,
      tag: null,
      acceptsFromAnyAddress: true,
    };
  }

  listUserDeposits(userId: string) {
    return this.prisma.deposit.findMany({
      where: { userId },
      include: { asset: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  listAdminDeposits(take = 100) {
    return this.prisma.deposit.findMany({
      take: Math.min(take, 200),
      include: { asset: true, user: true, wallet: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async reclassifySweepGasFundingDeposits(network: Chain): Promise<number> {
    const gasAccounts = await this.prisma.custodyAccount.findMany({
      where: {
        role: CustodyAccountRole.SWEEP_GAS,
        network,
      },
      select: { address: true },
    });
    const gasAddresses = gasAccounts.map((account) =>
      this.normalizeAddressForStorage(account.address, network),
    );
    if (gasAddresses.length === 0) {
      return 0;
    }

    const deposits = await this.prisma.deposit.findMany({
      where: {
        network,
        fromAddress: { in: gasAddresses },
        depositAddressId: { not: null },
        userId: { not: null },
        tokenContract: { standard: TokenStandard.NATIVE },
        status: {
          in: [
            DepositStatus.PENDING_CONFIRMATION,
            DepositStatus.DETECTED,
            DepositStatus.CREDITED,
          ],
        },
      },
      select: { id: true },
      take: 100,
    });

    let reclassified = 0;
    for (const candidate of deposits) {
      const userId = await this.prisma.$transaction(async (tx) => {
        const deposit = await tx.deposit.findUnique({
          where: { id: candidate.id },
          include: { asset: true },
        });
        if (!deposit?.userId || !gasAddresses.includes(deposit.fromAddress ?? '')) {
          return null;
        }
        if (deposit.status === DepositStatus.CREDITED) {
          if (!deposit.creditedLedgerTransactionId) {
            throw new BadRequestException(
              'Credited sweep gas funding deposit is missing its ledger transaction',
            );
          }
          await this.ledgerService.postTransaction({
            type: LedgerTransactionType.ADMIN_ADJUSTMENT,
            idempotencyKey: `sweep-gas-funding-reversal:${deposit.id}`,
            referenceType: 'Deposit',
            referenceId: deposit.id,
            description: `Reverse internal ${deposit.asset.symbol} sweep gas funding`,
            metadata: {
              reason: 'INTERNAL_SWEEP_GAS_FUNDING',
              txHash: deposit.txHash,
            },
            entries: [
              {
                accountType: LedgerAccountType.USER_SPOT,
                userId: deposit.userId,
                assetId: deposit.assetId,
                direction: LedgerEntryDirection.DEBIT,
                amount: deposit.amount,
              },
              {
                accountType: LedgerAccountType.PENDING_DEPOSIT,
                assetId: deposit.assetId,
                direction: LedgerEntryDirection.CREDIT,
                amount: deposit.amount,
              },
            ],
          }, tx);
        }
        await tx.deposit.update({
          where: { id: deposit.id },
          data: {
            userId: null,
            channel: DepositChannel.UNMATCHED,
            status: DepositStatus.UNMATCHED,
            creditedAt: null,
          },
        });
        return deposit.userId;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (userId) {
        reclassified += 1;
        void this.realtime?.notifyUserBalancesUpdated(userId);
      }
    }
    return reclassified;
  }

  async isInternalTronSweepGasFunding(input: {
    txHash: string;
    fromAddress?: string;
  }): Promise<boolean> {
    const linkedSweep = await this.prisma.depositSweep.findFirst({
      where: { gasFundingTxHash: input.txHash },
      select: { id: true },
    });
    if (linkedSweep) return true;
    return this.nonEvm.isTronTreasuryTransfer(input.fromAddress);
  }

  async shouldSkipInternalPersonalDepositTransfer(input: {
    userId: string;
    fromAddress?: string;
    network: Chain;
  }): Promise<boolean> {
    return this.isInternalDepositAddressTransfer({
      userId: input.userId,
      fromAddress: input.fromAddress,
      network: input.network,
    });
  }

  async reclassifyInternalDepositAddressTransferDeposits(network: Chain): Promise<number> {
    const deposits = await this.prisma.deposit.findMany({
      where: {
        network,
        depositAddressId: { not: null },
        userId: { not: null },
        fromAddress: { not: null },
        status: {
          in: [
            DepositStatus.PENDING_CONFIRMATION,
            DepositStatus.DETECTED,
            DepositStatus.CREDITED,
          ],
        },
      },
      select: { id: true },
      take: 200,
    });

    let reclassified = 0;
    for (const candidate of deposits) {
      const userId = await this.prisma.$transaction(async (tx) => {
        const deposit = await tx.deposit.findUnique({
          where: { id: candidate.id },
          include: { asset: true },
        });
        if (!deposit?.userId || !deposit.fromAddress) {
          return null;
        }
        if (
          !(await this.isInternalDepositAddressTransfer(
            {
              userId: deposit.userId,
              fromAddress: deposit.fromAddress,
              network: deposit.network,
              excludeDepositId: deposit.id,
            },
            tx,
          ))
        ) {
          return null;
        }
        if (deposit.status === DepositStatus.CREDITED) {
          if (!deposit.creditedLedgerTransactionId) {
            throw new BadRequestException(
              'Credited internal deposit transfer is missing its ledger transaction',
            );
          }
          await this.ledgerService.postTransaction({
            type: LedgerTransactionType.ADMIN_ADJUSTMENT,
            idempotencyKey: `internal-deposit-transfer-reversal:${deposit.id}`,
            referenceType: 'Deposit',
            referenceId: deposit.id,
            description: `Reverse internal ${deposit.asset.symbol} deposit address transfer`,
            metadata: {
              reason: 'INTERNAL_DEPOSIT_ADDRESS_TRANSFER',
              txHash: deposit.txHash,
            },
            entries: [
              {
                accountType: LedgerAccountType.USER_SPOT,
                userId: deposit.userId,
                assetId: deposit.assetId,
                direction: LedgerEntryDirection.DEBIT,
                amount: deposit.amount,
              },
              {
                accountType: LedgerAccountType.PENDING_DEPOSIT,
                assetId: deposit.assetId,
                direction: LedgerEntryDirection.CREDIT,
                amount: deposit.amount,
              },
            ],
          }, tx);
        }
        await tx.deposit.update({
          where: { id: deposit.id },
          data: {
            userId: null,
            channel: DepositChannel.UNMATCHED,
            status: DepositStatus.UNMATCHED,
            creditedAt: null,
          },
        });
        return deposit.userId;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (userId) {
        reclassified += 1;
        void this.realtime?.notifyUserBalancesUpdated(userId);
      }
    }
    return reclassified;
  }

  private async isInternalDepositAddressTransfer(
    input: {
      userId: string;
      fromAddress?: string;
      network: Chain;
      excludeDepositId?: string;
    },
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    if (!input.fromAddress?.trim()) {
      return false;
    }
    const fromAddress = this.normalizeAddressForStorage(input.fromAddress, input.network);
    const fromOwnDepositAddress = await client.userDepositAddress.findFirst({
      where: {
        userId: input.userId,
        network: input.network,
        address: fromAddress,
      },
      select: { id: true },
    });
    if (fromOwnDepositAddress) {
      return true;
    }
    const priorCreditedToSource = await client.deposit.findFirst({
      where: {
        userId: input.userId,
        network: input.network,
        toAddress: fromAddress,
        status: DepositStatus.CREDITED,
        depositAddressId: { not: null },
        ...(input.excludeDepositId ? { id: { not: input.excludeDepositId } } : {}),
      },
      select: { id: true },
    });
    return Boolean(priorCreditedToSource);
  }

  async recordDetectedDeposit(input: {
    intentId?: string;
    depositAddressId?: string;
    userId?: string;
    channel?: DepositChannel;
    network?: Chain;
    tokenContractId?: string;
    rawAmount?: string;
    requireIntent?: boolean;
    assetId: string;
    fromAddress?: string;
    toAddress: string;
    txHash: string;
    logIndex?: number;
    blockNumber?: number;
    amount: string;
    confirmations: number;
    forceUnmatched?: boolean;
  }) {
    return this.prisma.$transaction(
      (tx) => this.recordDetectedDepositInTransaction(input, tx),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async recordDetectedDepositInTransaction(
    input: {
      intentId?: string;
      depositAddressId?: string;
      userId?: string;
      channel?: DepositChannel;
      network?: Chain;
      tokenContractId?: string;
      rawAmount?: string;
      requireIntent?: boolean;
      assetId: string;
      fromAddress?: string;
      toAddress: string;
      txHash: string;
      logIndex?: number;
      blockNumber?: number;
      amount: string;
      confirmations: number;
      forceUnmatched?: boolean;
    },
    client: Prisma.TransactionClient,
  ) {
    const network = input.network ?? this.resolveLegacyNetwork();
    const idempotencyKey = `${network.toLowerCase()}:${input.txHash}:${input.logIndex ?? 'native'}`;
    let existing = await client.deposit.findUnique({
      where: { idempotencyKey },
      include: { asset: true },
    });
    existing ??= await client.deposit.findFirst({
      where: {
        network,
        txHash: input.txHash,
        ...(network === Chain.TRON && input.logIndex === undefined
          ? { OR: [{ logIndex: null }, { logIndex: 0 }] }
          : { logIndex: input.logIndex ?? null }),
      },
      include: { asset: true },
    });

    if (existing) {
      const requiredConfirmations = await this.resolveRequiredConfirmations(
        existing.tokenContractId ?? input.tokenContractId,
        client,
      );
      if (input.intentId && !existing.intentId) {
        const intent = await client.depositIntent.findUnique({
          where: { id: input.intentId },
        });
        if (intent) {
          const linked = await client.deposit.update({
            where: { id: existing.id },
            data: {
              intentId: intent.id,
              userId: intent.userId,
              walletId: intent.walletId,
              tokenContractId: intent.tokenContractId,
              status:
                input.confirmations >= requiredConfirmations
                  ? DepositStatus.DETECTED
                  : DepositStatus.PENDING_CONFIRMATION,
              confirmations: input.confirmations,
            },
            include: { asset: true },
          });
          await this.syncIntentStatus(client, intent.id, linked);
          if (linked.status === DepositStatus.DETECTED) {
            return this.creditDepositInTransaction(linked.id, client);
          }
          return linked;
        }
      }
      if (
        existing.status === DepositStatus.PENDING_CONFIRMATION &&
        input.confirmations >= requiredConfirmations
      ) {
        const confirmed = await client.deposit.update({
          where: { id: existing.id },
          data: {
            confirmations: input.confirmations,
            status: DepositStatus.DETECTED,
          },
          include: { asset: true },
        });
        if (existing.intentId) {
          await this.syncIntentStatus(client, existing.intentId, confirmed);
        }
        return this.creditDepositInTransaction(confirmed.id, client);
      }
      if (
        existing.status === DepositStatus.DETECTED &&
        existing.userId
      ) {
        return this.creditDepositInTransaction(existing.id, client);
      }
      if (input.confirmations > existing.confirmations) {
        const reachedThreshold =
          existing.status === DepositStatus.PENDING_CONFIRMATION &&
          input.confirmations >= requiredConfirmations;
        const depositAddressId =
          existing.depositAddressId ??
          (
            await this.resolvePersonalDepositAddress(client, {
              intentId: existing.intentId ?? input.intentId,
              toAddress: existing.toAddress,
              userId: existing.userId ?? undefined,
              network: existing.network,
            })
          )?.id;
        const updated = await client.deposit.update({
          where: { id: existing.id },
          data: {
            confirmations: input.confirmations,
            ...(depositAddressId && !existing.depositAddressId
              ? { depositAddressId }
              : {}),
            ...(reachedThreshold ? { status: DepositStatus.DETECTED } : {}),
          },
          include: { asset: true },
        });
        if (existing.intentId) {
          await this.syncIntentStatus(client, existing.intentId, updated);
        }
        if (updated.status === DepositStatus.DETECTED) {
          return this.creditDepositInTransaction(updated.id, client);
        }
        return updated;
      }
      return existing;
    }

    const intent = input.intentId
      ? await client.depositIntent.findUnique({ where: { id: input.intentId } })
      : null;
    const depositAddress =
      (input.depositAddressId
        ? await client.userDepositAddress.findFirst({
            where: { id: input.depositAddressId, status: 'ACTIVE' },
          })
        : null) ??
      (await this.resolvePersonalDepositAddress(client, {
        intent,
        toAddress: input.toAddress,
        userId: input.userId,
        network: input.network ?? intent?.network,
      }));
    const wallet = intent
      ? await client.wallet.findFirst({
          where: { id: intent.walletId, status: 'ACTIVE' },
        })
      : !depositAddress && input.fromAddress && !input.requireIntent
        ? await this.walletsService.findActiveWalletByAddress(input.fromAddress)
        : null;
    const requiredConfirmations = await this.resolveRequiredConfirmations(
      input.tokenContractId ?? intent?.tokenContractId,
      client,
    );
    const matchedUserId = input.forceUnmatched
      ? undefined
      : intent?.userId ?? depositAddress?.userId ?? input.userId;
    const status = this.resolveInitialDepositStatus({
      hasUser: Boolean(matchedUserId),
      confirmations: input.confirmations,
      requiredConfirmations,
    });

    const deposit = await client.deposit.create({
      data: {
        userId: matchedUserId,
        walletId: wallet?.id,
        intentId: input.intentId,
        depositAddressId: depositAddress?.id,
        assetId: input.assetId,
        tokenContractId: input.tokenContractId ?? intent?.tokenContractId,
        network: intent?.network ?? network,
        channel:
          input.forceUnmatched
            ? DepositChannel.UNMATCHED
            : input.channel ??
          (intent
            ? DepositChannel.WEB3_INTENT
            : depositAddress
              ? DepositChannel.PERSONAL_ADDRESS
              : DepositChannel.UNMATCHED),
        fromAddress: input.fromAddress
          ? this.normalizeAddressForStorage(input.fromAddress, network)
          : undefined,
        toAddress: this.normalizeAddressForStorage(input.toAddress, network),
        txHash: input.txHash,
        logIndex: input.logIndex,
        blockNumber: input.blockNumber,
        amount: new Prisma.Decimal(input.amount),
        rawAmount: input.rawAmount ?? intent?.rawAmount,
        confirmations: input.confirmations,
        status: input.forceUnmatched ? DepositStatus.UNMATCHED : status,
        idempotencyKey,
      },
      include: { asset: true },
    });

    if (input.intentId) {
      await this.syncIntentStatus(client, input.intentId, deposit);
    }

    if (!input.forceUnmatched && status === DepositStatus.DETECTED) {
      return this.creditDepositInTransaction(deposit.id, client);
    }

    return deposit;
  }

  async creditDeposit(depositId: string) {
    return this.prisma.$transaction(
      (tx) => this.creditDepositInTransaction(depositId, tx),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async creditDepositInTransaction(
    depositId: string,
    tx: Prisma.TransactionClient,
  ) {
    const fresh = await tx.deposit.findUnique({
      where: { id: depositId },
      include: { asset: true },
    });
    if (!fresh) {
      throw new NotFoundException('Deposit not found');
    }
    if (fresh.status === DepositStatus.CREDITED) {
      return fresh;
    }
    if (!fresh.userId) {
      return tx.deposit.update({
        where: { id: fresh.id },
        data: { status: DepositStatus.UNMATCHED },
        include: { asset: true },
      });
    }
    const ledgerTransaction = await this.ledgerService.postTransaction({
      type: LedgerTransactionType.DEPOSIT_CREDIT,
      idempotencyKey: `deposit-credit:${fresh.id}`,
      referenceType: 'Deposit',
      referenceId: fresh.id,
      description: `Credit ${fresh.asset.symbol} deposit`,
      metadata: {
        txHash: fresh.txHash,
        logIndex: fresh.logIndex,
      },
      entries: [
        {
          accountType: LedgerAccountType.PENDING_DEPOSIT,
          assetId: fresh.assetId,
          direction: LedgerEntryDirection.DEBIT,
          amount: fresh.amount,
        },
        {
          accountType: LedgerAccountType.USER_SPOT,
          userId: fresh.userId,
          assetId: fresh.assetId,
          direction: LedgerEntryDirection.CREDIT,
          amount: fresh.amount,
        },
      ],
    }, tx);

    const credited = await tx.deposit.update({
      where: { id: fresh.id },
      data: {
        status: DepositStatus.CREDITED,
        creditedAt: new Date(),
        creditedLedgerTransactionId: ledgerTransaction.id,
      },
      include: { asset: true },
    });
    if (fresh.intentId) {
      const intent = await tx.depositIntent.findUnique({ where: { id: fresh.intentId } });
      await tx.depositIntent.update({
        where: { id: fresh.intentId },
        data: {
          status: DepositIntentStatus.CREDITED,
          confirmedAt: intent?.confirmedAt ?? new Date(),
          creditedAt: new Date(),
        },
      });
    }
    void this.realtime?.notifyUserBalancesUpdated(fresh.userId);
    return credited;
  }

  private resolveInitialDepositStatus(input: {
    hasUser: boolean;
    confirmations: number;
    requiredConfirmations: number;
  }): DepositStatus {
    if (!input.hasUser) {
      return DepositStatus.UNMATCHED;
    }

    if (input.confirmations < input.requiredConfirmations) {
      return DepositStatus.PENDING_CONFIRMATION;
    }

    return DepositStatus.DETECTED;
  }

  private resolveDepositProgressStep(
    status: DepositIntentStatus,
    isCredited: boolean,
  ): 1 | 2 | 3 | 4 {
    if (isCredited || status === DepositIntentStatus.CREDITED) {
      return 4;
    }
    if (status === DepositIntentStatus.CONFIRMED) {
      return 3;
    }
    if (status === DepositIntentStatus.DETECTED) {
      return 2;
    }
    return 1;
  }

  private async resolvePersonalDepositAddress(
    client: Prisma.TransactionClient,
    input: {
      intent?: { treasuryAddress: string; userId: string } | null;
      intentId?: string | null;
      toAddress: string;
      userId?: string;
      network?: Chain;
    },
  ) {
    let intent = input.intent ?? null;
    if (!intent && input.intentId) {
      intent = await client.depositIntent.findUnique({ where: { id: input.intentId } });
    }
    const network = input.network ?? (intent as { network?: Chain } | null)?.network;
    const lookupAddress = this.normalizeAddressForStorage(
      intent?.treasuryAddress ?? input.toAddress,
      network,
    );
    return client.userDepositAddress.findFirst({
      where: {
        address: lookupAddress,
        status: 'ACTIVE',
        ...(network ? { network } : {}),
        ...(intent?.userId || input.userId
          ? { userId: intent?.userId ?? input.userId }
          : {}),
      },
    });
  }

  private async resolveRequiredConfirmations(
    tokenContractId: string | null | undefined,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    const configured = this.config.get<number>('DEPOSIT_CONFIRMATIONS', 12);
    if (!tokenContractId) {
      return configured;
    }
    const tokenContract = await client.tokenContract.findUnique({
      where: { id: tokenContractId },
      include: { network: true },
    });
    const networkRequired =
      tokenContract?.network.confirmations ?? configured;
    if (tokenContract?.network && !tokenContract.network.mainnet) {
      return Math.min(networkRequired, configured);
    }
    return networkRequired;
  }

  private async syncIntentStatus(
    client: Prisma.TransactionClient,
    intentId: string,
    deposit: { status: DepositStatus; confirmations: number; txHash: string },
  ): Promise<void> {
    const intent = await client.depositIntent.findUnique({
      where: { id: intentId },
      include: { tokenContract: { include: { network: true } } },
    });
    if (!intent) {
      return;
    }
    const requiredConfirmations = await this.resolveRequiredConfirmations(
      intent.tokenContractId,
      client,
    );
    const confirmed = deposit.confirmations >= requiredConfirmations;
    await client.depositIntent.update({
      where: { id: intentId },
      data: {
        txHash: deposit.txHash,
        submittedAt: intent.submittedAt ?? new Date(),
        detectedAt: intent.detectedAt ?? new Date(),
        confirmedAt: confirmed ? (intent.confirmedAt ?? new Date()) : intent.confirmedAt,
        status: confirmed ? DepositIntentStatus.CONFIRMED : DepositIntentStatus.DETECTED,
      },
    });
  }

  private async getDepositTarget(assetSymbol: string, networkKey?: string) {
    const asset = await this.assetsService.getBySymbol(assetSymbol);
    const network = await this.resolveNetworkConfig(networkKey);
    if (!network.legacyChain) {
      throw new BadRequestException('Network is missing legacy storage mapping');
    }
    if (this.isMainnetDisplayMode() && !network.mainnet) {
      throw new BadRequestException('Testnet deposits are hidden while MAINNET_ENABLED=true');
    }
    if (
      network.family !== NetworkFamily.EVM &&
      network.mainnet &&
      !this.config.get<boolean>('MAINNET_ENABLED', false)
    ) {
      throw new BadRequestException(`${network.family} mainnet deposits require MAINNET_ENABLED=true`);
    }
    if (!network.depositEnabled) {
      throw new BadRequestException('Deposits are disabled for this network');
    }
    const tokenContract = await this.prisma.tokenContract.findUnique({
      where: {
        assetId_networkId_standard: {
          assetId: asset.id,
          networkId: network.id,
          standard: TokenStandard.NATIVE,
        },
      },
    }) ?? await this.prisma.tokenContract.findUnique({
      where: {
        assetId_networkId_standard: {
          assetId: asset.id,
          networkId: network.id,
          standard: this.defaultTokenStandardForNetwork(network.family),
        },
      },
    });
    if (!tokenContract?.depositEnabled) {
      throw new BadRequestException('Deposits are disabled for this asset on this network');
    }
    if (
      ([TokenStandard.ERC20, TokenStandard.SPL, TokenStandard.TRC20] as TokenStandard[]).includes(tokenContract.standard) &&
      (!tokenContract.address ||
        (network.family === NetworkFamily.EVM &&
          ((!tokenContract.contractVerifiedAt && !asset.contractVerifiedAt) ||
            (!tokenContract.contractCodeHash && !asset.contractCodeHash))))
    ) {
      throw new BadRequestException('ERC20 deposits are disabled for this asset on this network');
    }

    return {
      asset,
      tokenContract,
      network,
      legacyChain: network.legacyChain,
    };
  }

  private toDepositOptionNetwork(contract: {
    address: string | null;
    standard: string;
    decimals: number;
    depositEnabled: boolean;
    withdrawalEnabled: boolean;
    withdrawalFeeAmount: { toString(): string };
    minWithdrawalAmount: { toString(): string };
    minDepositAmount?: { toString(): string };
    contractVerifiedAt: Date | null;
    contractCodeHash: string | null;
    verifiedChainId: number | null;
      network: {
        chainKey: string;
        displayName: string;
        iconUrl: string | null;
        family: NetworkFamily;
        caip2: string | null;
      chainId: number | null;
      confirmations: number;
      depositEnabled: boolean;
      withdrawalEnabled: boolean;
      mainnet: boolean;
    };
  }) {
    const isNativeLike =
      contract.standard === TokenStandard.NATIVE || contract.standard === TokenStandard.BTC;
    const contractConfigured = isNativeLike || Boolean(contract.address);
    const contractVerified =
      isNativeLike ||
      (contract.network.family === NetworkFamily.EVM
        ? Boolean(contract.contractVerifiedAt && contract.contractCodeHash)
        : Boolean(contract.contractVerifiedAt || contract.address));
    const adapterEnabled =
      contract.network.family === NetworkFamily.EVM ||
      !contract.network.mainnet ||
      this.config.get<boolean>('MAINNET_ENABLED', false);
    const depositEnabled =
      adapterEnabled &&
      contract.network.depositEnabled &&
      contract.depositEnabled &&
      contractConfigured &&
      contractVerified;
    const disabledReason = depositEnabled
      ? null
      : !adapterEnabled
        ? `${contract.network.family} deposit adapter is not enabled for this network`
        : !contract.network.depositEnabled
          ? 'Network deposits are disabled'
          : !contractConfigured
            ? 'Token contract is not configured'
            : !contractVerified
              ? 'Token contract is not verified'
              : !contract.depositEnabled
                ? 'Asset deposits are disabled on this network'
                : null;

    return {
      network: contract.network.chainKey,
      displayName: contract.network.displayName,
      iconUrl: contract.network.iconUrl,
      family: contract.network.family,
      caip2: contract.network.caip2,
      chainId: contract.network.chainId,
      tokenStandard: contract.standard,
      tokenAddress: this.formatTokenAddress(contract.address),
      decimals: contract.decimals,
      depositEnabled,
      withdrawalEnabled:
        contract.network.withdrawalEnabled &&
        contract.withdrawalEnabled &&
        contractConfigured &&
        contractVerified,
      disabledReason,
      requiredConfirmations: contract.network.confirmations,
      withdrawalFeeAmount: contract.withdrawalFeeAmount.toString(),
      minDepositAmount: contract.minDepositAmount?.toString() ?? '0',
      minWithdrawalAmount: contract.minWithdrawalAmount.toString(),
      contractVerified,
      verifiedChainId: contract.verifiedChainId,
      memoRequired: false,
      tagRequired: false,
    };
  }

  private formatTokenAddress(address: string | null) {
    if (!address) {
      return null;
    }
    return address.startsWith('0x') ? getAddress(address) : address;
  }

  private defaultTokenStandardForNetwork(family: NetworkFamily): TokenStandard {
    if (family === NetworkFamily.SVM) {
      return TokenStandard.SPL;
    }
    if (family === NetworkFamily.UTXO) {
      return TokenStandard.BTC;
    }
    if (family === NetworkFamily.TVM) {
      return TokenStandard.TRC20;
    }
    return TokenStandard.ERC20;
  }

  private isMainnetDisplayMode(): boolean {
    return (
      this.config.get<boolean>('DISPLAY_MAINNET_ONLY', false) ||
      this.config.get<boolean>('MAINNET_ENABLED', false)
    );
  }

  private isEvmStorageNetwork(network?: Chain): boolean {
    const nonEvmChains: Chain[] = [
      Chain.SOLANA,
      Chain.SOLANA_DEVNET,
      Chain.BITCOIN,
      Chain.BITCOIN_SIGNET,
      Chain.TRON,
      Chain.TRON_NILE,
      Chain.TRON_SHASTA,
    ];
    return !nonEvmChains.includes(network ?? Chain.ARBITRUM_SEPOLIA);
  }

  private normalizeAddressForStorage(address: string, network?: Chain): string {
    if (this.isEvmStorageNetwork(network)) {
      return getAddress(address).toLowerCase();
    }
    return address.trim();
  }

  private formatAddressForNetwork(address: string, family: NetworkFamily): string {
    return family === NetworkFamily.EVM ? getAddress(address) : address;
  }

  private async resolveNetworkConfig(networkKey?: string) {
    const key = networkKey?.trim().toLowerCase() || this.defaultNetworkKey();
    const network = await this.prisma.network.findUnique({ where: { chainKey: key } });
    if (!network) {
      throw new BadRequestException(`Unsupported network: ${key}`);
    }
    return network;
  }

  private defaultNetworkKey(): string {
    const chainId = this.config.get<number>('ONCHAIN_CHAIN_ID', 421614);
    const keys: Record<number, string> = {
      1: 'ethereum',
      10: 'optimism',
      56: 'bnb',
      97: 'bnb-testnet',
      137: 'polygon',
      300: 'zksync-sepolia',
      324: 'zksync',
      5000: 'mantle',
      5003: 'mantle-sepolia',
      8453: 'base',
      84532: 'base-sepolia',
      42220: 'celo',
      44787: 'celo-alfajores',
      59141: 'linea-sepolia',
      59144: 'linea',
      42161: 'arbitrum',
      421614: 'arbitrum-sepolia',
      43113: 'avalanche-fuji',
      43114: 'avalanche',
      80002: 'polygon-amoy',
      534351: 'scroll-sepolia',
      534352: 'scroll',
      11155111: 'ethereum-sepolia',
      11155420: 'optimism-sepolia',
    };
    return keys[chainId] ?? 'arbitrum-sepolia';
  }

  private resolveLegacyNetwork(): Chain {
    const chainId = this.config.get<number>('ONCHAIN_CHAIN_ID', 421614);
    const chains: Record<number, Chain> = {
      1: Chain.ETHEREUM,
      10: Chain.OPTIMISM,
      56: Chain.BNB,
      97: Chain.BNB_TESTNET,
      137: Chain.POLYGON,
      300: Chain.ZKSYNC_SEPOLIA,
      324: Chain.ZKSYNC,
      5000: Chain.MANTLE,
      5003: Chain.MANTLE_SEPOLIA,
      8453: Chain.BASE,
      84532: Chain.BASE_SEPOLIA,
      42220: Chain.CELO,
      44787: Chain.CELO_ALFAJORES,
      59141: Chain.LINEA_SEPOLIA,
      59144: Chain.LINEA,
      42161: Chain.ARBITRUM,
      421614: Chain.ARBITRUM_SEPOLIA,
      43113: Chain.AVALANCHE_FUJI,
      43114: Chain.AVALANCHE,
      80002: Chain.POLYGON_AMOY,
      534351: Chain.SCROLL_SEPOLIA,
      534352: Chain.SCROLL,
      11155111: Chain.ETHEREUM_SEPOLIA,
      11155420: Chain.OPTIMISM_SEPOLIA,
    };
    return chains[chainId] ?? Chain.ARBITRUM_SEPOLIA;
  }

  async getActiveTreasuryAddress(network = this.resolveLegacyNetwork()): Promise<`0x${string}`> {
    const treasury = await this.prisma.custodyAccount.findFirst({
      where: {
        role: CustodyAccountRole.DEPOSIT_TREASURY,
        network,
        status: CustodyAccountStatus.ACTIVE,
      },
    });
    if (!treasury) {
      throw new BadRequestException(`Active ${network} deposit treasury is not configured`);
    }
    const address = getAddress(treasury.address);
    if (address === '0x0000000000000000000000000000000000000000') {
      throw new BadRequestException('Deposit treasury cannot use the zero address');
    }
    return address;
  }
}
