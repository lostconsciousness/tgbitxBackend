import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  Chain,
  CustodyAccountRole,
  CustodyAccountStatus,
  Prisma,
  TokenStandard,
  TreasuryTransferStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RPC_PROVIDER } from '../rpc/rpc.module';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { Inject } from '@nestjs/common';
import { Address, Hex, decodeEventLog, formatUnits, getAddress, parseAbiItem, parseUnits } from 'viem';
import { PrivyCustodyService } from './privy-custody.service';
import { AuditService } from '../audit/audit.service';
import { nativeGasSymbol } from '../../common/utils/network-metadata';
import { resolveWithdrawalNativeGasReserve } from '../../common/utils/withdrawal-native-gas.policy';

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);
  private rebalanceRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly custody: PrivyCustodyService,
    private readonly audit: AuditService,
    @Inject(RPC_PROVIDER) private readonly rpcProvider: RpcProvider,
  ) {}

  // Withdrawals call ensureHotWalletFunded on demand. This slower sweep is only
  // a safety reconciliation and must not poll every custody balance twice a minute.
  @Cron('0 */2 * * * *')
  async runAutoRebalance(): Promise<void> {
    if (
      this.rebalanceRunning ||
      !this.config.get<boolean>('TREASURY_REBALANCE_ENABLED', false)
    ) {
      return;
    }

    this.rebalanceRunning = true;
    try {
      if (
        this.config.get<boolean>('MAINNET_ENABLED', false) &&
        !this.config.get<boolean>('TREASURY_REBALANCE_MAINNET_ENABLED', false)
      ) {
        this.logger.warn('Treasury auto-rebalance is blocked on mainnet by configuration');
        return;
      }

      await this.confirmBroadcastedTransfers();
      await this.failStalePreBroadcastTransfers();
      await this.recoverBroadcastingTransfers();
      await this.rebalanceAllWithdrawalAssets();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      const transientRpc =
        message === 'RPC HTTP 429' ||
        /rate limit|too many requests|limit exceeded/i.test(message);
      if (transientRpc) {
        this.logger.warn(`Treasury auto-rebalance deferred: ${message}`);
      } else {
        this.logger.error(`Treasury auto-rebalance failed: ${message}`);
      }
    } finally {
      this.rebalanceRunning = false;
    }
  }

  listAccounts() {
    return this.prisma.custodyAccount.findMany({
      orderBy: [{ network: 'asc' }, { role: 'asc' }],
    });
  }

  async captureBalances() {
    const [accounts, assets] = await Promise.all([
      this.prisma.custodyAccount.findMany({
        where: { status: CustodyAccountStatus.ACTIVE },
      }),
      this.prisma.asset.findMany({
        where: { tokenAddress: { not: null } },
      }),
    ]);
    const snapshots = [];
    for (const account of accounts) {
      for (const asset of assets) {
        const balance = await this.rpcProvider.getBalance(
          account.address,
          asset.tokenAddress!,
        );
        snapshots.push(
          await this.prisma.custodyBalanceSnapshot.create({
            data: {
              custodyAccountId: account.id,
              assetId: asset.id,
              balance: new Prisma.Decimal(balance.value),
              source: 'RPC',
            },
          }),
        );
      }
    }
    return snapshots;
  }

  async capturePersonalDepositBalances() {
    const [addresses, assets] = await Promise.all([
      this.prisma.userDepositAddress.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, address: true, network: true },
      }),
      this.prisma.asset.findMany({
        where: {
          depositEnabled: true,
          tokenAddress: { not: null },
          contractVerifiedAt: { not: null },
        },
      }),
    ]);
    const balances: Array<{
      depositAddressId: string;
      assetId: string;
      balance: Prisma.Decimal;
    }> = [];
    for (const address of addresses) {
      for (const asset of assets.filter((candidate) => candidate.chain === address.network)) {
        const balance = await this.rpcProvider.getBalance(address.address, asset.tokenAddress!);
        balances.push({
          depositAddressId: address.id,
          assetId: asset.id,
          balance: new Prisma.Decimal(balance.value),
        });
      }
    }
    return balances;
  }

  async getOperationalStatus() {
    const [addressCounts, sweepCounts, gasAccount, rebalances] = await Promise.all([
      this.prisma.userDepositAddress.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.depositSweep.groupBy({
        by: ['status'],
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.custodyAccount.findFirst({
        where: {
          role: CustodyAccountRole.SWEEP_GAS,
          status: CustodyAccountStatus.ACTIVE,
        },
      }),
      this.prisma.treasuryTransfer.groupBy({
        by: ['status'],
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);
    const gasBalance = gasAccount
      ? await this.rpcProvider.getBalance(gasAccount.address)
      : null;
    return {
      personalDepositAddresses: addressCounts,
      sweeps: sweepCounts,
      sweepGas: gasAccount
        ? { address: gasAccount.address, balanceWei: gasBalance?.value ?? null }
        : null,
      treasuryRebalances: rebalances,
      treasuryRebalanceConfig: {
        enabled: this.config.get<boolean>('TREASURY_REBALANCE_ENABLED', false),
        assetSymbol: this.config.get<string>('TREASURY_REBALANCE_ASSET_SYMBOL', 'USDC'),
        hotMinAmount: this.config.get<string>('TREASURY_REBALANCE_HOT_MIN_AMOUNT', '0'),
        hotTargetAmount: this.config.get<string>('TREASURY_REBALANCE_HOT_TARGET_AMOUNT', '0'),
        maxSingleAmount: this.config.get<string>('TREASURY_REBALANCE_MAX_SINGLE_AMOUNT', '0'),
        hotPercent: this.config.get<number>('TREASURY_REBALANCE_HOT_PERCENT', 0),
      },
    };
  }

  async proposeTransfer(input: {
    sourceRole: CustodyAccountRole;
    destinationRole: CustodyAccountRole;
    assetSymbol: string;
    amount: string;
    reason: string;
    proposedByUserId: string;
  }) {
    const amount = new Prisma.Decimal(input.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Treasury transfer amount must be positive');
    }
    const [source, destination, asset] = await Promise.all([
      this.prisma.custodyAccount.findFirst({
        where: { role: input.sourceRole, status: CustodyAccountStatus.ACTIVE },
      }),
      this.prisma.custodyAccount.findFirst({
        where: { role: input.destinationRole, status: CustodyAccountStatus.ACTIVE },
      }),
      this.prisma.asset.findUnique({ where: { symbol: input.assetSymbol.toUpperCase() } }),
    ]);
    if (!source || !destination || !asset) {
      throw new NotFoundException('Treasury account or asset was not found');
    }
    if (source.id === destination.id) {
      throw new BadRequestException('Treasury source and destination must differ');
    }

    return this.prisma.treasuryTransfer.create({
      data: {
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        assetId: asset.id,
        amount,
        reason: input.reason,
        proposedByUserId: input.proposedByUserId,
      },
      include: { sourceAccount: true, destinationAccount: true, asset: true },
    });
  }

  async approveTransfer(id: string, approvedByUserId: string) {
    const transfer = await this.prisma.treasuryTransfer.findUnique({ where: { id } });
    if (!transfer) {
      throw new NotFoundException('Treasury transfer not found');
    }
    if (transfer.status !== TreasuryTransferStatus.PROPOSED) {
      throw new BadRequestException('Treasury transfer is not proposed');
    }
    return this.prisma.treasuryTransfer.update({
      where: { id },
      data: {
        status: TreasuryTransferStatus.APPROVED,
        approvedByUserId,
        approvedAt: new Date(),
      },
    });
  }

  getActiveAccount(role: CustodyAccountRole) {
    return this.prisma.custodyAccount.findFirst({
      where: { role, status: CustodyAccountStatus.ACTIVE },
    });
  }

  async getCustodialLiquidBalance(input: {
    assetSymbol: string;
    networkKey: string;
  }): Promise<{
    hot: Prisma.Decimal;
    treasury: Prisma.Decimal;
    total: Prisma.Decimal;
  } | null> {
    const context = await this.resolveRebalanceContext(input.assetSymbol, input.networkKey);
    if (!context) {
      return null;
    }
    const [hot, treasury] = await Promise.all([
      this.readSpendableBalance(
        context.destination.address,
        context.tokenContract,
        context.network.chainKey,
      ),
      this.readSpendableBalance(
        context.source.address,
        context.tokenContract,
        context.network.chainKey,
      ),
    ]);
    return { hot, treasury, total: hot.plus(treasury) };
  }

  async ensureHotWalletFunded(input: {
    assetSymbol: string;
    networkKey: string;
    amount: Prisma.Decimal;
    maxWaitMs?: number;
    failFastWhenUnderfunded?: boolean;
  }): Promise<void> {
    if (!this.config.get<boolean>('TREASURY_REBALANCE_ENABLED', false)) {
      return;
    }
    const context = await this.resolveRebalanceContext(input.assetSymbol, input.networkKey);
    if (!context) {
      return;
    }
    const { isNative } = context;
    const gasReserve = isNative
      ? new Prisma.Decimal(
          resolveWithdrawalNativeGasReserve(input.networkKey, this.config),
        )
      : new Prisma.Decimal(0);
    const required = input.amount.plus(gasReserve);

    if (isNative && input.failFastWhenUnderfunded) {
      const [hot, treasury] = await Promise.all([
        this.readSpendableBalance(
          context.destination.address,
          context.tokenContract,
          context.network.chainKey,
        ),
        this.readSpendableBalance(
          context.source.address,
          context.tokenContract,
          context.network.chainKey,
        ),
      ]);
      if (hot.plus(treasury).lessThan(input.amount)) {
        throw new ServiceUnavailableException(
          `Insufficient ${context.asset.symbol} custody on ${context.network.chainKey}: hot ${hot.toString()}, treasury ${treasury.toString()}, requested ${input.amount.toString()}`,
        );
      }
    }

    await this.waitForHotWalletBalance(
      context,
      required,
      async () => {
        await this.createAndBroadcastHotWalletTopup(
          input.networkKey,
          input.assetSymbol,
          required,
        );
      },
      {
        maxWaitMs: input.maxWaitMs,
        failFastWhenUnderfunded: input.failFastWhenUnderfunded,
        withdrawalAmount: isNative ? input.amount : undefined,
        gasReserve: isNative ? gasReserve : undefined,
      },
    );

    if (isNative) {
      await this.ensureHotWalletNativeBalance(context, required, {
        maxWaitMs: input.maxWaitMs,
        skipTreasuryRebalance: true,
      });
    }
  }

  async ensureHotWalletNativeGas(input: {
    networkKey: string;
    minAmount?: string;
    maxWaitMs?: number;
    failFastWhenUnderfunded?: boolean;
  }): Promise<void> {
    const networkKey = input.networkKey.trim().toLowerCase();
    const context = await this.resolveRebalanceContext(
      nativeGasSymbol(networkKey),
      networkKey,
    );
    if (!context) {
      return;
    }
    const target = new Prisma.Decimal(
      input.minAmount ??
        resolveWithdrawalNativeGasReserve(networkKey, this.config),
    );
    await this.ensureHotWalletNativeBalance(context, target, {
      maxWaitMs: input.maxWaitMs,
      failFastWhenUnderfunded: input.failFastWhenUnderfunded,
    });
  }

  private async ensureHotWalletNativeBalance(
    context: NonNullable<Awaited<ReturnType<TreasuryService['resolveRebalanceContext']>>>,
    target: Prisma.Decimal,
    options?: {
      maxWaitMs?: number;
      failFastWhenUnderfunded?: boolean;
      skipTreasuryRebalance?: boolean;
    },
  ): Promise<void> {
    const timeoutMs =
      options?.maxWaitMs ??
      this.config.get<number>('TREASURY_REBALANCE_WAIT_MS', 90_000);
    const pollMs = this.config.get<number>('TREASURY_REBALANCE_POLL_MS', 2_000);
    const deadline = Date.now() + timeoutMs;
    let treasuryFunded = options?.skipTreasuryRebalance ?? false;
    let sweepGasFunded = false;

    while (Date.now() < deadline) {
      const hotBalance = await this.readSpendableBalance(
        context.destination.address,
        context.tokenContract,
        context.network.chainKey,
      );
      if (hotBalance.greaterThanOrEqualTo(target)) {
        return;
      }

      if (!treasuryFunded) {
        await this.createAndBroadcastHotWalletTopup(
          context.network.chainKey,
          context.asset.symbol,
          target,
        );
        treasuryFunded = true;
        await this.confirmBroadcastedTransfers();
        continue;
      }

      if (!sweepGasFunded) {
        await this.topUpHotWalletFromSweepGas({
          hotAddress: context.destination.address,
          networkKey: context.network.chainKey,
          chainId: context.network.chainId ?? undefined,
          targetBalance: target,
          decimals: context.tokenContract.decimals,
          referenceId: `withdrawal-hot-gas:${context.network.chainKey}:${Date.now()}`,
        });
        sweepGasFunded = true;
        continue;
      }

      if (options?.failFastWhenUnderfunded) {
        const hotAfter = await this.readSpendableBalance(
          context.destination.address,
          context.tokenContract,
          context.network.chainKey,
        );
        if (hotAfter.greaterThanOrEqualTo(target)) {
          return;
        }
        throw new ServiceUnavailableException(
          `Insufficient ${context.asset.symbol} gas on withdrawal hot wallet (${context.network.chainKey}): hot ${hotAfter.toString()}, required ${target.toString()}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const hotBalance = await this.readSpendableBalance(
      context.destination.address,
      context.tokenContract,
      context.network.chainKey,
    );
    throw new ServiceUnavailableException(
      `Withdrawal hot wallet gas funding timed out on ${context.network.chainKey}: hot ${hotBalance.toString()}, required ${target.toString()}`,
    );
  }

  private async topUpHotWalletFromSweepGas(input: {
    hotAddress: string;
    networkKey: string;
    chainId?: number;
    targetBalance: Prisma.Decimal;
    decimals: number;
    referenceId: string;
  }): Promise<void> {
    if (!this.custody.isEnabled()) {
      return;
    }
    const minTopupWei = BigInt(this.config.get<string>('SWEEP_GAS_TOPUP_WEI', '0'));
    if (minTopupWei <= 0n) {
      this.logger.warn(
        `SWEEP_GAS top-up skipped on ${input.networkKey}: SWEEP_GAS_TOPUP_WEI is not configured`,
      );
      return;
    }
    if (!input.chainId) {
      throw new ServiceUnavailableException(
        `Withdrawal hot wallet gas top-up on ${input.networkKey} requires chain ID`,
      );
    }

    const targetWei = parseUnits(input.targetBalance.toString(), input.decimals);
    const balanceWei = BigInt(
      (
        await this.rpcProvider.getBalance(
          input.hotAddress,
          undefined,
          input.networkKey,
        )
      ).value,
    );
    if (balanceWei >= targetWei) {
      return;
    }

    const deficit = targetWei - balanceWei;
    const maxTopup = BigInt(this.config.get<string>('SWEEP_GAS_MAX_TOPUP_WEI', '0'));
    const topup = deficit > maxTopup && maxTopup > 0n ? maxTopup : deficit;
    if (topup <= 0n) {
      throw new ServiceUnavailableException(
        'Withdrawal hot wallet gas top-up exceeds configured SWEEP_GAS limit',
      );
    }
    if (maxTopup <= 0n) {
      throw new ServiceUnavailableException(
        'Withdrawal hot wallet gas top-up requires SWEEP_GAS_MAX_TOPUP_WEI',
      );
    }

    const result = await this.custody.sendNativeFromSweepGas({
      recipient: getAddress(input.hotAddress),
      value: topup,
      referenceId: input.referenceId,
      chainId: input.chainId,
    });
    await this.audit.record({
      action: 'WITHDRAWAL_HOT_GAS_FUNDED',
      entityType: 'CustodyAccount',
      entityId: input.hotAddress,
      metadata: {
        networkKey: input.networkKey,
        valueWei: topup.toString(),
        targetBalance: input.targetBalance.toString(),
        txHash: result.txHash,
        providerRequestId: result.providerRequestId,
      },
    });
  }

  private async waitForHotWalletBalance(
    context: NonNullable<Awaited<ReturnType<TreasuryService['resolveRebalanceContext']>>>,
    required: Prisma.Decimal,
    fund: () => Promise<void>,
    options?: {
      maxWaitMs?: number;
      failFastWhenUnderfunded?: boolean;
      withdrawalAmount?: Prisma.Decimal;
      gasReserve?: Prisma.Decimal;
    },
  ): Promise<void> {
    const timeoutMs =
      options?.maxWaitMs ??
      this.config.get<number>('TREASURY_REBALANCE_WAIT_MS', 90_000);
    const pollMs = this.config.get<number>('TREASURY_REBALANCE_POLL_MS', 2_000);
    const deadline = Date.now() + timeoutMs;
    let funded = false;

    while (Date.now() < deadline) {
      const hotBalance = await this.readSpendableBalance(
        context.destination.address,
        context.tokenContract,
        context.network.chainKey,
      );
      if (hotBalance.greaterThanOrEqualTo(required)) {
        return;
      }
      if (!funded) {
        await fund();
        funded = true;
        await this.confirmBroadcastedTransfers();
        if (options?.failFastWhenUnderfunded) {
          const [hotAfterFund, treasuryBalance] = await Promise.all([
            this.readSpendableBalance(
              context.destination.address,
              context.tokenContract,
              context.network.chainKey,
            ),
            this.readSpendableBalance(
              context.source.address,
              context.tokenContract,
              context.network.chainKey,
            ),
          ]);
          if (hotAfterFund.greaterThanOrEqualTo(required)) {
            return;
          }
          const custodyTotal = hotAfterFund.plus(treasuryBalance);
          if (custodyTotal.lessThan(required)) {
            if (
              options?.withdrawalAmount &&
              options.gasReserve &&
              custodyTotal.greaterThanOrEqualTo(options.withdrawalAmount)
            ) {
              await this.topUpHotWalletFromSweepGas({
                hotAddress: context.destination.address,
                networkKey: context.network.chainKey,
                chainId: context.network.chainId ?? undefined,
                targetBalance: required,
                decimals: context.tokenContract.decimals,
                referenceId: `withdrawal-hot-gas:${context.network.chainKey}:${Date.now()}`,
              });
              continue;
            }
            throw new ServiceUnavailableException(
              `Insufficient ${context.asset.symbol} custody on ${context.network.chainKey}: hot ${hotAfterFund.toString()}, treasury ${treasuryBalance.toString()}, required ${required.toString()}`,
            );
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const [hotBalance, treasuryBalance] = await Promise.all([
      this.readSpendableBalance(
        context.destination.address,
        context.tokenContract,
        context.network.chainKey,
      ),
      this.readSpendableBalance(
        context.source.address,
        context.tokenContract,
        context.network.chainKey,
      ),
    ]);
    throw new ServiceUnavailableException(
      `Withdrawal hot wallet funding timed out on ${context.network.chainKey}: hot ${hotBalance.toString()}, treasury ${treasuryBalance.toString()}, required ${required.toString()}`,
    );
  }

  private async resolveRebalanceContext(assetSymbol: string, networkKey: string) {
    const network = await this.prisma.network.findUnique({
      where: { chainKey: networkKey.trim().toLowerCase() },
    });
    if (!network?.legacyChain) {
      return null;
    }
    const asset = await this.prisma.asset.findUnique({
      where: { symbol: assetSymbol.toUpperCase() },
    });
    if (!asset) {
      return null;
    }
    const tokenContract =
      (await this.prisma.tokenContract.findUnique({
        where: {
          assetId_networkId_standard: {
            assetId: asset.id,
            networkId: network.id,
            standard: TokenStandard.NATIVE,
          },
        },
      })) ??
      (await this.prisma.tokenContract.findUnique({
        where: {
          assetId_networkId_standard: {
            assetId: asset.id,
            networkId: network.id,
            standard: TokenStandard.ERC20,
          },
        },
      }));
    if (!tokenContract) {
      return null;
    }
    const isNative = tokenContract.standard === TokenStandard.NATIVE;
    if (
      !isNative &&
      (!tokenContract.address ||
        !tokenContract.contractVerifiedAt ||
        !tokenContract.contractCodeHash ||
        tokenContract.verifiedChainId !== network.chainId)
    ) {
      return null;
    }
    if (isNative && (!tokenContract.contractVerifiedAt || tokenContract.verifiedChainId !== network.chainId)) {
      return null;
    }
    const [source, destination] = await Promise.all([
      this.prisma.custodyAccount.findFirst({
        where: {
          role: CustodyAccountRole.DEPOSIT_TREASURY,
          status: CustodyAccountStatus.ACTIVE,
          network: network.legacyChain,
        },
      }),
      this.prisma.custodyAccount.findFirst({
        where: {
          role: CustodyAccountRole.WITHDRAWAL_HOT,
          status: CustodyAccountStatus.ACTIVE,
          network: network.legacyChain,
        },
      }),
    ]);
    if (!source?.providerWalletRef || !destination) {
      return null;
    }
    return { asset, tokenContract, network, source, destination, isNative };
  }

  private async readSpendableBalance(
    address: string,
    tokenContract: { standard: TokenStandard; address: string | null; decimals: number },
    networkKey: string,
  ): Promise<Prisma.Decimal> {
    const balance = await this.rpcProvider.getBalance(
      address,
      tokenContract.standard === TokenStandard.NATIVE ? undefined : tokenContract.address ?? undefined,
      networkKey,
      tokenContract.decimals,
    );
    if (tokenContract.standard === TokenStandard.NATIVE) {
      return new Prisma.Decimal(formatUnits(BigInt(balance.value), tokenContract.decimals));
    }
    return new Prisma.Decimal(balance.value);
  }

  private async rebalanceAllWithdrawalAssets(): Promise<void> {
    const configured = this.config.get<string>('TREASURY_REBALANCE_ASSET_SYMBOL', '');
    const explicitSymbols = configured
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);

    const treasuryNetworks = await this.prisma.custodyAccount.findMany({
      where: {
        role: CustodyAccountRole.DEPOSIT_TREASURY,
        status: CustodyAccountStatus.ACTIVE,
      },
      select: { network: true },
    });
    const legacyChains = [...new Set(treasuryNetworks.map((account) => account.network))];
    if (legacyChains.length === 0) {
      return;
    }

    const rebalanceNetworks = await this.prisma.network.findMany({
      where: {
        legacyChain: { in: legacyChains },
        ...(this.config.get<boolean>('MAINNET_ENABLED', false)
          ? { mainnet: true }
          : {}),
      },
      orderBy: { chainKey: 'asc' },
    });
    if (rebalanceNetworks.length === 0) {
      return;
    }

    for (const network of rebalanceNetworks) {
      const symbols =
        explicitSymbols.length > 0
          ? explicitSymbols
          : [
              ...new Set(
                (
                  await this.prisma.tokenContract.findMany({
                    where: {
                      withdrawalEnabled: true,
                      networkId: network.id,
                      network: { withdrawalEnabled: true },
                    },
                    include: { asset: true },
                  })
                ).map((contract) => contract.asset.symbol),
              ),
            ];

      for (const symbol of symbols) {
        await this.createAndBroadcastHotWalletTopup(network.chainKey, symbol);
      }
    }
  }

  private async createAndBroadcastHotWalletTopup(
    networkKey?: string,
    assetSymbolOverride?: string,
    minimumNeeded?: Prisma.Decimal,
  ): Promise<void> {
    if (!this.custody.isEnabled()) {
      return;
    }

    const assetSymbol =
      assetSymbolOverride?.trim().toUpperCase() ??
      this.config
        .get<string>('TREASURY_REBALANCE_ASSET_SYMBOL', 'USDC')
        .split(',')[0]
        ?.trim()
        .toUpperCase() ??
      'USDC';
    const resolvedNetworkKey =
      networkKey?.trim().toLowerCase() ??
      (await this.prisma.network.findFirst({
        where: { chainId: this.config.get<number>('ONCHAIN_CHAIN_ID', 421614) },
      }))?.chainKey;
    if (!resolvedNetworkKey) {
      this.logger.warn('Treasury auto-rebalance skipped: network is not configured');
      return;
    }
    const context = await this.resolveRebalanceContext(assetSymbol, resolvedNetworkKey);
    if (!context) {
      this.logger.warn(
        `Treasury auto-rebalance skipped for ${assetSymbol} on ${resolvedNetworkKey}: ` +
        'asset, token contract, or custody accounts are missing',
      );
      return;
    }
    const { asset, tokenContract, network, source, destination, isNative } = context;
    const activeTransfer = await this.prisma.treasuryTransfer.findFirst({
      where: {
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        assetId: asset.id,
        status: {
          in: [
            TreasuryTransferStatus.APPROVED,
            TreasuryTransferStatus.BROADCASTING,
            TreasuryTransferStatus.BROADCASTED,
          ],
        },
      },
    });
    if (activeTransfer) return;

    const min = new Prisma.Decimal(
      this.config.get<string>('TREASURY_REBALANCE_HOT_MIN_AMOUNT', '0'),
    );
    const target = new Prisma.Decimal(
      this.config.get<string>('TREASURY_REBALANCE_HOT_TARGET_AMOUNT', '0'),
    );
    const maxSingle = new Prisma.Decimal(
      this.config.get<string>('TREASURY_REBALANCE_MAX_SINGLE_AMOUNT', '0'),
    );
    const hotPercent = new Prisma.Decimal(
      this.config.get<number>('TREASURY_REBALANCE_HOT_PERCENT', 0),
    );
    const percentageMode = !minimumNeeded && hotPercent.greaterThan(0);
    if (
      !percentageMode &&
      (min.lessThanOrEqualTo(0) ||
        target.lessThanOrEqualTo(min) ||
        maxSingle.lessThanOrEqualTo(0))
    ) {
      this.logger.warn('Treasury auto-rebalance skipped: thresholds are not configured');
      return;
    }

    const [hot, treasury] = await Promise.all([
      this.readSpendableBalance(destination.address, tokenContract, network.chainKey),
      this.readSpendableBalance(source.address, tokenContract, network.chainKey),
    ]);
    if (minimumNeeded && hot.greaterThanOrEqualTo(minimumNeeded)) {
      return;
    }
    if (!minimumNeeded && !percentageMode && hot.greaterThanOrEqualTo(min)) {
      return;
    }
    if (treasury.lessThanOrEqualTo(0)) {
      this.logger.warn(
        `Treasury auto-rebalance skipped: treasury has no ${asset.symbol} on ${network.chainKey}`,
      );
      return;
    }

    const targetTopup = percentageMode
      ? hot.plus(treasury).mul(hotPercent).div(100).minus(hot)
      : minimumNeeded
        ? Prisma.Decimal.max(minimumNeeded.minus(hot), min.minus(hot))
        : target.minus(hot);
    const amount = percentageMode
      ? Prisma.Decimal.min(Prisma.Decimal.max(targetTopup, 0), treasury)
      : Prisma.Decimal.min(Prisma.Decimal.max(targetTopup, 0), treasury, maxSingle);
    if (amount.lessThanOrEqualTo(0)) {
      return;
    }

    const transfer = await this.prisma.treasuryTransfer.create({
      data: {
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        assetId: asset.id,
        amount,
        status: TreasuryTransferStatus.BROADCASTING,
        reason: `Auto-rebalance ${asset.symbol} hot wallet to target`,
        approvedAt: new Date(),
      },
      include: { sourceAccount: true, destinationAccount: true, asset: true },
    });
    await this.audit.record({
      action: 'TREASURY_REBALANCE_STARTED',
      entityType: 'TreasuryTransfer',
      entityId: transfer.id,
      metadata: {
        sourceRole: source.role,
        destinationRole: destination.role,
        assetSymbol: asset.symbol,
        networkKey: network.chainKey,
        amount: amount.toString(),
        hotBalanceBefore: hot.toString(),
        treasuryBalanceBefore: treasury.toString(),
      },
    });

    try {
      const rawAmount = parseUnits(amount.toString(), tokenContract.decimals);
      await this.ensureTreasuryTransactionGas({
        transferId: transfer.id,
        treasuryAddress: source.address,
        networkKey: network.chainKey,
        chainId: network.chainId ?? undefined,
        nativeTransferValue: isNative ? rawAmount : 0n,
      });
      const result = isNative
        ? await this.custody.sendNativeFromWallet({
            walletId: source.providerWalletRef!,
            recipient: getAddress(destination.address),
            value: rawAmount,
            referenceId: `treasury-rebalance:${transfer.id}`,
            chainId: network.chainId ?? undefined,
          })
        : await this.custody.sendErc20FromWallet({
            walletId: source.providerWalletRef!,
            tokenAddress: getAddress(tokenContract.address!),
            recipient: getAddress(destination.address),
            rawAmount,
            referenceId: `treasury-rebalance:${transfer.id}`,
            chainId: network.chainId ?? undefined,
          });
      await this.prisma.treasuryTransfer.update({
        where: { id: transfer.id },
        data: {
          status: TreasuryTransferStatus.BROADCASTED,
          txHash: result.txHash,
          providerRequestId: result.providerRequestId,
          broadcastedAt: new Date(),
        },
      });
      await this.audit.record({
        action: 'TREASURY_REBALANCE_BROADCASTED',
        entityType: 'TreasuryTransfer',
        entityId: transfer.id,
        metadata: {
          txHash: result.txHash,
          providerRequestId: result.providerRequestId,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown Privy error';
      await this.prisma.treasuryTransfer.update({
        where: { id: transfer.id },
        data: {
          status: TreasuryTransferStatus.FAILED,
          failureReason: reason.slice(0, 1000),
        },
      });
      await this.audit.record({
        action: 'TREASURY_REBALANCE_FAILED',
        entityType: 'TreasuryTransfer',
        entityId: transfer.id,
        reason: reason.slice(0, 1000),
      });
    }
  }

  private async ensureTreasuryTransactionGas(input: {
    transferId: string;
    treasuryAddress: string;
    networkKey: string;
    chainId?: number;
    nativeTransferValue: bigint;
  }): Promise<void> {
    const gasReserve = BigInt(this.config.get<string>('SWEEP_GAS_TOPUP_WEI', '0'));
    if (gasReserve <= 0n) return;
    if (!input.chainId) {
      throw new ServiceUnavailableException('Treasury rebalance network chain ID is missing');
    }

    const required = input.nativeTransferValue + gasReserve;
    const balance = BigInt(
      (await this.rpcProvider.getBalance(
        input.treasuryAddress,
        undefined,
        input.networkKey,
      )).value,
    );
    if (balance >= required) return;

    const topup = required - balance;
    const maxTopup = BigInt(this.config.get<string>('SWEEP_GAS_MAX_TOPUP_WEI', '0'));
    if (maxTopup <= 0n || topup > maxTopup) {
      throw new ServiceUnavailableException(
        'Treasury gas top-up is outside the configured SWEEP_GAS limit',
      );
    }

    const result = await this.custody.sendNativeFromSweepGas({
      recipient: getAddress(input.treasuryAddress),
      value: topup,
      referenceId: `treasury-rebalance-gas:${input.transferId}`,
      chainId: input.chainId,
    });
    await this.audit.record({
      action: 'TREASURY_REBALANCE_GAS_FUNDED',
      entityType: 'TreasuryTransfer',
      entityId: input.transferId,
      metadata: {
        networkKey: input.networkKey,
        valueWei: topup.toString(),
        txHash: result.txHash,
        providerRequestId: result.providerRequestId,
      },
    });

    const timeoutMs = this.config.get<number>('TREASURY_REBALANCE_WAIT_MS', 90_000);
    const pollMs = this.config.get<number>('TREASURY_REBALANCE_POLL_MS', 2_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const funded = BigInt(
        (await this.rpcProvider.getBalance(
          input.treasuryAddress,
          undefined,
          input.networkKey,
        )).value,
      );
      if (funded >= required) return;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new ServiceUnavailableException(
      'Treasury gas wallet funding is still confirming; rebalance will retry',
    );
  }

  private async recoverBroadcastingTransfers(): Promise<void> {
    const transfers = await this.prisma.treasuryTransfer.findMany({
      where: {
        status: TreasuryTransferStatus.BROADCASTING,
        providerRequestId: { not: null },
      },
      take: 20,
    });
    for (const transfer of transfers) {
      try {
        const provider = await this.custody.getTransaction(transfer.providerRequestId!);
        if (provider.referenceId && provider.referenceId !== `treasury-rebalance:${transfer.id}`) {
          throw new Error('Privy reference ID mismatch');
        }
        if (
          ['broadcasted', 'confirmed', 'finalized', 'replaced'].includes(provider.status) &&
          provider.txHash
        ) {
          await this.prisma.treasuryTransfer.update({
            where: { id: transfer.id },
            data: {
              status: TreasuryTransferStatus.BROADCASTED,
              txHash: provider.txHash,
              broadcastedAt: transfer.broadcastedAt ?? new Date(),
            },
          });
        } else if (['execution_reverted', 'failed', 'provider_error'].includes(provider.status)) {
          await this.prisma.treasuryTransfer.update({
            where: { id: transfer.id },
            data: {
              status: TreasuryTransferStatus.FAILED,
              failureReason: `Privy transaction ${provider.status}`,
            },
          });
        }
      } catch (error) {
        this.logger.warn(
          `Treasury transfer ${transfer.id} remains pending reconciliation: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  private async failStalePreBroadcastTransfers(): Promise<void> {
    const waitMs = this.config.get<number>('TREASURY_REBALANCE_WAIT_MS', 90_000);
    const stale = await this.prisma.treasuryTransfer.findMany({
      where: {
        status: TreasuryTransferStatus.BROADCASTING,
        providerRequestId: null,
        txHash: null,
        updatedAt: { lt: new Date(Date.now() - waitMs) },
      },
      select: { id: true },
      take: 20,
    });
    for (const transfer of stale) {
      const updated = await this.prisma.treasuryTransfer.updateMany({
        where: {
          id: transfer.id,
          status: TreasuryTransferStatus.BROADCASTING,
          providerRequestId: null,
          txHash: null,
        },
        data: {
          status: TreasuryTransferStatus.FAILED,
          failureReason: 'Treasury gas funding was interrupted before asset broadcast; retrying',
        },
      });
      if (updated.count === 1) {
        await this.audit.record({
          action: 'TREASURY_REBALANCE_STALE_FAILED',
          entityType: 'TreasuryTransfer',
          entityId: transfer.id,
          reason: 'Gas funding wait was interrupted before asset broadcast',
        });
      }
    }
  }

  private async confirmBroadcastedTransfers(): Promise<void> {
    const transfers = await this.prisma.treasuryTransfer.findMany({
      where: { status: TreasuryTransferStatus.BROADCASTED, txHash: { not: null } },
      include: { sourceAccount: true, destinationAccount: true, asset: true },
      take: 20,
    });
    for (const transfer of transfers) {
      try {
        await this.confirmTransfer(transfer);
      } catch (error) {
        this.logger.warn(
          `Treasury transfer ${transfer.id} confirmation deferred: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  private async confirmTransfer(transfer: {
    id: string;
    txHash: string | null;
    amount: Prisma.Decimal;
    assetId: string;
    sourceAccount: { address: string; network: Chain };
    destinationAccount: { address: string };
    asset: { decimals: number };
  }): Promise<void> {
    if (!transfer.txHash) return;
    const network = await this.prisma.network.findFirst({
      where: { legacyChain: transfer.sourceAccount.network },
    });
    if (!network) {
      throw new ServiceUnavailableException('Treasury transfer network is not configured');
    }
    const tokenContract =
      (await this.prisma.tokenContract.findUnique({
        where: {
          assetId_networkId_standard: {
            assetId: transfer.assetId,
            networkId: network.id,
            standard: TokenStandard.NATIVE,
          },
        },
      })) ??
      (await this.prisma.tokenContract.findUnique({
        where: {
          assetId_networkId_standard: {
            assetId: transfer.assetId,
            networkId: network.id,
            standard: TokenStandard.ERC20,
          },
        },
      }));
    if (!tokenContract) {
      throw new ServiceUnavailableException('Treasury transfer token contract is not configured');
    }

    const transaction = await this.rpcProvider.getTransaction(
      transfer.txHash,
      network.chainKey,
    );
    if (!transaction.blockNumber) return;
    if (transaction.status === 0) {
      await this.prisma.treasuryTransfer.update({
        where: { id: transfer.id },
        data: {
          status: TreasuryTransferStatus.FAILED,
          failureReason: 'Treasury transfer transaction reverted',
        },
      });
      return;
    }
    const latest = await this.rpcProvider.getLatestBlockNumber(network.chainKey);
    const confirmations = latest - transaction.blockNumber + 1;
    if (confirmations < this.config.get<number>('WITHDRAWAL_CONFIRMATIONS', 12)) return;

    const rawAmount = parseUnits(transfer.amount.toString(), tokenContract.decimals);
    const matched = tokenContract.standard === TokenStandard.NATIVE
      ? Boolean(
          transaction.to &&
          transaction.to.toLowerCase() === transfer.destinationAccount.address.toLowerCase() &&
          BigInt(transaction.value ?? '0') === rawAmount,
        )
      : (transaction.logs ?? []).some((log) => {
          if (log.address.toLowerCase() !== tokenContract.address!.toLowerCase()) return false;
          try {
            const parsed = decodeEventLog({
              abi: [TRANSFER_EVENT],
              topics: log.topics as [Hex, ...Hex[]],
              data: log.data as Hex,
            });
            const args = parsed.args as { from: Address; to: Address; value: bigint };
            return (
              args.from.toLowerCase() === transfer.sourceAccount.address.toLowerCase() &&
              args.to.toLowerCase() === transfer.destinationAccount.address.toLowerCase() &&
              args.value === rawAmount
            );
          } catch (_error) {
            return false;
          }
        });
    if (!matched) {
      await this.prisma.treasuryTransfer.update({
        where: { id: transfer.id },
        data: {
          status: TreasuryTransferStatus.FAILED,
          failureReason:
            tokenContract.standard === TokenStandard.NATIVE
              ? 'Treasury native transfer mismatch'
              : 'Treasury transfer receipt Transfer log mismatch',
        },
      });
      return;
    }

    await this.prisma.treasuryTransfer.update({
      where: { id: transfer.id },
      data: {
        status: TreasuryTransferStatus.CONFIRMED,
        confirmedAt: new Date(),
        failureReason: null,
      },
    });
    await this.audit.record({
      action: 'TREASURY_REBALANCE_CONFIRMED',
      entityType: 'TreasuryTransfer',
      entityId: transfer.id,
      metadata: { txHash: transfer.txHash, confirmations },
    });
  }
}
