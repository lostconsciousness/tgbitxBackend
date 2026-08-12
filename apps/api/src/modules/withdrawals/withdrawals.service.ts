import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
  Prisma,
  WithdrawalStatus,
  Chain,
  CustodyAccountRole,
  CustodyAccountStatus,
  DepositChannel,
  DepositStatus,
  NetworkFamily,
  TokenStandard,
  UserDepositAddressStatus,
} from '@prisma/client';
import { Address, Hex, decodeEventLog, getAddress, parseAbiItem, parseUnits } from 'viem';
import { PrismaService } from '../../database/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { LedgerPostingEntry, LedgerService } from '../ledger/ledger.service';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { PrivyCustodyService } from '../treasury/privy-custody.service';
import { RPC_PROVIDER } from '../rpc/rpc.module';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { Inject } from '@nestjs/common';
import { OperationalSettingsService } from '../settings/operational-settings.service';
import { OnchainReadinessService } from '../onchain/onchain-readiness.service';
import { AuditService } from '../audit/audit.service';
import { TreasuryService } from '../treasury/treasury.service';
import { AssetValuationService } from '../account/asset-valuation.service';
import { NonEvmTestnetAdapterService } from '../onchain/non-evm-testnet-adapter.service';
import {
  legacyChainDisplayName,
  legacyChainToNetworkKey,
  nativeGasSymbol,
} from '../../common/utils/network-metadata';
import {
  buildWithdrawalFeeBreakdown,
  resolveWithdrawalFeeAmount,
} from './withdrawal-fee.policy';

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);
  private workerRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly assetsService: AssetsService,
    private readonly ledgerService: LedgerService,
    private readonly config: ConfigService,
    private readonly custody: PrivyCustodyService,
    @Inject(RPC_PROVIDER) private readonly rpcProvider: RpcProvider,
    private readonly settings: OperationalSettingsService,
    private readonly readiness: OnchainReadinessService,
    private readonly audit: AuditService,
    private readonly treasury: TreasuryService,
    private readonly assetValuation: AssetValuationService,
    private readonly nonEvm: NonEvmTestnetAdapterService,
  ) {}

  async listUserWithdrawals(userId: string) {
    const mainnetOnly = this.isMainnetDisplayMode();
    const withdrawals = await this.prisma.withdrawal.findMany({
      where: {
        userId,
        ...(mainnetOnly
          ? {
              tokenContract: {
                network: { mainnet: true },
              },
            }
          : {}),
      },
      include: {
        asset: true,
        tokenContract: { include: { network: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return withdrawals.map((withdrawal) => this.toUserWithdrawalResponse(withdrawal));
  }

  private async getWithdrawableSpotBalance(userId: string, assetId: string): Promise<Prisma.Decimal> {
    if (this.isMainnetDisplayMode()) {
      return this.ledgerService.getUserMainnetSpotBalance({ userId, assetId });
    }
    return this.ledgerService.getUserSpotBalance({ userId, assetId });
  }

  async getWithdrawalNetworks(userId: string, assetSymbol: string) {
    const asset = await this.assetsService.getBySymbol(assetSymbol);
    const availableBalance = await this.getWithdrawableSpotBalance(userId, asset.id);
    const mainnetOnly = this.isMainnetDisplayMode();
    const tokenContracts = await this.prisma.tokenContract.findMany({
      where: {
        assetId: asset.id,
        ...(mainnetOnly ? { network: { mainnet: true } } : {}),
      },
      include: { network: true },
      orderBy: { network: { chainKey: 'asc' } },
    });
    const nativePricesUsd = await this.assetValuation.loadNativePricesUsd();

    return {
      asset: {
        id: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        decimals: asset.decimals,
      },
      availableBalance: availableBalance.toString(),
      balanceScope: 'EXCHANGE_LEDGER',
      networks: tokenContracts.map((contract) =>
        this.toWithdrawalOptionNetwork(contract, asset.symbol, nativePricesUsd),
      ),
    };
  }

  async listWithdrawalOptions(userId: string) {
    const mainnetOnly = this.isMainnetDisplayMode();
    const nativePricesUsd = await this.assetValuation.loadNativePricesUsd();
    const tokenContracts = await this.prisma.tokenContract.findMany({
      where: mainnetOnly ? { network: { mainnet: true } } : undefined,
      include: { asset: true, network: true },
      orderBy: [{ asset: { symbol: 'asc' } }, { network: { chainKey: 'asc' } }],
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
        networks: Array<ReturnType<WithdrawalsService['toWithdrawalOptionNetwork']>>;
      }
    >();

    for (const contract of tokenContracts) {
      const assetEntry = grouped.get(contract.asset.symbol) ?? {
        id: contract.asset.id,
        symbol: contract.asset.symbol,
        name: contract.asset.name,
        iconUrl: contract.asset.iconUrl,
        type: contract.asset.type,
        decimals: contract.asset.decimals,
        availableBalance: '0',
        networks: [],
      };
      assetEntry.networks.push(
        this.toWithdrawalOptionNetwork(contract, contract.asset.symbol, nativePricesUsd),
      );
      grouped.set(contract.asset.symbol, assetEntry);
    }

    const assets = (
      await Promise.all(
        [...grouped.values()].map(async (asset) => ({
          ...asset,
          availableBalance: (
            await this.getWithdrawableSpotBalance(userId, asset.id)
          ).toString(),
          networks: asset.networks.sort((left, right) => left.network.localeCompare(right.network)),
        })),
      )
    ).filter(
      (asset) =>
        !mainnetOnly || new Prisma.Decimal(asset.availableBalance).greaterThan(0),
    );

    return {
      balanceScope: 'EXCHANGE_LEDGER' as const,
      assets: await this.assetValuation.enrichAndSortByBalanceUsdc(
        assets,
        (asset) => asset.availableBalance,
      ),
    };
  }

  private toWithdrawalOptionNetwork(
    contract: {
    standard: TokenStandard;
    address: string | null;
    decimals: number;
    withdrawalEnabled: boolean;
    withdrawalFeeAmount: { toString(): string };
    minWithdrawalAmount: { toString(): string };
    contractVerifiedAt: Date | null;
    contractCodeHash: string | null;
      network: {
        chainKey: string;
        displayName: string;
        iconUrl: string | null;
        family: NetworkFamily;
        caip2: string | null;
        chainId: number | null;
        mainnet?: boolean;
        withdrawalEnabled: boolean;
      };
  },
    assetSymbol: string,
    nativePricesUsd?: Partial<Record<string, string>>,
  ) {
    const isNativeLike =
      contract.standard === TokenStandard.NATIVE || contract.standard === TokenStandard.BTC;
    const contractReady = isNativeLike || Boolean(contract.address);
    const contractVerified = Boolean(
      contract.network.family !== NetworkFamily.EVM
        ? contract.contractVerifiedAt
        : isNativeLike
        ? contract.contractVerifiedAt
        : contract.contractVerifiedAt && contract.contractCodeHash,
    );
    const adapterEnabled =
      contract.network.family === NetworkFamily.EVM ||
      !contract.network.mainnet ||
      this.config.get<boolean>('MAINNET_ENABLED', false);
    const signerConfigured = this.isWithdrawalSignerConfigured(contract.network);
    const withdrawalEnabled =
      adapterEnabled &&
      signerConfigured &&
      contract.network.withdrawalEnabled &&
      contract.withdrawalEnabled &&
      contractReady &&
      contractVerified;
    const disabledReason = withdrawalEnabled
      ? null
      : !adapterEnabled
        ? `${contract.network.family} withdrawal adapter is not enabled for this network`
        : !signerConfigured
          ? 'Withdrawal signer is not configured'
        : !contract.network.withdrawalEnabled
          ? 'Network withdrawals are disabled'
          : !contractReady
            ? 'Token contract is not configured'
            : !contractVerified
              ? 'Token contract is not verified'
              : !contract.withdrawalEnabled
                ? 'Asset withdrawals are disabled on this network'
                : null;

    const feeBreakdown = buildWithdrawalFeeBreakdown({
      assetSymbol,
      networkKey: contract.network.chainKey,
      configuredAmount: contract.withdrawalFeeAmount.toString(),
      tokenStandard: contract.standard,
      nativePricesUsd,
    });

    return {
      network: contract.network.chainKey,
      displayName: contract.network.displayName,
      iconUrl: contract.network.iconUrl,
      family: contract.network.family,
      caip2: contract.network.caip2,
      chainId: contract.network.chainId,
      tokenAddress: contract.address,
      tokenStandard: contract.standard,
      nativeGasSymbol: nativeGasSymbol(contract.network.chainKey),
      withdrawalEnabled,
      withdrawalFeeAmount: feeBreakdown.withdrawalFeeAmount,
      estimatedNetworkCostUsd: feeBreakdown.estimatedNetworkCostUsd,
      gasPaidByExchange: feeBreakdown.gasPaidByExchange,
      minWithdrawalAmount: contract.minWithdrawalAmount.toString(),
      contractVerified,
      disabledReason,
    };
  }

  private isWithdrawalSignerConfigured(network: {
    chainKey: string;
    family: NetworkFamily;
  }): boolean {
    const prefix = network.chainKey.toUpperCase().replace(/-/g, '_');
    if (network.family === NetworkFamily.UTXO) {
      return Boolean(this.config.get<string>(`${prefix}_WITHDRAWAL_WIF`, '').trim());
    }
    if (network.family === NetworkFamily.SVM && network.chainKey === 'solana') {
      return this.custody.isSolanaEnabled?.() ?? false;
    }
    if (network.family === NetworkFamily.TVM && network.chainKey === 'tron') {
      return this.custody.isTronEnabled?.() ?? false;
    }
    if (network.family === NetworkFamily.SVM || network.family === NetworkFamily.TVM) {
      return Boolean(this.config.get<string>(`${prefix}_WITHDRAWAL_PRIVATE_KEY`, '').trim());
    }
    return true;
  }

  listAdminWithdrawals(take = 100) {
    return this.prisma.withdrawal.findMany({
      take: Math.min(take, 200),
      include: { asset: true, user: true, approvedBy: true, rejectedBy: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async requestWithdrawal(userId: string, dto: CreateWithdrawalDto) {
    if (
      await this.settings.getBoolean(
        'withdrawals:paused',
        'WITHDRAWALS_PAUSED',
        false,
      )
    ) {
      throw new ServiceUnavailableException('Withdrawals are paused');
    }
    const target = await this.getWithdrawalTarget(dto.assetSymbol, dto.network);
    const { asset, tokenContract } = target;
    if (!target.network.withdrawalEnabled || !tokenContract.withdrawalEnabled) {
      throw new BadRequestException('Withdrawals are disabled for this asset');
    }

    const amount = new Prisma.Decimal(dto.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Withdrawal amount must be positive');
    }

    if (amount.lessThan(tokenContract.minWithdrawalAmount)) {
      throw new BadRequestException('Withdrawal amount is below minimum');
    }

    const feeAmount = resolveWithdrawalFeeAmount({
      assetSymbol: asset.symbol,
      networkKey: target.network.chainKey,
      configuredAmount: tokenContract.withdrawalFeeAmount,
    });
    const totalDebit = amount.plus(feeAmount);
    const manualApprovalThreshold = this.getManualApprovalThreshold();
    const adminApprovalRequired = manualApprovalThreshold.lessThanOrEqualTo(0)
      ? true
      : amount.greaterThan(manualApprovalThreshold);
    const nextStatus = adminApprovalRequired
      ? WithdrawalStatus.PENDING_APPROVAL
      : WithdrawalStatus.APPROVED;
    const dailyTotal = await this.prisma.withdrawal.aggregate({
      where: {
        userId,
        assetId: asset.id,
        requestedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        status: { notIn: [WithdrawalStatus.REJECTED, WithdrawalStatus.CANCELLED] },
      },
      _sum: { amount: true },
    });
    const dailyLimit = new Prisma.Decimal(
      this.config.get<string>('WITHDRAWAL_DAILY_LIMIT', '10000'),
    );
    if (new Prisma.Decimal(dailyTotal._sum.amount ?? 0).plus(amount).greaterThan(dailyLimit)) {
      throw new BadRequestException('Daily withdrawal limit exceeded');
    }

    if (target.network.family !== NetworkFamily.EVM) {
      await this.nonEvm.validateAddress(target.network, dto.toAddress);
    }
    let normalizedAddress: string;
    if (target.network.family === NetworkFamily.EVM) {
      try {
        normalizedAddress = getAddress(dto.toAddress).toLowerCase();
      } catch (_error) {
        throw new BadRequestException('Invalid EVM withdrawal address');
      }
    } else {
      normalizedAddress = dto.toAddress.trim();
    }
    const network = target.legacyChain;
    const internalDestination = await this.prisma.userDepositAddress.findFirst({
      where: {
        network,
        address: normalizedAddress,
        status: UserDepositAddressStatus.ACTIVE,
      },
    });
    if (internalDestination) {
      if (internalDestination.userId === userId) {
        throw new BadRequestException('Cannot withdraw to your own exchange deposit address');
      }
      return this.toUserWithdrawalResponse(await this.createInternalTransferWithdrawal({
        userId,
        recipientUserId: internalDestination.userId,
        depositAddressId: internalDestination.id,
        toAddress: normalizedAddress,
        asset,
        tokenContractId: tokenContract.id,
        network,
        amount,
        mainnetOnly: Boolean(target.network.mainnet) || this.isMainnetDisplayMode(),
      }));
    }

    const destination = await this.prisma.withdrawalAddress.upsert({
      where: {
        userId_network_address: { userId, network, address: normalizedAddress },
      },
      update: {},
      create: { userId, network, address: normalizedAddress },
    });
    const destinationFirstSeenAt = destination.firstSeenAt;
    const cooldownSeconds = this.config.get<number>('WITHDRAWAL_NEW_ADDRESS_COOLDOWN_SECONDS', 0);
    if (
      cooldownSeconds > 0 &&
      Date.now() - destinationFirstSeenAt.getTime() < cooldownSeconds * 1000
    ) {
      throw new BadRequestException('New withdrawal address is in cooldown');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.assertSufficientUserSpotBalance({
        userId,
        assetId: asset.id,
        amount: totalDebit,
        mainnetOnly: this.isMainnetDisplayMode(),
      }, tx);
      const createdWithdrawal = await tx.withdrawal.create({
        data: {
          userId,
          assetId: asset.id,
          tokenContractId: tokenContract.id,
          network,
          toAddress: normalizedAddress,
          amount,
          feeAmount,
          status: WithdrawalStatus.REQUESTED,
          adminApprovalRequired,
          destinationFirstSeenAt,
        },
        include: { asset: true },
      });
      const ledgerTransaction = await this.ledgerService.postTransaction({
        type: LedgerTransactionType.WITHDRAWAL_RESERVE,
        idempotencyKey: `withdrawal-reserve:${createdWithdrawal.id}`,
        referenceType: 'Withdrawal',
        referenceId: createdWithdrawal.id,
        description: `Reserve ${asset.symbol} withdrawal`,
        metadata: { toAddress: createdWithdrawal.toAddress },
        entries: this.buildReserveEntries({
          userId,
          assetId: asset.id,
          amount,
          feeAmount,
        }),
      }, tx);
      const withdrawal = await tx.withdrawal.update({
        where: { id: createdWithdrawal.id },
        data: {
          status: nextStatus,
          requestedLedgerTransactionId: ledgerTransaction.id,
          approvedAt: adminApprovalRequired ? undefined : new Date(),
          approvalReason: adminApprovalRequired ? undefined : 'Auto-approved by withdrawal policy',
        },
        include: { asset: true, tokenContract: { include: { network: true } } },
      });
      return this.toUserWithdrawalResponse(withdrawal);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  private async createInternalTransferWithdrawal(input: {
    userId: string;
    recipientUserId: string;
    depositAddressId: string;
    toAddress: string;
    asset: {
      id: string;
      symbol: string;
      chain: Chain;
      decimals: number;
    };
    tokenContractId?: string;
    network?: Chain;
    amount: Prisma.Decimal;
    mainnetOnly: boolean;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.ledgerService.assertSufficientUserSpotBalance({
        userId: input.userId,
        assetId: input.asset.id,
        amount: input.amount,
        mainnetOnly: input.mainnetOnly,
      }, tx);
      const now = new Date();
      const withdrawal = await tx.withdrawal.create({
        data: {
          userId: input.userId,
          assetId: input.asset.id,
          tokenContractId: input.tokenContractId,
          network: input.network ?? input.asset.chain,
          toAddress: input.toAddress,
          amount: input.amount,
          feeAmount: new Prisma.Decimal(0),
          status: WithdrawalStatus.CONFIRMED,
          adminApprovalRequired: false,
          approvedAt: now,
          broadcastedAt: now,
          confirmedAt: now,
          approvalReason: 'Internal exchange transfer',
        },
        include: { asset: true, tokenContract: { include: { network: true } } },
      });
      const ledgerTransaction = await this.ledgerService.postTransaction({
        type: LedgerTransactionType.ADMIN_ADJUSTMENT,
        idempotencyKey: `internal-transfer:${withdrawal.id}`,
        referenceType: 'Withdrawal',
        referenceId: withdrawal.id,
        description: `Internal ${input.asset.symbol} transfer`,
        metadata: {
          withdrawalId: withdrawal.id,
          recipientUserId: input.recipientUserId,
          depositAddressId: input.depositAddressId,
        },
        entries: [
          {
            accountType: LedgerAccountType.USER_SPOT,
            userId: input.userId,
            assetId: input.asset.id,
            direction: LedgerEntryDirection.DEBIT,
            amount: input.amount,
          },
          {
            accountType: LedgerAccountType.USER_SPOT,
            userId: input.recipientUserId,
            assetId: input.asset.id,
            direction: LedgerEntryDirection.CREDIT,
            amount: input.amount,
          },
        ],
      }, tx);
      await tx.deposit.create({
        data: {
          userId: input.recipientUserId,
          assetId: input.asset.id,
          depositAddressId: input.depositAddressId,
          tokenContractId: input.tokenContractId,
          network: input.network ?? input.asset.chain,
          channel: DepositChannel.PERSONAL_ADDRESS,
          fromAddress: null,
          toAddress: input.toAddress,
          txHash: `internal:${withdrawal.id}`,
          logIndex: 0,
          amount: input.amount,
          rawAmount: parseUnits(input.amount.toString(), input.asset.decimals).toString(),
          confirmations: 0,
          status: DepositStatus.CREDITED,
          idempotencyKey: `internal-deposit:${withdrawal.id}`,
          creditedAt: now,
          creditedLedgerTransactionId: ledgerTransaction.id,
        },
      });
      return tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: { requestedLedgerTransactionId: ledgerTransaction.id },
        include: { asset: true, tokenContract: { include: { network: true } } },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  async approveWithdrawal(input: { withdrawalId: string; adminUserId: string; reason?: string }) {
    const withdrawal = await this.getWithdrawalForDecision(input.withdrawalId);
    if (withdrawal.status !== WithdrawalStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Withdrawal is not pending approval');
    }

    return this.prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: WithdrawalStatus.APPROVED,
        approvedByUserId: input.adminUserId,
        approvalReason: input.reason,
        approvedAt: new Date(),
      },
      include: { asset: true, user: true },
    });
  }

  async rejectWithdrawal(input: { withdrawalId: string; adminUserId: string; reason?: string }) {
    const withdrawal = await this.getWithdrawalForDecision(input.withdrawalId);
    const rejectableStatuses: WithdrawalStatus[] = [
      WithdrawalStatus.REQUESTED,
      WithdrawalStatus.PENDING_APPROVAL,
    ];
    if (!rejectableStatuses.includes(withdrawal.status)) {
      throw new BadRequestException('Withdrawal cannot be rejected from current status');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.releaseWithdrawal(withdrawal, tx);
      return tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: WithdrawalStatus.REJECTED,
          rejectedByUserId: input.adminUserId,
          rejectionReason: input.reason,
          rejectedAt: new Date(),
        },
        include: { asset: true, user: true },
      });
    });
  }

  async cancelWithdrawal(userId: string, withdrawalId: string) {
    const existingWithdrawal = await this.prisma.withdrawal.findFirst({
      where: { id: withdrawalId, userId },
      include: { asset: true },
    });
    if (!existingWithdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }
    if (
      existingWithdrawal.status !== WithdrawalStatus.REQUESTED &&
      existingWithdrawal.status !== WithdrawalStatus.PENDING_APPROVAL
    ) {
      throw new BadRequestException('Withdrawal can no longer be cancelled');
    }
    const withdrawal = await this.prisma.$transaction(async (tx) => {
      await this.releaseWithdrawal(existingWithdrawal, tx);
      return tx.withdrawal.update({
        where: { id: existingWithdrawal.id },
        data: { status: WithdrawalStatus.CANCELLED },
        include: { asset: true, tokenContract: { include: { network: true } } },
      });
    });
    return this.toUserWithdrawalResponse(withdrawal);
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processApprovedWithdrawals(): Promise<void> {
    if (this.workerRunning || !this.config.get<boolean>('WITHDRAWAL_WORKER_ENABLED', false)) {
      return;
    }
    this.workerRunning = true;
    try {
      await this.autoApproveEligiblePending();
      await this.recoverInterruptedBroadcasting();
      await this.broadcastNextApproved();
      await this.recoverBroadcasting();
      await this.confirmBroadcasted();
    } finally {
      this.workerRunning = false;
    }
  }

  private getManualApprovalThreshold(): Prisma.Decimal {
    return new Prisma.Decimal(
      this.config.get<string>('WITHDRAWAL_MANUAL_APPROVAL_THRESHOLD', '1000'),
    );
  }

  private async getWithdrawalTarget(assetSymbol: string, networkKey?: string) {
    const asset = await this.assetsService.getBySymbol(assetSymbol);
    const key = networkKey?.trim().toLowerCase() || this.defaultNetworkKey();
    const network = await this.prisma.network.findUnique({ where: { chainKey: key } });
    if (!network) {
      throw new BadRequestException(`Unsupported network: ${key}`);
    }
    if (!network.legacyChain) {
      throw new BadRequestException('Network is missing legacy storage mapping');
    }
    if (this.isMainnetDisplayMode() && !network.mainnet) {
      throw new BadRequestException('Testnet withdrawals are hidden while MAINNET_ENABLED=true');
    }
    if (
      network.family !== NetworkFamily.EVM &&
      network.mainnet &&
      !this.config.get<boolean>('MAINNET_ENABLED', false)
    ) {
      throw new BadRequestException(`${network.family} mainnet withdrawals require MAINNET_ENABLED=true`);
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
          standard:
            network.family === NetworkFamily.SVM
              ? TokenStandard.SPL
              : network.family === NetworkFamily.UTXO
                ? TokenStandard.BTC
                : network.family === NetworkFamily.TVM
                  ? TokenStandard.TRC20
                  : TokenStandard.ERC20,
        },
      },
    });
    if (
      !tokenContract ||
      (([TokenStandard.ERC20, TokenStandard.SPL, TokenStandard.TRC20] as TokenStandard[]).includes(tokenContract.standard) &&
        !tokenContract.address)
    ) {
      throw new BadRequestException('Withdrawals are disabled for this asset on this network');
    }
    return {
      asset,
      tokenContract,
      network,
      legacyChain: network.legacyChain,
    };
  }

  private toUserWithdrawalResponse(withdrawal: {
    id: string;
    asset: {
      id: string;
      symbol: string;
      name: string;
      type: string;
      decimals: number;
    };
    tokenContract?: {
      standard: TokenStandard;
      address: string | null;
      network: {
        chainKey: string;
        displayName: string;
        caip2: string | null;
        chainId: number | null;
      };
    } | null;
    network?: Chain;
    toAddress: string;
    amount?: { toString(): string };
    feeAmount?: { toString(): string };
    status: WithdrawalStatus;
    adminApprovalRequired?: boolean;
    txHash: string | null;
    lastBroadcastError?: string | null;
    broadcastAttempts?: number;
    requestedAt?: Date;
    approvedAt?: Date | null;
    broadcastedAt?: Date | null;
    confirmedAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
  }) {
    const errorMessage = withdrawal.lastBroadcastError ?? null;
    return {
      id: withdrawal.id,
      status: withdrawal.status,
      asset: {
        id: withdrawal.asset.id,
        symbol: withdrawal.asset.symbol,
        name: withdrawal.asset.name,
        type: withdrawal.asset.type,
        decimals: withdrawal.asset.decimals,
      },
      network: this.toWithdrawalNetworkResponse(withdrawal),
      toAddress: withdrawal.toAddress,
      amount: withdrawal.amount?.toString() ?? '0',
      feeAmount: withdrawal.feeAmount?.toString() ?? '0',
      txHash: withdrawal.txHash,
      adminApprovalRequired: withdrawal.adminApprovalRequired ?? false,
      errorMessage,
      failureReason:
        withdrawal.status === WithdrawalStatus.FAILED ? errorMessage : errorMessage,
      broadcastAttempts: withdrawal.broadcastAttempts ?? 0,
      requestedAt: withdrawal.requestedAt,
      approvedAt: withdrawal.approvedAt,
      broadcastedAt: withdrawal.broadcastedAt,
      confirmedAt: withdrawal.confirmedAt,
      createdAt: withdrawal.createdAt,
      updatedAt: withdrawal.updatedAt,
    };
  }

  private toWithdrawalNetworkResponse(withdrawal: {
    tokenContract?: {
      standard: TokenStandard;
      address: string | null;
      network: {
        chainKey: string;
        displayName: string;
        caip2: string | null;
        chainId: number | null;
      };
    } | null;
    network?: Chain;
  }) {
    if (withdrawal.tokenContract?.network) {
      return {
        network: withdrawal.tokenContract.network.chainKey,
        displayName: withdrawal.tokenContract.network.displayName,
        caip2: withdrawal.tokenContract.network.caip2,
        chainId: withdrawal.tokenContract.network.chainId,
        tokenStandard: withdrawal.tokenContract.standard,
        tokenAddress: withdrawal.tokenContract.address,
      };
    }

    return {
      network: legacyChainToNetworkKey(withdrawal.network ?? Chain.ARBITRUM_SEPOLIA),
      displayName: legacyChainDisplayName(withdrawal.network ?? Chain.ARBITRUM_SEPOLIA),
      caip2: null,
      chainId: null,
      tokenStandard: null,
      tokenAddress: null,
    };
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

  private async autoApproveEligiblePending(): Promise<void> {
    const threshold = this.getManualApprovalThreshold();
    if (threshold.lessThanOrEqualTo(0)) {
      return;
    }

    await this.prisma.withdrawal.updateMany({
      where: {
        status: WithdrawalStatus.PENDING_APPROVAL,
        amount: { lte: threshold },
      },
      data: {
        status: WithdrawalStatus.APPROVED,
        adminApprovalRequired: false,
        approvedAt: new Date(),
        approvalReason: 'Auto-approved by withdrawal policy',
      },
    });
  }

  private async recoverInterruptedBroadcasting(): Promise<void> {
    const graceMs = this.config.get<number>('WITHDRAWAL_BROADCAST_INTERRUPT_GRACE_MS', 12_000);
    const stuck = await this.prisma.withdrawal.findMany({
      where: {
        status: WithdrawalStatus.BROADCASTING,
        txHash: null,
        updatedAt: { lt: new Date(Date.now() - graceMs) },
      },
      take: 20,
    });
    for (const withdrawal of stuck) {
      const reason =
        withdrawal.lastBroadcastError ??
        'Withdrawal broadcast timed out before a transaction was submitted';
      await this.failAndRelease(withdrawal.id, reason);
      this.logger.warn(`Withdrawal ${withdrawal.id} failed after interrupted broadcast`);
    }
  }

  private getWithdrawalFundingWaitMs(): number {
    return this.config.get<number>('WITHDRAWAL_FUNDING_WAIT_MS', 15_000);
  }

  private getWithdrawalBroadcastTimeoutMs(): number {
    return this.config.get<number>('WITHDRAWAL_BROADCAST_TIMEOUT_MS', 45_000);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ServiceUnavailableException(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async prepareEvmWithdrawalBroadcast(withdrawal: {
    asset: { symbol: string };
    amount: { toString(): string };
    tokenContract: {
      standard: TokenStandard;
      network: { chainKey: string };
    };
  }): Promise<void> {
    const fundingWaitMs = this.getWithdrawalFundingWaitMs();
    const isNative = withdrawal.tokenContract.standard === TokenStandard.NATIVE;
    await this.treasury.ensureHotWalletFunded({
      assetSymbol: withdrawal.asset.symbol,
      networkKey: withdrawal.tokenContract.network.chainKey,
      amount: new Prisma.Decimal(withdrawal.amount.toString()),
      maxWaitMs: fundingWaitMs,
      failFastWhenUnderfunded: true,
    });
    if (!isNative) {
      await this.treasury.ensureHotWalletNativeGas({
        networkKey: withdrawal.tokenContract.network.chainKey,
        maxWaitMs: fundingWaitMs,
        failFastWhenUnderfunded: true,
      });
    }
  }

  private shouldRetryWithdrawalBroadcast(
    networkFamily: NetworkFamily,
    message: string,
  ): boolean {
    return this.isBitcoinReplacementFeeError(networkFamily, message);
  }

  private async handleWithdrawalBroadcastFailure(input: {
    withdrawalId: string;
    networkFamily: NetworkFamily;
    message: string;
  }): Promise<void> {
    if (this.shouldRetryWithdrawalBroadcast(input.networkFamily, input.message)) {
      await this.prisma.withdrawal.update({
        where: { id: input.withdrawalId },
        data: {
          status: WithdrawalStatus.APPROVED,
          lastBroadcastError: input.message,
          approvedAt: new Date(),
        },
      });
      this.logger.warn(
        `Withdrawal ${input.withdrawalId} broadcast deferred for retry: ${input.message}`,
      );
      return;
    }
    await this.failAndRelease(input.withdrawalId, input.message);
    this.logger.warn(`Withdrawal ${input.withdrawalId} failed: ${input.message}`);
  }

  private async broadcastNextApproved(): Promise<void> {
    const withdrawals = await this.prisma.withdrawal.findMany({
      where: { status: WithdrawalStatus.APPROVED },
      include: { asset: true, tokenContract: { include: { network: true } } },
      orderBy: { approvedAt: 'asc' },
      take: 20,
    });
    for (const withdrawal of withdrawals) {
      if (!withdrawal.tokenContract) {
        continue;
      }
      const isEvm = withdrawal.tokenContract.network.family === NetworkFamily.EVM;
      if (isEvm && !withdrawal.tokenContract.network.chainId) {
        await this.deferApprovedWithdrawal(
          withdrawal.id,
          'EVM withdrawal network chain ID is not configured',
        );
        continue;
      }
      if (isEvm && !this.custody.isEnabled()) {
        await this.deferApprovedWithdrawal(withdrawal.id, 'Privy custody is disabled');
        continue;
      }
      try {
        if (isEvm) {
          await this.readiness.assertWorkerReady(
            'withdrawal',
            withdrawal.tokenContract.network.chainKey,
          );
        } else {
          this.nonEvm.assertSupportedNetwork(withdrawal.tokenContract.network);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        await this.deferApprovedWithdrawal(withdrawal.id, message);
        this.logger.warn(
          `Withdrawal ${withdrawal.id} deferred on ${withdrawal.tokenContract.network.chainKey}: ${message}`,
        );
        continue;
      }
      const isNative = withdrawal.tokenContract.standard === TokenStandard.NATIVE;
      if (
        isEvm &&
        (!withdrawal.tokenContract.contractVerifiedAt ||
          (!isNative && !withdrawal.tokenContract.contractCodeHash))
      ) {
        await this.deferApprovedWithdrawal(
          withdrawal.id,
          'Withdrawal token contract is not verified',
        );
        this.logger.error(`Withdrawal ${withdrawal.id} uses an unverified token contract`);
        continue;
      }
      let hot: { address: string };
      try {
        hot = await this.getWithdrawalHotAccount(withdrawal.network);
        if (isEvm) {
          await this.custody.assertConfiguredWalletAddress(hot.address);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        await this.deferApprovedWithdrawal(withdrawal.id, message);
        continue;
      }

      if (isEvm) {
        const liquidity = await this.treasury.getCustodialLiquidBalance({
          assetSymbol: withdrawal.asset.symbol,
          networkKey: withdrawal.tokenContract.network.chainKey,
        });
        if (liquidity && liquidity.total.lessThan(withdrawal.amount)) {
          await this.failAndRelease(
            withdrawal.id,
            `Insufficient ${withdrawal.asset.symbol} custody on ${withdrawal.tokenContract.network.chainKey}: available ${liquidity.total.toString()} (hot ${liquidity.hot.toString()}, treasury ${liquidity.treasury.toString()}), requested ${withdrawal.amount.toString()}. Withdraw on a network where funds are custodied.`,
          );
          continue;
        }
      } else {
        const liquidity = await this.nonEvm.getBalance({
          network: withdrawal.tokenContract.network,
          tokenContract: withdrawal.tokenContract,
          address: hot.address,
        });
        if (liquidity.status !== 'AVAILABLE' || liquidity.balance === null) {
          await this.deferApprovedWithdrawal(
            withdrawal.id,
            `Could not verify ${withdrawal.asset.symbol} hot-wallet balance on ${withdrawal.tokenContract.network.chainKey}`,
          );
          continue;
        }
        const available = new Prisma.Decimal(liquidity.balance);
        if (available.lessThan(withdrawal.amount)) {
          await this.failAndRelease(
            withdrawal.id,
            `Insufficient ${withdrawal.asset.symbol} hot-wallet custody on ${withdrawal.tokenContract.network.chainKey}: available ${available.toString()}, requested ${withdrawal.amount.toString()}.`,
          );
          continue;
        }
      }

      const claimed = await this.prisma.withdrawal.updateMany({
        where: { id: withdrawal.id, status: WithdrawalStatus.APPROVED },
        data: {
          lastBroadcastError: null,
        },
      });
      if (claimed.count !== 1) {
        continue;
      }
      try {
        if (isEvm) {
          await this.prepareEvmWithdrawalBroadcast({
            asset: withdrawal.asset,
            amount: withdrawal.amount,
            tokenContract: withdrawal.tokenContract!,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        await this.handleWithdrawalBroadcastFailure({
          withdrawalId: withdrawal.id,
          networkFamily: withdrawal.tokenContract.network.family,
          message,
        });
        continue;
      }

      const broadcasting = await this.prisma.withdrawal.updateMany({
        where: { id: withdrawal.id, status: WithdrawalStatus.APPROVED },
        data: {
          status: WithdrawalStatus.BROADCASTING,
          broadcastAttempts: { increment: 1 },
        },
      });
      if (broadcasting.count !== 1) {
        continue;
      }
      try {
        const result = await this.withTimeout(
          isEvm
            ? this.broadcastEvmWithdrawal(withdrawal, isNative)
            : this.nonEvm.sendWithdrawal({
                network: withdrawal.tokenContract.network,
                tokenContract: withdrawal.tokenContract,
                toAddress: withdrawal.toAddress,
                amount: withdrawal.amount.toString(),
                referenceId: `withdrawal:${withdrawal.id}`,
                broadcastAttempt: withdrawal.broadcastAttempts + 1,
              }),
          this.getWithdrawalBroadcastTimeoutMs(),
          'Withdrawal broadcast timed out while submitting the transaction',
        );
        await this.prisma.withdrawal.update({
          where: { id: withdrawal.id },
          data: {
            status: WithdrawalStatus.BROADCASTED,
            txHash: result.txHash,
            providerRequestId: result.providerRequestId,
            broadcastedAt: new Date(),
            lastBroadcastError: null,
          },
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        await this.handleWithdrawalBroadcastFailure({
          withdrawalId: withdrawal.id,
          networkFamily: withdrawal.tokenContract.network.family,
          message,
        });
      }
    }
  }

  private async deferApprovedWithdrawal(withdrawalId: string, reason: string): Promise<void> {
    await this.prisma.withdrawal.updateMany({
      where: { id: withdrawalId, status: WithdrawalStatus.APPROVED },
      data: { lastBroadcastError: reason },
    });
  }

  private async recoverBroadcasting(): Promise<void> {
    const stuck = await this.prisma.withdrawal.findMany({
      where: {
        status: WithdrawalStatus.BROADCASTING,
        providerRequestId: { not: null },
      },
      take: 20,
    });
    for (const withdrawal of stuck) {
      try {
        const provider = await this.custody.getTransaction(withdrawal.providerRequestId!);
        if (provider.referenceId && provider.referenceId !== `withdrawal:${withdrawal.id}`) {
          throw new Error('Privy reference ID mismatch');
        }
        if (
          ['broadcasted', 'confirmed', 'finalized', 'replaced'].includes(provider.status) &&
          provider.txHash
        ) {
          await this.prisma.withdrawal.update({
            where: { id: withdrawal.id },
            data: {
              status: WithdrawalStatus.BROADCASTED,
              txHash: provider.txHash,
              broadcastedAt: withdrawal.broadcastedAt ?? new Date(),
            },
          });
        } else if (['execution_reverted', 'failed'].includes(provider.status)) {
          await this.failAndRelease(withdrawal.id, `Privy transaction ${provider.status}`);
        }
      } catch (error) {
        this.logger.warn(
          `Withdrawal ${withdrawal.id} remains blocked pending Privy reconciliation: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  private async broadcastEvmWithdrawal(
    withdrawal: {
      id: string;
      toAddress: string;
      amount: { toString(): string };
      tokenContract: {
        standard: TokenStandard;
        address: string | null;
        decimals: number;
        network: { chainId: number | null };
      } | null;
    },
    isNative: boolean,
  ) {
    if (!withdrawal.tokenContract?.network.chainId) {
      throw new ServiceUnavailableException('EVM withdrawal network chain ID is not configured');
    }
    const rawAmount = parseUnits(
      withdrawal.amount.toString(),
      withdrawal.tokenContract.decimals,
    );
    return isNative
      ? this.custody.sendNative({
          recipient: getAddress(withdrawal.toAddress),
          value: rawAmount,
          referenceId: `withdrawal:${withdrawal.id}`,
          chainId: withdrawal.tokenContract.network.chainId,
        })
      : this.custody.sendErc20({
          tokenAddress: getAddress(withdrawal.tokenContract.address!),
          recipient: getAddress(withdrawal.toAddress),
          rawAmount,
          referenceId: `withdrawal:${withdrawal.id}`,
          chainId: withdrawal.tokenContract.network.chainId,
        });
  }

  private async confirmBroadcasted(): Promise<void> {
    const withdrawals = await this.prisma.withdrawal.findMany({
      where: { status: WithdrawalStatus.BROADCASTED, txHash: { not: null } },
      include: { asset: true, tokenContract: { include: { network: true } } },
      take: 20,
    });
    for (const withdrawal of withdrawals) {
      try {
        if (!withdrawal.tokenContract) {
          continue;
        }
        if (withdrawal.tokenContract.network.family !== NetworkFamily.EVM) {
          const result = await this.nonEvm.confirmWithdrawal({
            network: withdrawal.tokenContract.network,
            tokenContract: withdrawal.tokenContract,
            txHash: withdrawal.txHash!,
            toAddress: withdrawal.toAddress,
            amount: withdrawal.amount.toString(),
            requiredConfirmations: this.config.get<number>('WITHDRAWAL_CONFIRMATIONS', 12),
          });
          if (result.failed) {
            await this.failAndRelease(
              withdrawal.id,
              result.failureReason ?? 'Non-EVM transaction failed on-chain',
            );
            continue;
          }
          if (!result.confirmed) {
            continue;
          }
          await this.prisma.$transaction(async (client) => {
            await this.ledgerService.postTransaction({
              type: LedgerTransactionType.TREASURY_TRANSFER,
              idempotencyKey: `withdrawal-settle:${withdrawal.id}`,
              referenceType: 'Withdrawal',
              referenceId: withdrawal.id,
              description: `Settle ${withdrawal.asset.symbol} withdrawal`,
              entries: [
                {
                  accountType: LedgerAccountType.PENDING_WITHDRAWAL,
                  assetId: withdrawal.assetId,
                  direction: LedgerEntryDirection.DEBIT,
                  amount: withdrawal.amount,
                },
                {
                  accountType: LedgerAccountType.PROVIDER_CLEARING,
                  assetId: withdrawal.assetId,
                  direction: LedgerEntryDirection.CREDIT,
                  amount: withdrawal.amount,
                },
              ],
            }, client);
            await client.withdrawal.update({
              where: { id: withdrawal.id },
              data: {
                status: WithdrawalStatus.CONFIRMED,
                confirmedAt: new Date(),
                gasUsed: result.gasUsed,
                effectiveGasPrice: result.effectiveGasPrice,
              },
            });
            await this.audit.record({
              action: 'WITHDRAWAL_CONFIRMED',
              entityType: 'Withdrawal',
              entityId: withdrawal.id,
              metadata: { txHash: withdrawal.txHash! },
            }, client);
          });
          continue;
        }
        const tx = await this.rpcProvider.getTransaction(
          withdrawal.txHash!,
          withdrawal.tokenContract.network.chainKey,
        );
        if (!tx.blockNumber || tx.status === undefined) {
          continue;
        }
        if (tx.status === 0) {
          await this.failAndRelease(withdrawal.id, 'On-chain transaction reverted');
          continue;
        }
        const latestBlock = await this.rpcProvider.getLatestBlockNumber(
          withdrawal.tokenContract.network.chainKey,
        );
        const confirmations = latestBlock - tx.blockNumber + 1;
        if (
          confirmations < this.config.get<number>('WITHDRAWAL_CONFIRMATIONS', 12)
        ) {
          continue;
        }
        const hot = await this.getWithdrawalHotAccount(withdrawal.network);
        const rawAmount = parseUnits(
          withdrawal.amount.toString(),
          withdrawal.tokenContract.decimals,
        );
        const transferMatches = withdrawal.tokenContract.standard === TokenStandard.NATIVE
          ? Boolean(
              tx.to &&
                getAddress(tx.to).toLowerCase() === withdrawal.toAddress.toLowerCase() &&
                BigInt(tx.value ?? '0') === rawAmount,
            )
          : tx.logs?.some((log) => {
          if (
            !withdrawal.tokenContract?.address ||
            log.address.toLowerCase() !== withdrawal.tokenContract.address.toLowerCase()
          ) {
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
              getAddress(args.from).toLowerCase() === hot.address.toLowerCase() &&
              getAddress(args.to).toLowerCase() === withdrawal.toAddress.toLowerCase() &&
              args.value ===
                parseUnits(withdrawal.amount.toString(), withdrawal.tokenContract.decimals)
            );
          } catch (_error) {
            return false;
          }
        });
        if (!transferMatches) {
          throw new Error(
            withdrawal.tokenContract.standard === TokenStandard.NATIVE
              ? 'Withdrawal native transaction mismatch'
              : 'Withdrawal ERC20 Transfer log mismatch',
          );
        }
        await this.prisma.$transaction(async (client) => {
          await this.ledgerService.postTransaction({
            type: LedgerTransactionType.TREASURY_TRANSFER,
            idempotencyKey: `withdrawal-settle:${withdrawal.id}`,
            referenceType: 'Withdrawal',
            referenceId: withdrawal.id,
            description: `Settle ${withdrawal.asset.symbol} withdrawal`,
            entries: [
              {
                accountType: LedgerAccountType.PENDING_WITHDRAWAL,
                assetId: withdrawal.assetId,
                direction: LedgerEntryDirection.DEBIT,
                amount: withdrawal.amount,
              },
              {
                accountType: LedgerAccountType.PROVIDER_CLEARING,
                assetId: withdrawal.assetId,
                direction: LedgerEntryDirection.CREDIT,
                amount: withdrawal.amount,
              },
            ],
          }, client);
          await client.withdrawal.update({
            where: { id: withdrawal.id },
            data: {
              status: WithdrawalStatus.CONFIRMED,
              confirmedAt: new Date(),
              gasUsed: tx.gasUsed,
              effectiveGasPrice: tx.effectiveGasPrice,
            },
          });
          await this.audit.record({
            action: 'WITHDRAWAL_CONFIRMED',
            entityType: 'Withdrawal',
            entityId: withdrawal.id,
            metadata: { txHash: withdrawal.txHash!, confirmations },
          }, client);
        });
      } catch (error) {
        this.logger.warn(
          `Withdrawal ${withdrawal.id} confirmation deferred: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  async handlePrivyWebhook(eventId: string, payload: Record<string, unknown>) {
    const eventType = String(payload.type ?? '');
    const referenceId =
      typeof payload.reference_id === 'string' ? payload.reference_id : undefined;
    const transactionId =
      typeof payload.transaction_id === 'string' ? payload.transaction_id : undefined;
    const txHash =
      typeof payload.transaction_hash === 'string'
        ? payload.transaction_hash.toLowerCase()
        : undefined;
    const walletId = typeof payload.wallet_id === 'string' ? payload.wallet_id : undefined;
    const caip2 = typeof payload.caip2 === 'string' ? payload.caip2 : undefined;

    if (!eventType.startsWith('transaction.')) {
      return { accepted: true, ignored: true };
    }
    const match = referenceId?.match(/^withdrawal:(.+)$/);
    if (!match) {
      return { accepted: true, ignored: true };
    }
    if (walletId !== this.config.get<string>('PRIVY_SERVER_WALLET_ID')) {
      throw new BadRequestException('Privy webhook wallet mismatch');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.providerWebhookEvent.create({
          data: {
            id: eventId,
            provider: 'PRIVY',
            eventType,
            referenceId,
            providerTransactionId: transactionId,
            payload: payload as Prisma.InputJsonValue,
          },
        });
        const withdrawal = await tx.withdrawal.findUnique({
          where: { id: match[1] },
          include: { asset: true, tokenContract: { include: { network: true } } },
        });
        if (!withdrawal) {
          throw new NotFoundException('Webhook withdrawal was not found');
        }
        const expectedCaip2 = withdrawal.tokenContract?.network.chainId
          ? `eip155:${withdrawal.tokenContract.network.chainId}`
          : undefined;
        if (expectedCaip2 && caip2 !== expectedCaip2) {
          throw new BadRequestException('Privy webhook chain mismatch');
        }
        if (['transaction.execution_reverted', 'transaction.failed'].includes(eventType)) {
          await this.releaseWithdrawal(withdrawal, tx);
          await tx.withdrawal.update({
            where: { id: withdrawal.id },
            data: {
              status: WithdrawalStatus.FAILED,
              providerRequestId: transactionId ?? withdrawal.providerRequestId,
              txHash: txHash ?? withdrawal.txHash,
              lastBroadcastError: eventType,
            },
          });
        } else {
          await tx.withdrawal.update({
            where: { id: withdrawal.id },
            data: {
              status:
                txHash &&
                ['transaction.broadcasted', 'transaction.confirmed', 'transaction.replaced'].includes(
                  eventType,
                )
                  ? WithdrawalStatus.BROADCASTED
                  : withdrawal.status,
              providerRequestId: transactionId ?? withdrawal.providerRequestId,
              txHash: txHash ?? withdrawal.txHash,
              broadcastedAt: txHash ? withdrawal.broadcastedAt ?? new Date() : undefined,
              lastBroadcastError:
                eventType === 'transaction.provider_error' ? eventType : undefined,
            },
          });
        }
        await tx.providerWebhookEvent.update({
          where: { id: eventId },
          data: { processedAt: new Date() },
        });
        return { accepted: true, ignored: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { accepted: true, duplicate: true };
      }
      throw error;
    }
  }

  private async failAndRelease(withdrawalId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.findUniqueOrThrow({
        where: { id: withdrawalId },
        include: { asset: true },
      });
      const terminalFailureStatuses: WithdrawalStatus[] = [
        WithdrawalStatus.FAILED,
        WithdrawalStatus.REJECTED,
        WithdrawalStatus.CANCELLED,
      ];
      if (terminalFailureStatuses.includes(withdrawal.status)) {
        return;
      }
      await this.releaseWithdrawal(withdrawal, tx);
      await tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: WithdrawalStatus.FAILED, lastBroadcastError: reason },
      });
      await this.audit.record({
        action: 'WITHDRAWAL_FAILED',
        entityType: 'Withdrawal',
        entityId: withdrawal.id,
        reason,
      }, tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async getWithdrawalHotAccount(network: Chain) {
    const account = await this.prisma.custodyAccount.findFirst({
      where: {
        role: CustodyAccountRole.WITHDRAWAL_HOT,
        network,
        status: CustodyAccountStatus.ACTIVE,
      },
    });
    if (!account && (network === Chain.BITCOIN_SIGNET || network === Chain.BITCOIN)) {
      const address = await this.deriveBitcoinHotAddress(network);
      if (address) {
        return {
          id: `derived-${network.toLowerCase()}-hot`,
          role: CustodyAccountRole.WITHDRAWAL_HOT,
          provider: 'EXTERNAL' as const,
          network,
          address,
          providerWalletRef: null,
          policyRef: null,
          status: CustodyAccountStatus.ACTIVE,
          metadata: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      }
    }
    if (!account) {
      throw new ServiceUnavailableException('Active withdrawal hot wallet is not configured');
    }
    if (this.isEvmStorageNetwork(network)) {
      if (getAddress(account.address) === '0x0000000000000000000000000000000000000000') {
        throw new ServiceUnavailableException('Active withdrawal hot wallet is not configured');
      }
      return { ...account, address: getAddress(account.address).toLowerCase() };
    }
    return { ...account, address: account.address.trim() };
  }

  private async deriveBitcoinHotAddress(network: Chain): Promise<string | null> {
    const envPrefix = network === Chain.BITCOIN ? 'BITCOIN' : 'BITCOIN_SIGNET';
    const wif = this.config.get<string>(`${envPrefix}_WITHDRAWAL_WIF`, '').trim();
    if (!wif) {
      return null;
    }
    const bitcoin = await import('bitcoinjs-lib');
    const tiny = await import('tiny-secp256k1');
    const { ECPairFactory } = await import('ecpair');
    const ECPair = ECPairFactory(tiny);
    const bitcoinNetwork = network === Chain.BITCOIN
      ? bitcoin.networks.bitcoin
      : bitcoin.networks.testnet;
    let keyPair: ReturnType<typeof ECPair.fromWIF>;
    try {
      keyPair = ECPair.fromWIF(wif, bitcoinNetwork);
    } catch {
      throw new ServiceUnavailableException(`${envPrefix}_WITHDRAWAL_WIF is invalid for ${network}`);
    }
    return bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network: bitcoinNetwork,
    }).address ?? null;
  }

  private isBitcoinReplacementFeeError(family: NetworkFamily, message: string): boolean {
    return (
      family === NetworkFamily.UTXO &&
      /insufficient fee/i.test(message) &&
      /rejecting replacement|replacement/i.test(message)
    );
  }

  private isEvmStorageNetwork(network: Chain): boolean {
    const nonEvmChains: Chain[] = [
      Chain.SOLANA,
      Chain.SOLANA_DEVNET,
      Chain.BITCOIN,
      Chain.BITCOIN_SIGNET,
      Chain.TRON,
      Chain.TRON_NILE,
      Chain.TRON_SHASTA,
    ];
    return !nonEvmChains.includes(network);
  }

  private async releaseWithdrawal(withdrawal: {
    id: string;
    userId: string;
    assetId: string;
    amount: Prisma.Decimal;
    feeAmount: Prisma.Decimal;
    asset: { symbol: string };
  }, client: PrismaService | Prisma.TransactionClient = this.prisma) {
    return this.ledgerService.postTransaction({
      type: LedgerTransactionType.WITHDRAWAL_RELEASE,
      idempotencyKey: `withdrawal-release:${withdrawal.id}`,
      referenceType: 'Withdrawal',
      referenceId: withdrawal.id,
      description: `Release ${withdrawal.asset.symbol} withdrawal reserve`,
      entries: this.buildReleaseEntries({
        userId: withdrawal.userId,
        assetId: withdrawal.assetId,
        amount: withdrawal.amount,
        feeAmount: withdrawal.feeAmount,
      }),
    }, client);
  }

  private async getWithdrawalForDecision(withdrawalId: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { asset: true },
    });

    if (!withdrawal) {
      throw new NotFoundException('Withdrawal not found');
    }

    return withdrawal;
  }

  private buildReserveEntries(input: {
    userId: string;
    assetId: string;
    amount: Prisma.Decimal;
    feeAmount: Prisma.Decimal;
  }): LedgerPostingEntry[] {
    const totalDebit = input.amount.plus(input.feeAmount);
    const entries: LedgerPostingEntry[] = [
      {
        accountType: LedgerAccountType.USER_SPOT,
        userId: input.userId,
        assetId: input.assetId,
        direction: LedgerEntryDirection.DEBIT,
        amount: totalDebit,
      },
      {
        accountType: LedgerAccountType.PENDING_WITHDRAWAL,
        assetId: input.assetId,
        direction: LedgerEntryDirection.CREDIT,
        amount: input.amount,
      },
    ];

    if (input.feeAmount.greaterThan(0)) {
      entries.push({
        accountType: LedgerAccountType.GAS_FEES,
        assetId: input.assetId,
        direction: LedgerEntryDirection.CREDIT,
        amount: input.feeAmount,
      });
    }

    return entries;
  }

  private buildReleaseEntries(input: {
    userId: string;
    assetId: string;
    amount: Prisma.Decimal;
    feeAmount: Prisma.Decimal;
  }): LedgerPostingEntry[] {
    const totalCredit = input.amount.plus(input.feeAmount);
    const entries: LedgerPostingEntry[] = [
      {
        accountType: LedgerAccountType.PENDING_WITHDRAWAL,
        assetId: input.assetId,
        direction: LedgerEntryDirection.DEBIT,
        amount: input.amount,
      },
      {
        accountType: LedgerAccountType.USER_SPOT,
        userId: input.userId,
        assetId: input.assetId,
        direction: LedgerEntryDirection.CREDIT,
        amount: totalCredit,
      },
    ];

    if (input.feeAmount.greaterThan(0)) {
      entries.push({
        accountType: LedgerAccountType.GAS_FEES,
        assetId: input.assetId,
        direction: LedgerEntryDirection.DEBIT,
        amount: input.feeAmount,
      });
    }

    return entries;
  }

  private isMainnetDisplayMode(): boolean {
    return (
      this.config.get<boolean>('DISPLAY_MAINNET_ONLY', false) ||
      this.config.get<boolean>('MAINNET_ENABLED', false)
    );
  }
}
