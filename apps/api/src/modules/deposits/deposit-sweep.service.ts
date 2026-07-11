import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  Chain,
  CustodyProvider,
  DepositStatus,
  DepositSweepStatus,
  NetworkFamily,
  TokenStandard,
  Prisma,
} from '@prisma/client';
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
import { OnchainReadinessService } from '../onchain/onchain-readiness.service';
import { RPC_PROVIDER } from '../rpc/rpc.module';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { PrivyCustodyService } from '../treasury/privy-custody.service';
import { DepositsService } from './deposits.service';
import { AuditService } from '../audit/audit.service';

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const SOLANA_NETWORK_KEY = 'solana';
const TRON_NETWORK_KEY = 'tron';

@Injectable()
export class DepositSweepService {
  private readonly logger = new Logger(DepositSweepService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly custody: PrivyCustodyService,
    private readonly deposits: DepositsService,
    private readonly readiness: OnchainReadinessService,
    private readonly audit: AuditService,
    @Inject(RPC_PROVIDER) private readonly rpc: RpcProvider,
  ) {}

  @Cron('*/10 * * * * *')
  async run(): Promise<void> {
    if (this.running || !this.config.get<boolean>('DEPOSIT_SWEEP_ENABLED', false)) {
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } finally {
      this.running = false;
    }
  }

  async runOnce(): Promise<void> {
    if (!this.config.get<boolean>('DEPOSIT_SWEEP_ENABLED', false)) {
      return;
    }
    await this.requeueRecoverableBlockedSweeps();
    await this.backfillDepositAddressLinks();
    await this.createPendingSweeps();
    const maxAttempts = this.config.get<number>('DEPOSIT_SWEEP_MAX_ATTEMPTS', 20);
    await this.prisma.depositSweep.updateMany({
      where: {
        status: {
          in: [
            DepositSweepStatus.PENDING,
            DepositSweepStatus.FUNDING_GAS,
            DepositSweepStatus.BROADCASTING,
          ],
        },
        attempts: { gte: maxAttempts },
      },
      data: {
        status: DepositSweepStatus.BLOCKED,
        failureReason: 'Sweep retry limit reached; manual reconciliation required',
      },
    });
    const sweeps = await this.prisma.depositSweep.findMany({
      where: {
        status: {
          in: [
            DepositSweepStatus.PENDING,
            DepositSweepStatus.FUNDING_GAS,
            DepositSweepStatus.BROADCASTING,
            DepositSweepStatus.BROADCASTED,
          ],
        },
        attempts: { lt: maxAttempts },
      },
      include: { depositAddress: true, asset: true },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
    for (const sweep of sweeps) {
      await this.processSweep(sweep).catch((error) => {
        this.logger.warn(
          `Sweep ${sweep.id} deferred: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
    }
  }

  private async requeueRecoverableBlockedSweeps(): Promise<void> {
    const legacyEvmOnlyBlocked = await this.prisma.depositSweep.findMany({
      where: {
        status: DepositSweepStatus.BLOCKED,
        failureReason: {
          startsWith: 'Automated deposit sweep supports EVM Privy deposit wallets only',
        },
        depositAddress: {
          provider: CustodyProvider.PRIVY,
          providerWalletRef: { not: null },
        },
      },
      include: { depositAddress: true },
      take: 50,
    });
    for (const sweep of legacyEvmOnlyBlocked) {
      if (await this.isPrivySweepEligible(sweep.depositAddress)) {
        await this.prisma.depositSweep.update({
          where: { id: sweep.id },
          data: {
            status: DepositSweepStatus.PENDING,
            failureReason: null,
          },
        });
      }
    }
  }

  private async backfillDepositAddressLinks(): Promise<void> {
    const deposits = await this.prisma.deposit.findMany({
      where: {
        status: DepositStatus.CREDITED,
        depositAddressId: null,
      },
      select: { id: true, toAddress: true, network: true },
      take: 200,
    });
    for (const deposit of deposits) {
      const network = await this.prisma.network.findFirst({
        where: { legacyChain: deposit.network },
        select: { family: true },
      });
      const addressMatch =
        network?.family === NetworkFamily.EVM
          ? deposit.toAddress.toLowerCase()
          : deposit.toAddress;
      const depositAddress = await this.prisma.userDepositAddress.findFirst({
        where: {
          address: addressMatch,
          network: deposit.network,
          status: 'ACTIVE',
        },
      });
      if (!depositAddress) {
        continue;
      }
      await this.prisma.deposit.update({
        where: { id: deposit.id },
        data: { depositAddressId: depositAddress.id },
      });
    }
  }

  listAdmin(status?: DepositSweepStatus, take = 100) {
    return this.prisma.depositSweep.findMany({
      where: status ? { status } : undefined,
      include: {
        asset: true,
        depositAddress: {
          include: { user: { select: { id: true, email: true } } },
        },
        deposits: { select: { id: true, txHash: true, amount: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 200),
    });
  }

  async handlePrivyWebhook(eventId: string, payload: Record<string, unknown>) {
    const referenceId =
      typeof payload.reference_id === 'string' ? payload.reference_id : undefined;
    const match = referenceId?.match(/^deposit-sweep(?:-gas)?:([^:]+)(?::a\d+)?$/);
    if (!match) {
      return { accepted: true, ignored: true };
    }
    const eventType = String(payload.type ?? '');
    const transactionId =
      typeof payload.transaction_id === 'string' ? payload.transaction_id : undefined;
    const txHash =
      typeof payload.transaction_hash === 'string'
        ? payload.transaction_hash.toLowerCase()
        : undefined;
    const walletId = typeof payload.wallet_id === 'string' ? payload.wallet_id : undefined;
    const caip2 = typeof payload.caip2 === 'string' ? payload.caip2 : undefined;
    const failed = [
      'transaction.execution_reverted',
      'transaction.failed',
      'transaction.provider_error',
    ].includes(eventType);
    try {
      await this.prisma.$transaction(async (tx) => {
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
        const sweep = await tx.depositSweep.findUniqueOrThrow({
          where: { id: match[1] },
          include: { depositAddress: true },
        });
        const gasEvent = referenceId!.startsWith('deposit-sweep-gas:');
        const expectedWalletId = gasEvent
          ? this.config.get<string>('PRIVY_SWEEP_GAS_WALLET_ID')
          : sweep.depositAddress.providerWalletRef;
        const network = await tx.network.findFirst({
          where: { legacyChain: sweep.depositAddress.network },
        });
        const expectedCaip2 = network?.chainId ? `eip155:${network.chainId}` : undefined;
        if (!expectedWalletId || walletId !== expectedWalletId || caip2 !== expectedCaip2) {
          throw new BadRequestException('Privy sweep webhook wallet or chain mismatch');
        }
        await tx.depositSweep.update({
          where: { id: sweep.id },
          data: gasEvent
            ? {
                gasFundingProviderRequestId:
                  transactionId ?? sweep.gasFundingProviderRequestId,
                gasFundingTxHash: txHash ?? sweep.gasFundingTxHash,
                status: failed ? DepositSweepStatus.BLOCKED : sweep.status,
                failureReason: failed ? eventType : sweep.failureReason,
              }
            : {
                providerRequestId: transactionId ?? sweep.providerRequestId,
                txHash: txHash ?? sweep.txHash,
                status: failed
                  ? DepositSweepStatus.BLOCKED
                  : txHash
                    ? DepositSweepStatus.BROADCASTED
                    : sweep.status,
                failureReason: failed ? eventType : sweep.failureReason,
                broadcastedAt: txHash ? sweep.broadcastedAt ?? new Date() : undefined,
              },
        });
        await tx.providerWebhookEvent.update({
          where: { id: eventId },
          data: { processedAt: new Date() },
        });
      });
      return { accepted: true, ignored: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { accepted: true, duplicate: true };
      }
      throw error;
    }
  }

  private async createPendingSweeps(): Promise<void> {
    const deposits = await this.prisma.deposit.findMany({
      where: {
        status: DepositStatus.CREDITED,
        depositAddressId: { not: null },
        sweepId: null,
        depositAddress: { provider: CustodyProvider.PRIVY },
      },
      include: { asset: true, tokenContract: true, depositAddress: true },
      orderBy: { creditedAt: 'asc' },
      take: 500,
    });
    const groups = new Map<string, typeof deposits>();
    for (const deposit of deposits) {
      const key = `${deposit.depositAddressId}:${deposit.tokenContractId ?? deposit.assetId}`;
      groups.set(key, [...(groups.get(key) ?? []), deposit]);
    }

    for (const group of groups.values()) {
      const first = group[0];
      if (!first?.depositAddressId || !first.depositAddress) continue;
      if (!(await this.isPrivySweepEligible(first.depositAddress))) continue;
      try {
        await this.prisma.$transaction(async (tx) => {
          const eligible = await tx.deposit.findMany({
            where: {
              id: { in: group.map((deposit) => deposit.id) },
              status: DepositStatus.CREDITED,
              sweepId: null,
            },
          });
          if (eligible.length === 0) return;
          const amount = eligible.reduce(
            (sum, deposit) => sum.add(deposit.amount),
            new Prisma.Decimal(0),
          );
          const sweep = await tx.depositSweep.create({
            data: {
              depositAddressId: first.depositAddressId!,
              assetId: first.assetId,
              amount,
              rawAmount: parseUnits(
                amount.toString(),
                first.tokenContract?.decimals ?? first.asset.decimals,
              ).toString(),
            },
          });
          await tx.deposit.updateMany({
            where: { id: { in: eligible.map((deposit) => deposit.id) }, sweepId: null },
            data: { sweepId: sweep.id },
          });
          await this.audit.record({
            action: 'DEPOSIT_SWEEP_CREATED',
            entityType: 'DepositSweep',
            entityId: sweep.id,
            metadata: {
              depositAddressId: first.depositAddressId!,
              assetId: first.assetId,
              amount: amount.toString(),
              depositCount: eligible.length,
            },
          }, tx);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }
      }
    }
  }

  private async processSweep(sweep: {
    id: string;
    status: DepositSweepStatus;
    rawAmount: string;
    attempts: number;
    txHash: string | null;
    gasFundingTxHash: string | null;
    providerRequestId?: string | null;
    assetId: string;
    depositAddress: {
      address: string;
      network: Chain;
      provider: CustodyProvider;
      providerWalletRef: string | null;
    };
    asset: {
      tokenAddress: string | null;
      contractVerifiedAt: Date | null;
      contractCodeHash: string | null;
      verifiedChainId: number | null;
    };
  }): Promise<void> {
    const sweepFamily = await this.getDepositAddressFamily(sweep.depositAddress.network);
    if (sweepFamily === NetworkFamily.SVM) {
      await this.processSolanaSweep(sweep);
      return;
    }
    if (sweepFamily === NetworkFamily.TVM) {
      await this.processTronSweep(sweep);
      return;
    }
    if (!(await this.isPrivySweepEligible(sweep.depositAddress))) {
      await this.block(
        sweep.id,
        'Automated deposit sweep supports EVM Privy deposit wallets only',
      );
      return;
    }
    const target = await this.getSweepTarget(sweep.assetId, sweep.depositAddress.network);
    if (!target || !sweep.depositAddress.providerWalletRef) {
      await this.block(sweep.id, 'Deposit wallet or token configuration is incomplete');
      return;
    }
    const isNative = target.tokenContract.standard === TokenStandard.NATIVE;
    if (isNative) {
      if (!this.custody.isDepositProvisioningEnabled()) {
        await this.block(sweep.id, 'Privy personal deposit wallets are disabled');
        return;
      }
    } else {
      const sweepReady = await this.assertWorkerReadyOrBlock(
        sweep.id,
        'sweep',
        target.network.chainKey,
      );
      if (!sweepReady) return;
    }
    const depositReady = await this.assertWorkerReadyOrBlock(
      sweep.id,
      'deposit',
      target.network.chainKey,
    );
    if (!depositReady) return;
    if (!target.network.chainId) {
      await this.block(sweep.id, 'Sweep network is missing chain ID');
      return;
    }
    if (sweep.status === DepositSweepStatus.BROADCASTED) {
      await this.confirmSweep(sweep);
      return;
    }
    if (sweep.status === DepositSweepStatus.BROADCASTING) {
      if (!sweep.providerRequestId) {
        await this.block(
          sweep.id,
          'Ambiguous broadcast without provider transaction ID; manual reconciliation required',
        );
        return;
      }
      const provider = await this.custody.getTransaction(sweep.providerRequestId);
      if (provider.txHash) {
        await this.prisma.depositSweep.update({
          where: { id: sweep.id },
          data: {
            status: DepositSweepStatus.BROADCASTED,
            txHash: provider.txHash,
            broadcastedAt: new Date(),
          },
        });
      } else if (['failed', 'execution_reverted', 'provider_error'].includes(provider.status)) {
        await this.block(sweep.id, `Privy transaction ${provider.status}`);
      }
      return;
    }

    const requiredGas = BigInt(this.config.get<string>('SWEEP_GAS_TOPUP_WEI', '0'));
    const nativeBalance = BigInt(
      (await this.rpc.getBalance(sweep.depositAddress.address, undefined, target.network.chainKey)).value,
    );
    if (!isNative && nativeBalance < requiredGas) {
      if (sweep.status === DepositSweepStatus.FUNDING_GAS) {
        const funded = await this.waitForGasFunding(sweep, target.network.chainKey, requiredGas);
        if (!funded) {
          const currentNativeBalance = BigInt(
            (
              await this.rpc.getBalance(
                sweep.depositAddress.address,
                undefined,
                target.network.chainKey,
              )
            ).value,
          );
          if (currentNativeBalance > 0n && currentNativeBalance < requiredGas) {
            await this.sendSweepGasTopup(
              sweep,
              target,
              requiredGas,
              currentNativeBalance,
            );
          }
          return;
        }
      } else {
        await this.sendSweepGasTopup(sweep, target, requiredGas, nativeBalance);
        return;
      }
    }

    const refreshedNativeBalance = !isNative
      ? BigInt(
          (await this.rpc.getBalance(
            sweep.depositAddress.address,
            undefined,
            target.network.chainKey,
          )).value,
        )
      : nativeBalance;
    if (!isNative && refreshedNativeBalance < requiredGas) {
      return;
    }

    const broadcasting = await this.prisma.depositSweep.update({
      where: { id: sweep.id },
      data: {
        status: DepositSweepStatus.BROADCASTING,
        attempts: { increment: 1 },
        startedAt: new Date(),
      },
    });
    const sweepReferenceId = this.buildSweepReferenceId('sweep', sweep.id, broadcasting.attempts);
    try {
      const treasury = await this.deposits.getActiveTreasuryAddress(sweep.depositAddress.network);
      const gasReserve = BigInt(
        this.config.get<string>('SWEEP_NATIVE_GAS_RESERVE_WEI', '100000000000000'),
      );
      const nativeSendValue = isNative
        ? (() => {
            const desired = BigInt(sweep.rawAmount);
            const available = nativeBalance > gasReserve ? nativeBalance - gasReserve : 0n;
            return desired <= available ? desired : available;
          })()
        : 0n;
      if (isNative && nativeSendValue <= 0n) {
        await this.block(sweep.id, 'Native deposit balance is insufficient after gas reserve');
        return;
      }
      let tokenSendValue = BigInt(sweep.rawAmount);
      if (!isNative) {
        const onChainBalance = parseUnits(
          (
            await this.rpc.getBalance(
              sweep.depositAddress.address,
              target.tokenContract.address!,
              target.network.chainKey,
              target.tokenContract.decimals,
            )
          ).value,
          target.tokenContract.decimals,
        );
        if (onChainBalance <= 0n) {
          await this.block(sweep.id, 'Token balance is zero; manual deposit reconciliation required');
          return;
        }
        if (onChainBalance < tokenSendValue) {
          tokenSendValue = onChainBalance;
          await this.prisma.depositSweep.update({
            where: { id: sweep.id },
            data: {
              rawAmount: tokenSendValue.toString(),
              amount: formatUnits(tokenSendValue, target.tokenContract.decimals),
            },
          });
        }
      }
      const result = isNative
        ? await this.custody.sendNativeFromWallet({
            walletId: sweep.depositAddress.providerWalletRef,
            recipient: treasury,
            value: nativeSendValue,
            referenceId: sweepReferenceId,
            chainId: target.network.chainId,
          })
        : await this.custody.sendErc20FromWallet({
            walletId: sweep.depositAddress.providerWalletRef,
            tokenAddress: getAddress(target.tokenContract.address!),
            recipient: treasury,
            rawAmount: tokenSendValue,
            referenceId: sweepReferenceId,
            chainId: target.network.chainId,
          });
      await this.prisma.depositSweep.update({
        where: { id: sweep.id },
        data: {
          status: DepositSweepStatus.BROADCASTED,
          txHash: result.txHash,
          providerRequestId: result.providerRequestId,
          broadcastedAt: new Date(),
        },
      });
      await this.audit.record({
        action: 'DEPOSIT_SWEEP_BROADCASTED',
        entityType: 'DepositSweep',
        entityId: sweep.id,
        metadata: {
          txHash: result.txHash,
          providerRequestId: result.providerRequestId,
        },
      });
    } catch (error) {
      await this.block(
        sweep.id,
        `Ambiguous Privy result; manual reconciliation required: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async confirmSweep(sweep: {
    id: string;
    rawAmount: string;
    txHash: string | null;
    assetId: string;
    depositAddress: { address: string; network: Chain };
    asset: { tokenAddress: string | null };
  }): Promise<void> {
    const target = await this.getSweepTarget(sweep.assetId, sweep.depositAddress.network);
    if (!sweep.txHash || !target) return;
    const transaction = await this.rpc.getTransaction(sweep.txHash, target.network.chainKey);
    if (!transaction.blockNumber) return;
    if (transaction.status === 0) {
      await this.block(sweep.id, 'Sweep transaction reverted');
      return;
    }
    const latest = await this.rpc.getLatestBlockNumber(target.network.chainKey);
    const confirmations = latest - transaction.blockNumber + 1;
    if (confirmations < target.network.confirmations) return;
    const treasury = await this.deposits.getActiveTreasuryAddress(sweep.depositAddress.network);
    const isNative = target.tokenContract.standard === TokenStandard.NATIVE;
    const matched = isNative
      ? Boolean(
          transaction.to &&
            getAddress(transaction.to).toLowerCase() === treasury.toLowerCase() &&
            BigInt(transaction.value ?? '0') > 0n,
        )
      : this.matchesErc20SweepReceipt({
          transaction,
          tokenAddress: target.tokenContract.address,
          fromAddress: sweep.depositAddress.address,
          treasury,
          rawAmount: sweep.rawAmount,
        });
    if (!matched) {
      await this.block(
        sweep.id,
        isNative ? 'Sweep native transfer mismatch' : 'Sweep receipt Transfer log mismatch',
      );
      return;
    }
    await this.prisma.depositSweep.update({
      where: { id: sweep.id },
      data: {
        status: DepositSweepStatus.CONFIRMED,
        confirmedAt: new Date(),
        failureReason: null,
      },
    });
    await this.audit.record({
      action: 'DEPOSIT_SWEEP_CONFIRMED',
      entityType: 'DepositSweep',
      entityId: sweep.id,
      metadata: { txHash: sweep.txHash, rawAmount: sweep.rawAmount },
    });
  }

  private matchesErc20SweepReceipt(input: {
    transaction: { logs?: Array<{ address: string; topics: string[]; data: string }> };
    tokenAddress: string | null;
    fromAddress: string;
    treasury: string;
    rawAmount: string;
  }): boolean {
    if (!input.tokenAddress) {
      return false;
    }
    return (input.transaction.logs ?? []).some((log) => {
      if (log.address.toLowerCase() !== input.tokenAddress!.toLowerCase()) return false;
      try {
        const parsed = decodeEventLog({
          abi: [TRANSFER_EVENT],
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data as Hex,
        });
        const args = parsed.args as { from: Address; to: Address; value: bigint };
        return (
          args.from.toLowerCase() === input.fromAddress.toLowerCase() &&
          args.to.toLowerCase() === input.treasury.toLowerCase() &&
          args.value.toString() === input.rawAmount
        );
      } catch (_error) {
        return false;
      }
    });
  }

  private async isPrivySweepEligible(depositAddress: {
    network: Chain;
    provider: CustodyProvider;
  }): Promise<boolean> {
    if (depositAddress.provider !== CustodyProvider.PRIVY) {
      return false;
    }
    const network = await this.prisma.network.findFirst({
      where: { legacyChain: depositAddress.network },
      select: { family: true, mainnet: true },
    });
    const supported = network?.family === NetworkFamily.EVM ||
      network?.family === NetworkFamily.SVM ||
      network?.family === NetworkFamily.TVM;
    return Boolean(
      supported &&
      (this.config.get<string>('NODE_ENV', 'development') !== 'production' || network?.mainnet),
    );
  }

  private async processTronSweep(sweep: {
    id: string;
    status: DepositSweepStatus;
    rawAmount: string;
    txHash: string | null;
    gasFundingTxHash: string | null;
    providerRequestId?: string | null;
    assetId: string;
    depositAddress: {
      address: string;
      network: Chain;
      provider: CustodyProvider;
      providerWalletRef: string | null;
    };
  }): Promise<void> {
    if (!sweep.depositAddress.providerWalletRef || !this.custody.isTronEnabled()) {
      await this.block(sweep.id, 'Privy Tron deposit wallet is not configured');
      return;
    }
    const target = await this.getSweepTarget(sweep.assetId, sweep.depositAddress.network);
    if (!target) {
      await this.block(sweep.id, 'Tron sweep token configuration is incomplete');
      return;
    }
    const treasuryWalletId = this.config.getOrThrow<string>('PRIVY_TRON_WALLET_ID');
    const treasuryAddress = await this.custody.getWalletAddress(treasuryWalletId);
    const isNative = target.tokenContract.standard === TokenStandard.NATIVE;
    const isTrc20 = target.tokenContract.standard === TokenStandard.TRC20;
    if (!isNative && !isTrc20) {
      await this.block(sweep.id, 'Only native TRX and TRC20 Privy sweeps are enabled');
      return;
    }
    let amount = BigInt(sweep.rawAmount);
    const source = sweep.depositAddress.address;

    if (isTrc20) {
      const onChainBalance = await this.getTronTrc20BalanceRaw(
        source,
        target.tokenContract.address!,
      );
      if (onChainBalance <= 0n) {
        await this.block(sweep.id, 'TRC20 balance is zero; manual deposit reconciliation required');
        return;
      }
      if (onChainBalance < amount) {
        amount = onChainBalance;
        await this.prisma.depositSweep.update({
          where: { id: sweep.id },
          data: {
            rawAmount: amount.toString(),
            amount: formatUnits(amount, target.tokenContract.decimals),
          },
        });
      }
    }

    if (sweep.status === DepositSweepStatus.BROADCASTED && sweep.txHash) {
      const confirmed = await this.confirmTronSweepTransaction(sweep.txHash);
      if (!confirmed.success) {
        if (confirmed.failed) {
          await this.block(sweep.id, 'Tron sweep transaction failed on-chain');
        }
        return;
      }
      await this.prisma.depositSweep.update({
        where: { id: sweep.id },
        data: { status: DepositSweepStatus.CONFIRMED, confirmedAt: new Date(), failureReason: null },
      });
      await this.audit.record({
        action: 'DEPOSIT_SWEEP_CONFIRMED',
        entityType: 'DepositSweep',
        entityId: sweep.id,
        metadata: { txHash: sweep.txHash, rawAmount: sweep.rawAmount, network: TRON_NETWORK_KEY },
      });
      return;
    }

    const feeReserveSun = BigInt(this.config.get<string>('TRON_SWEEP_FEE_RESERVE_SUN', '1000000'));
    const nativeBalance = await this.getTronNativeBalanceSun(source);
    const needsTrxTopUp = isTrc20
      ? nativeBalance < feeReserveSun
      : nativeBalance < amount + feeReserveSun;

    if (needsTrxTopUp) {
      if (sweep.status === DepositSweepStatus.FUNDING_GAS && sweep.gasFundingTxHash) {
        const funded = await this.confirmTronSweepTransaction(sweep.gasFundingTxHash);
        if (!funded.success) {
          if (funded.failed) {
            await this.block(sweep.id, 'Tron sweep gas funding failed on-chain');
          }
          return;
        }
        await this.prisma.depositSweep.update({
          where: { id: sweep.id },
          data: { status: DepositSweepStatus.PENDING, failureReason: null },
        });
        return;
      }
      const topup = isTrc20
        ? Number(feeReserveSun - nativeBalance)
        : Number(amount + feeReserveSun - nativeBalance);
      const attempt = await this.reserveSweepAttempt(sweep.id);
      const referenceId = this.buildSweepReferenceId('gas', sweep.id, attempt);
      const sent = await this.custody.sendTronNativeTransfer({
        walletId: treasuryWalletId,
        fromAddress: treasuryAddress,
        toAddress: source,
        amountSun: topup,
        referenceId,
        mainnet: true,
      });
      await this.prisma.depositSweep.update({
        where: { id: sweep.id },
        data: {
          status: DepositSweepStatus.FUNDING_GAS,
          gasFundingTxHash: sent.txHash,
          gasFundingProviderRequestId: sent.providerRequestId,
          attempts: { increment: 1 },
          startedAt: new Date(),
        },
      });
      return;
    }

    const broadcasting = await this.prisma.depositSweep.update({
      where: { id: sweep.id },
      data: { status: DepositSweepStatus.BROADCASTING, attempts: { increment: 1 }, startedAt: new Date() },
    });
    const referenceId = this.buildSweepReferenceId('sweep', sweep.id, broadcasting.attempts);
    const sent = isNative
      ? await this.custody.sendTronNativeTransfer({
          walletId: sweep.depositAddress.providerWalletRef,
          fromAddress: source,
          toAddress: treasuryAddress,
          amountSun: Number(amount),
          referenceId,
          mainnet: true,
        })
      : await this.custody.sendTronTrc20Transfer({
          walletId: sweep.depositAddress.providerWalletRef,
          fromAddress: source,
          toAddress: treasuryAddress,
          contractAddress: target.tokenContract.address!,
          rawAmount: amount,
          referenceId,
          mainnet: true,
        });
    await this.prisma.depositSweep.update({
      where: { id: sweep.id },
      data: {
        status: DepositSweepStatus.BROADCASTED,
        txHash: sent.txHash,
        providerRequestId: sent.providerRequestId,
        broadcastedAt: new Date(),
      },
    });
  }

  private async getTronNativeBalanceSun(address: string): Promise<bigint> {
    const rpcUrl = this.config.get<string>('TRON_RPC_PRIMARY_URL', '').replace(/\/$/, '');
    if (!rpcUrl) {
      throw new ServiceUnavailableException('TRON_RPC_PRIMARY_URL is not configured');
    }
    const response = await fetch(`${rpcUrl}/wallet/getaccount`, {
      method: 'POST',
      headers: this.tronApiHeaders(),
      body: JSON.stringify({ address, visible: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new ServiceUnavailableException(`TRON API request failed: ${response.status}`);
    }
    const body = await response.json() as { balance?: number };
    return BigInt(body.balance ?? 0);
  }

  private async getTronTrc20BalanceRaw(
    address: string,
    contractAddress: string,
  ): Promise<bigint> {
    const fullHost = this.config.get<string>('TRON_RPC_PRIMARY_URL', '').trim();
    if (!fullHost) {
      throw new ServiceUnavailableException('TRON_RPC_PRIMARY_URL is not configured');
    }
    const tronModule = await import('tronweb');
    const TronWebCtor = (tronModule as any).TronWeb ?? (tronModule as any).default;
    const apiKey = this.config.get<string>('TRON_PRO_API_KEY', '').trim();
    const tronWeb = new TronWebCtor({
      fullHost,
      ...(apiKey ? { headers: { 'TRON-PRO-API-KEY': apiKey } } : {}),
    });
    tronWeb.setAddress(address);
    const contract = await tronWeb.contract().at(contractAddress);
    return BigInt(String(await contract.balanceOf(address).call({ from: address })));
  }

  private async confirmTronSweepTransaction(
    txHash: string,
  ): Promise<{ success: boolean; failed: boolean }> {
    const rpcUrl = this.config.get<string>('TRON_RPC_PRIMARY_URL', '').replace(/\/$/, '');
    if (!rpcUrl) {
      return { success: false, failed: false };
    }
    const response = await fetch(`${rpcUrl}/wallet/gettransactioninfobyid`, {
      method: 'POST',
      headers: this.tronApiHeaders(),
      body: JSON.stringify({ value: txHash }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new ServiceUnavailableException(`TRON API request failed: ${response.status}`);
    }
    const body = await response.json() as { id?: string; receipt?: { result?: string } };
    if (!body.id) {
      return { success: false, failed: false };
    }
    if (body.receipt?.result === 'REVERT') {
      return { success: false, failed: true };
    }
    return { success: body.receipt?.result === 'SUCCESS', failed: false };
  }

  private async getDepositAddressFamily(network: Chain): Promise<NetworkFamily | null> {
    const configured = await this.prisma.network.findFirst({
      where: { legacyChain: network },
      select: { family: true },
    });
    return configured?.family ?? null;
  }

  private tronApiHeaders(): Record<string, string> {
    const apiKey = this.config.get<string>('TRON_PRO_API_KEY', '').trim();
    return {
      'content-type': 'application/json',
      ...(apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}),
    };
  }

  private async processSolanaSweep(sweep: {
    id: string;
    status: DepositSweepStatus;
    rawAmount: string;
    txHash: string | null;
    gasFundingTxHash: string | null;
    providerRequestId?: string | null;
    assetId: string;
    depositAddress: {
      address: string;
      network: Chain;
      provider: CustodyProvider;
      providerWalletRef: string | null;
    };
  }): Promise<void> {
    if (!sweep.depositAddress.providerWalletRef || !this.custody.isSolanaEnabled()) {
      await this.block(sweep.id, 'Privy Solana deposit wallet is not configured');
      return;
    }
    const target = await this.getSweepTarget(sweep.assetId, sweep.depositAddress.network);
    if (!target || target.tokenContract.standard !== TokenStandard.NATIVE) {
      await this.block(sweep.id, 'Only native SOL Privy sweeps are enabled');
      return;
    }
    const rpcUrl = this.config.get<string>('SOLANA_RPC_PRIMARY_URL');
    if (!rpcUrl) {
      await this.block(sweep.id, 'SOLANA_RPC_PRIMARY_URL is not configured');
      return;
    }
    const { Connection, PublicKey, SystemProgram, Transaction } = await import('@solana/web3.js');
    const connection = new Connection(rpcUrl, 'confirmed');
    const source = new PublicKey(sweep.depositAddress.address);
    const treasuryWalletId = this.config.getOrThrow<string>('PRIVY_SOLANA_WALLET_ID');
    const treasuryAddress = await this.custody.getWalletAddress(treasuryWalletId);
    const treasury = new PublicKey(treasuryAddress);
    const amount = BigInt(sweep.rawAmount);

    if (sweep.status === DepositSweepStatus.BROADCASTING) {
      if (!sweep.providerRequestId) {
        await this.block(
          sweep.id,
          'Ambiguous Solana broadcast without provider transaction ID; manual reconciliation required',
        );
        return;
      }
      const provider = await this.custody.getTransaction(sweep.providerRequestId);
      if (provider.txHash) {
        await this.prisma.depositSweep.update({
          where: { id: sweep.id },
          data: {
            status: DepositSweepStatus.BROADCASTED,
            txHash: provider.txHash,
            broadcastedAt: new Date(),
          },
        });
      } else if (['failed', 'execution_reverted', 'provider_error'].includes(provider.status)) {
        await this.block(sweep.id, `Privy transaction ${provider.status}`);
      }
      return;
    }

    if (sweep.status === DepositSweepStatus.BROADCASTED && sweep.txHash) {
      const tx = await connection.getParsedTransaction(sweep.txHash, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) return;
      const matched = tx.transaction.message.instructions.some((instruction: any) =>
        instruction?.program === 'system' &&
        instruction?.parsed?.type === 'transfer' &&
        instruction.parsed.info?.source === source.toBase58() &&
        instruction.parsed.info?.destination === treasury.toBase58() &&
        BigInt(instruction.parsed.info?.lamports ?? 0) === amount,
      );
      if (!matched) {
        await this.block(sweep.id, 'Solana sweep transfer mismatch');
        return;
      }
      await this.prisma.depositSweep.update({
        where: { id: sweep.id },
        data: { status: DepositSweepStatus.CONFIRMED, confirmedAt: new Date(), failureReason: null },
      });
      await this.audit.record({
        action: 'DEPOSIT_SWEEP_CONFIRMED',
        entityType: 'DepositSweep',
        entityId: sweep.id,
        metadata: { txHash: sweep.txHash, rawAmount: sweep.rawAmount, network: SOLANA_NETWORK_KEY },
      });
      return;
    }

    const feeReserve = BigInt(this.config.get<string>('SOLANA_SWEEP_FEE_RESERVE_LAMPORTS', '10000'));
    const balance = BigInt(await connection.getBalance(source, 'confirmed'));
    if (balance < amount + feeReserve) {
      const topup = amount + feeReserve - balance;
      const funding = new Transaction().add(SystemProgram.transfer({
        fromPubkey: treasury,
        toPubkey: source,
        lamports: Number(topup),
      }));
      funding.feePayer = treasury;
      funding.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      const attempt = await this.reserveSweepAttempt(sweep.id);
      const sent = await this.custody.sendSolanaTransaction({
        walletId: treasuryWalletId,
        transaction: funding.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
        referenceId: this.buildSweepReferenceId('gas', sweep.id, attempt),
        mainnet: true,
      });
      await this.prisma.depositSweep.update({
        where: { id: sweep.id },
        data: {
          status: DepositSweepStatus.FUNDING_GAS,
          gasFundingTxHash: sent.txHash,
          gasFundingProviderRequestId: sent.providerRequestId,
          startedAt: new Date(),
        },
      });
      return;
    }

    const transaction = new Transaction().add(SystemProgram.transfer({
      fromPubkey: source,
      toPubkey: treasury,
      lamports: Number(amount),
    }));
    transaction.feePayer = source;
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    const broadcasting = await this.prisma.depositSweep.update({
      where: { id: sweep.id },
      data: { status: DepositSweepStatus.BROADCASTING, attempts: { increment: 1 }, startedAt: new Date() },
    });
    const sent = await this.custody.sendSolanaTransaction({
      walletId: sweep.depositAddress.providerWalletRef,
      transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      referenceId: this.buildSweepReferenceId('sweep', sweep.id, broadcasting.attempts),
      mainnet: true,
    });
    await this.prisma.depositSweep.update({
      where: { id: sweep.id },
      data: {
        status: DepositSweepStatus.BROADCASTED,
        txHash: sent.txHash,
        providerRequestId: sent.providerRequestId,
        broadcastedAt: new Date(),
      },
    });
  }

  private async assertWorkerReadyOrBlock(
    sweepId: string,
    worker: 'deposit' | 'withdrawal' | 'sweep',
    networkKey: string,
  ): Promise<boolean> {
    try {
      await this.readiness.assertWorkerReady(worker, networkKey);
      return true;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        await this.block(sweepId, error.message);
        return false;
      }
      throw error;
    }
  }

  private buildSweepReferenceId(
    kind: 'gas' | 'sweep',
    sweepId: string,
    attempt: number,
  ): string {
    const prefix = kind === 'gas' ? 'deposit-sweep-gas' : 'deposit-sweep';
    return `${prefix}:${sweepId}:a${attempt}`;
  }

  private async reserveSweepAttempt(sweepId: string): Promise<number> {
    const updated = await this.prisma.depositSweep.update({
      where: { id: sweepId },
      data: { attempts: { increment: 1 } },
    });
    return updated.attempts;
  }

  private async sendSweepGasTopup(
    sweep: {
      id: string;
      depositAddress: { address: string };
    },
    target: {
      network: { chainKey: string; chainId: number | null };
    },
    requiredGas: bigint,
    nativeBalance: bigint,
  ): Promise<void> {
    const maxTopup = BigInt(this.config.get<string>('SWEEP_GAS_MAX_TOPUP_WEI', '0'));
    const topup = requiredGas - nativeBalance;
    if (topup <= 0n || maxTopup <= 0n || topup > maxTopup) {
      await this.block(sweep.id, 'Gas top-up is outside the configured limit');
      return;
    }
    if (!target.network.chainId) {
      await this.block(sweep.id, 'Sweep network is missing chain ID');
      return;
    }
    const attempt = await this.reserveSweepAttempt(sweep.id);
    const referenceId = this.buildSweepReferenceId('gas', sweep.id, attempt);
    try {
      const result = await this.custody.sendNativeFromSweepGas({
        recipient: getAddress(sweep.depositAddress.address),
        value: topup,
        referenceId,
        chainId: target.network.chainId,
      });
      await this.prisma.depositSweep.update({
        where: { id: sweep.id },
        data: {
          status: DepositSweepStatus.FUNDING_GAS,
          gasFundingTxHash: result.txHash,
          gasFundingProviderRequestId: result.providerRequestId,
          startedAt: new Date(),
        },
      });
      await this.audit.record({
        action: 'DEPOSIT_SWEEP_GAS_FUNDED',
        entityType: 'DepositSweep',
        entityId: sweep.id,
        metadata: {
          txHash: result.txHash,
          providerRequestId: result.providerRequestId,
          valueWei: topup.toString(),
          referenceId,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      if (/policy|not allowed|denied|chain_id/i.test(message)) {
        await this.block(
          sweep.id,
          `SWEEP_GAS Privy policy blocked gas top-up on chain ${target.network.chainId}: ${message}`,
        );
        return;
      }
      if (/insufficient funds/i.test(message)) {
        this.logger.warn(
          `Sweep ${sweep.id} gas top-up failed on ${target.network.chainKey}: add native gas to SWEEP_GAS on this chain. ${message}`,
        );
        return;
      }
      throw error;
    }
  }

  private async getSweepTarget(assetId: string, legacyChain: Chain) {
    const network = await this.prisma.network.findFirst({
      where: { legacyChain },
    });
    if (!network) return null;
    const standards =
      network.family === NetworkFamily.TVM
        ? [TokenStandard.NATIVE, TokenStandard.TRC20]
        : [TokenStandard.NATIVE, TokenStandard.ERC20];
    let tokenContract = null;
    for (const standard of standards) {
      tokenContract = await this.prisma.tokenContract.findUnique({
        where: {
          assetId_networkId_standard: {
            assetId,
            networkId: network.id,
            standard,
          },
        },
      });
      if (tokenContract) break;
    }
    if (!tokenContract?.contractVerifiedAt) {
      return null;
    }
    if (
      network.family !== NetworkFamily.TVM &&
      tokenContract.verifiedChainId !== network.chainId
    ) {
      return null;
    }
    if (
      tokenContract.standard === TokenStandard.ERC20 &&
      (!tokenContract.address || !tokenContract.contractCodeHash)
    ) {
      return null;
    }
    if (
      tokenContract.standard === TokenStandard.TRC20 &&
      !tokenContract.address
    ) {
      return null;
    }
    return { network, tokenContract };
  }

  private async waitForGasFunding(
    sweep: {
      id: string;
      gasFundingTxHash: string | null;
      depositAddress: { address: string };
    },
    networkKey: string,
    requiredGas: bigint,
  ): Promise<boolean> {
    if (sweep.gasFundingTxHash) {
      const fundingTx = await this.rpc
        .getTransaction(sweep.gasFundingTxHash, networkKey)
        .catch(() => null);
      if (fundingTx?.status === 0) {
        await this.block(sweep.id, 'Gas funding transaction reverted');
        return false;
      }
    }

    const nativeBalance = BigInt(
      (await this.rpc.getBalance(sweep.depositAddress.address, undefined, networkKey)).value,
    );
    if (nativeBalance >= requiredGas) {
      await this.prisma.depositSweep.update({
        where: { id: sweep.id },
        data: { status: DepositSweepStatus.PENDING, failureReason: null },
      });
      return true;
    }
    return false;
  }

  private async block(id: string, failureReason: string) {
    const blocked = await this.prisma.depositSweep.update({
      where: { id },
      data: {
        status: DepositSweepStatus.BLOCKED,
        failureReason: failureReason.slice(0, 1000),
      },
    });
    await this.audit.record({
      action: 'DEPOSIT_SWEEP_BLOCKED',
      entityType: 'DepositSweep',
      entityId: id,
      reason: failureReason.slice(0, 1000),
    });
    return blocked;
  }
}
