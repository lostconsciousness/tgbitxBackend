import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Asset,
  Chain,
  CustodyAccountRole,
  Network,
  NetworkFamily,
  Prisma,
  TokenContract,
  TokenStandard,
} from '@prisma/client';
import { createHash } from 'crypto';
import { Address, Hex, decodeEventLog, formatUnits, getAddress, parseAbiItem, parseUnits } from 'viem';
import { AssetsService } from '../assets/assets.service';
import { RPC_PROVIDER } from '../rpc/rpc.module';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import type { RpcLog } from '../rpc/rpc-provider.interface';
import { DepositsService } from './deposits.service';
import { PrismaService } from '../../database/prisma.service';
import { OnchainReadinessService } from '../onchain/onchain-readiness.service';
import { NonEvmTestnetAdapterService } from '../onchain/non-evm-testnet-adapter.service';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BALANCE_RECONCILE_LOG_INDEX = 9_999_999;
type TransferArgs = {
  from: Address;
  to: Address;
  value: bigint;
};
type IndexedTokenContract = Prisma.TokenContractGetPayload<{
  include: { asset: true; network: true };
}>;
type Erc20ScanPlan = {
  contract: IndexedTokenContract;
  fromBlock: number;
  toBlock: number;
  latestBlock: number;
  advancesCursor: boolean;
};
type Erc20Target = {
  asset: Asset;
  tokenContract: TokenContract;
  network: Network;
  legacyChain: Chain;
};

@Injectable()
export class DepositIndexerService {
  private readonly logger = new Logger(DepositIndexerService.name);
  private running = false;
  private reconciling = false;
  private balanceReconcileRunning = false;
  private userSyncInFlight = new Map<string, Promise<void>>();
  private readonly lastUserSyncAt = new Map<string, number>();
  private lastEvmFallbackScanAt = 0;
  private readonly latestBlockCache = new Map<
    string,
    { expiresAt: number; value: Promise<number> }
  >();

  constructor(
    private readonly assetsService: AssetsService,
    private readonly depositsService: DepositsService,
    private readonly config: ConfigService,
    @Inject(RPC_PROVIDER) private readonly rpcProvider: RpcProvider,
    private readonly prisma: PrismaService,
    private readonly readiness: OnchainReadinessService,
    private readonly nonEvm: NonEvmTestnetAdapterService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async reconcilePendingDepositsCron(): Promise<void> {
    if (
      this.reconciling ||
      !this.config.get<boolean>('DEPOSIT_INDEXER_ENABLED', false)
    ) {
      return;
    }
    this.reconciling = true;
    try {
      await this.reconcilePendingDeposits();
      await this.depositsService.creditReadyDeposits();
    } catch (error) {
      this.logger.error(
        `Deposit reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.reconciling = false;
    }
  }

  @Cron('0 */5 * * * *')
  async reclassifySweepGasFundingCron(): Promise<void> {
    try {
      const accounts = await this.prisma.custodyAccount.findMany({
        where: { role: CustodyAccountRole.SWEEP_GAS },
        select: { network: true },
      });
      const networks = [...new Set(accounts.map((account) => account.network))];
      for (const network of networks) {
        await this.depositsService.reclassifySweepGasFundingDeposits(network);
      }
      const depositNetworks = await this.prisma.deposit.groupBy({
        by: ['network'],
        where: {
          depositAddressId: { not: null },
          fromAddress: { not: null },
        },
      });
      for (const row of depositNetworks) {
        await this.depositsService.reclassifyInternalDepositAddressTransferDeposits(row.network);
      }
    } catch (error) {
      this.logger.error(
        `Sweep gas funding reclassification failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  @Cron('0 */10 * * * *')
  async reconcilePersonalDepositBalancesCron(): Promise<void> {
    if (
      this.balanceReconcileRunning ||
      !this.config.get<boolean>('DEPOSIT_INDEXER_ENABLED', false) ||
      !this.isBalanceFallbackEnabled()
    ) {
      return;
    }
    this.balanceReconcileRunning = true;
    try {
      const result = await this.reconcileAllPersonalDepositBalances();
      if (result.reconciled > 0) {
        this.logger.log(`Balance reconcile credited ${result.reconciled} deposit(s) from on-chain deltas`);
      }
      await this.depositsService.creditReadyDeposits();
    } catch (error) {
      this.logger.warn(
        `Personal deposit balance reconcile failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      this.balanceReconcileRunning = false;
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async scanConfiguredAssets(): Promise<void> {
    if (this.running || !this.config.get<boolean>('DEPOSIT_INDEXER_ENABLED', false)) {
      return;
    }
    this.running = true;
    try {
      await this.reconcilePendingDeposits();
      const activeDepositNetworks = new Set(
        (
          await this.prisma.userDepositAddress.findMany({
            where: { status: 'ACTIVE' },
            select: { network: true },
          })
        ).map((address) => address.network),
      );
      const contracts = await this.prisma.tokenContract.findMany({
        where: this.depositEnabledContractFilter(),
        include: { asset: true, network: true },
      });
      const scanEvmThisRun = this.shouldRunEvmFallbackScan();
      const evmErc20Contracts = contracts.filter(
        (contract) =>
          contract.network.family === NetworkFamily.EVM &&
          contract.standard === TokenStandard.ERC20,
      );
      const directContracts = contracts.filter(
        (contract) =>
          contract.network.family !== NetworkFamily.EVM ||
          contract.standard !== TokenStandard.ERC20,
      );
      directContracts.sort((left, right) =>
        Number(left.network.family === NetworkFamily.EVM) -
        Number(right.network.family === NetworkFamily.EVM),
      );
      const depositReadinessChecked = new Set<string>();

      for (const contract of directContracts) {
        if (!contract.network.legacyChain || !activeDepositNetworks.has(contract.network.legacyChain)) {
          continue;
        }
        if (contract.network.family === NetworkFamily.EVM && !scanEvmThisRun) {
          continue;
        }
        try {
          const cursorKey = this.cursorKey(contract.network.chainKey, contract.id);
          const cursor = await this.prisma.depositIndexerCursor.findUnique({
            where: { key: cursorKey },
          });
          const stored = Number(cursor?.lastBlock ?? 0);
          if (contract.network.family === NetworkFamily.EVM) {
            await this.assertDepositWorkerReadyOnce(
              depositReadinessChecked,
              contract.network.chainKey,
            );
          } else {
            this.nonEvm.assertSupportedNetwork(contract.network);
          }
          const latest = await this.getLatestBlock(contract.network);
          const fromBlock = this.resolveScanFromBlock({
            stored,
            latest,
            network: contract.network,
            tokenStandard: contract.standard,
          });
          const toBlock =
            contract.network.family === NetworkFamily.EVM
              ? Math.min(
                  latest,
                  fromBlock + this.maxBlocksPerRun(contract.network.chainKey, contract.standard) - 1,
                )
              : latest;
          const recentFromBlock = this.resolveScanFromBlock({
            stored: latest,
            latest,
            network: contract.network,
            tokenStandard: contract.standard,
          });

          // Process the chain tip while an old cursor catches up in bounded chunks.
          // Deposit writes are idempotent, and the historical cursor is not advanced
          // across the gap until that gap has actually been scanned.
          if (
            contract.network.family === NetworkFamily.EVM &&
            toBlock < recentFromBlock
          ) {
            await this.scanDeposits({
              assetSymbol: contract.asset.symbol,
              network: contract.network.chainKey,
              fromBlock: recentFromBlock,
              toBlock: latest,
              latestBlock: latest,
            });
          }
          const result = await this.scanDeposits({
            assetSymbol: contract.asset.symbol,
            network: contract.network.chainKey,
            fromBlock,
            toBlock,
            ...(contract.network.family === NetworkFamily.EVM ? { latestBlock: latest } : {}),
          });
          const lastBlock = BigInt(result.toBlock ?? toBlock);
          await this.prisma.depositIndexerCursor.upsert({
            where: { key: cursorKey },
            update: { lastBlock },
            create: {
              key: cursorKey,
              networkId: contract.networkId,
              tokenContractId: contract.id,
              lastBlock,
            },
          });
        } catch (error) {
          this.logger.warn(
            `Deposit indexer skipped ${contract.asset.symbol} on ${contract.network.chainKey}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        }
      }
      if (scanEvmThisRun) {
        await this.scanConfiguredErc20ContractGroups(
          evmErc20Contracts,
          activeDepositNetworks,
          depositReadinessChecked,
        );
      }
    } catch (error) {
      this.logger.error(
        `Deposit indexer failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async scanConfiguredErc20ContractGroups(
    contracts: IndexedTokenContract[],
    activeDepositNetworks: Set<Chain>,
    depositReadinessChecked: Set<string>,
  ): Promise<void> {
    const byNetwork = new Map<string, IndexedTokenContract[]>();
    for (const contract of contracts) {
      const legacyChain = contract.network.legacyChain;
      if (!legacyChain || !activeDepositNetworks.has(legacyChain)) continue;
      const bucket = byNetwork.get(contract.network.chainKey) ?? [];
      bucket.push(contract);
      byNetwork.set(contract.network.chainKey, bucket);
    }

    for (const networkContracts of byNetwork.values()) {
      const network = networkContracts[0]!.network;
      try {
        await this.assertDepositWorkerReadyOnce(
          depositReadinessChecked,
          network.chainKey,
        );
        const latest = await this.getLatestBlock(network);
        const plans: Erc20ScanPlan[] = [];

        for (const contract of networkContracts) {
          const cursorKey = this.cursorKey(network.chainKey, contract.id);
          const cursor = await this.prisma.depositIndexerCursor.findUnique({
            where: { key: cursorKey },
          });
          const stored = Number(cursor?.lastBlock ?? 0);
          const fromBlock = this.resolveScanFromBlock({
            stored,
            latest,
            network,
            tokenStandard: contract.standard,
          });
          const toBlock = Math.min(
            latest,
            fromBlock + this.maxBlocksPerRun(network.chainKey, contract.standard) - 1,
          );
          const recentFromBlock = this.resolveScanFromBlock({
            stored: latest,
            latest,
            network,
            tokenStandard: contract.standard,
          });
          if (toBlock < recentFromBlock) {
            plans.push({
              contract,
              fromBlock: recentFromBlock,
              toBlock: latest,
              latestBlock: latest,
              advancesCursor: false,
            });
          }
          plans.push({
            contract,
            fromBlock,
            toBlock,
            latestBlock: latest,
            advancesCursor: true,
          });
        }

        const groups = new Map<string, Erc20ScanPlan[]>();
        for (const plan of plans) {
          const key = [
            plan.fromBlock,
            plan.toBlock,
            plan.latestBlock,
            plan.advancesCursor ? 'cursor' : 'tip',
          ].join(':');
          const bucket = groups.get(key) ?? [];
          bucket.push(plan);
          groups.set(key, bucket);
        }

        for (const group of groups.values()) {
          const completed: Erc20ScanPlan[] = [];
          try {
            await this.scanErc20Targets(
              {
                networkKey: network.chainKey,
                fromBlock: group[0]!.fromBlock,
                toBlock: group[0]!.toBlock,
                latestBlock: group[0]!.latestBlock,
              },
              group.map((plan) => this.indexedContractTarget(plan.contract)),
            );
            completed.push(...group);
          } catch (batchError) {
            this.logger.warn(
              `Batched ERC20 deposit scan failed on ${network.chainKey}; falling back to individual contracts: ${
                batchError instanceof Error ? batchError.message : 'unknown error'
              }`,
            );
            for (const plan of group) {
              try {
                await this.scanErc20Deposits(
                  {
                    assetSymbol: plan.contract.asset.symbol,
                    network: network.chainKey,
                    fromBlock: plan.fromBlock,
                    toBlock: plan.toBlock,
                    latestBlock: plan.latestBlock,
                  },
                  this.indexedContractTarget(plan.contract),
                );
                completed.push(plan);
              } catch (error) {
                this.logger.warn(
                  `Deposit indexer skipped ${plan.contract.asset.symbol} on ${network.chainKey}: ${
                    error instanceof Error ? error.message : 'unknown error'
                  }`,
                );
              }
            }
          }

          for (const plan of completed.filter((item) => item.advancesCursor)) {
            const cursorKey = this.cursorKey(network.chainKey, plan.contract.id);
            const lastBlock = BigInt(plan.toBlock);
            await this.prisma.depositIndexerCursor.upsert({
              where: { key: cursorKey },
              update: { lastBlock },
              create: {
                key: cursorKey,
                networkId: plan.contract.networkId,
                tokenContractId: plan.contract.id,
                lastBlock,
              },
            });
          }
        }
      } catch (error) {
        this.logger.warn(
          `Deposit indexer skipped ERC20 batch on ${network.chainKey}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  private indexedContractTarget(contract: IndexedTokenContract): Erc20Target {
    if (!contract.network.legacyChain) {
      throw new BadRequestException('Network is missing legacy storage mapping');
    }
    return {
      asset: contract.asset,
      tokenContract: contract,
      network: contract.network,
      legacyChain: contract.network.legacyChain,
    };
  }

  async reconcilePendingDeposits(): Promise<void> {
    const pending = await this.prisma.deposit.findMany({
      where: {
        status: 'PENDING_CONFIRMATION',
        blockNumber: { not: null },
      },
      include: { asset: true, tokenContract: { include: { network: true } }, intent: true },
      take: 200,
    });
    for (const deposit of pending) {
      try {
        if (!deposit.tokenContract || deposit.blockNumber === null) {
          continue;
        }
        const latestBlock = await this.getLatestBlock(deposit.tokenContract.network);
        if (deposit.tokenContract.standard === TokenStandard.NATIVE) {
          await this.depositsService.recordDetectedDeposit({
            intentId: deposit.intentId ?? undefined,
            depositAddressId: deposit.depositAddressId ?? undefined,
            userId: deposit.userId ?? undefined,
            channel: deposit.channel,
            network: deposit.network,
            tokenContractId: deposit.tokenContractId ?? undefined,
            assetId: deposit.assetId,
            fromAddress: deposit.fromAddress ?? undefined,
            toAddress: deposit.toAddress,
            txHash: deposit.txHash,
            blockNumber: deposit.blockNumber,
            amount: deposit.amount.toString(),
            rawAmount: deposit.rawAmount ?? undefined,
            confirmations: Math.max(0, latestBlock - deposit.blockNumber + 1),
          });
          continue;
        }
        if (deposit.tokenContract.network.family !== NetworkFamily.EVM) {
          await this.depositsService.recordDetectedDeposit({
            intentId: deposit.intentId ?? undefined,
            depositAddressId: deposit.depositAddressId ?? undefined,
            userId: deposit.userId ?? undefined,
            channel: deposit.channel,
            network: deposit.network,
            tokenContractId: deposit.tokenContractId ?? undefined,
            assetId: deposit.assetId,
            fromAddress: deposit.fromAddress ?? undefined,
            toAddress: deposit.toAddress,
            txHash: deposit.txHash,
            logIndex: deposit.logIndex ?? undefined,
            blockNumber: deposit.blockNumber,
            amount: deposit.amount.toString(),
            rawAmount: deposit.rawAmount ?? undefined,
            confirmations: Math.max(0, latestBlock - deposit.blockNumber + 1),
          });
          continue;
        }
        if (!deposit.tokenContract.address) {
          continue;
        }
        const logs = await this.rpcProvider.getLogs({
          networkKey: deposit.tokenContract.network.chainKey,
          address: deposit.tokenContract.address,
          fromBlock: deposit.blockNumber,
          toBlock: deposit.blockNumber,
        });
        const stillCanonical = logs.some(
          (log) =>
            log.transactionHash.toLowerCase() === deposit.txHash.toLowerCase() &&
            log.logIndex === deposit.logIndex,
        );
        if (
          !stillCanonical &&
          latestBlock - deposit.blockNumber >= deposit.tokenContract.network.reorgOverlapBlocks
        ) {
          await this.prisma.$transaction([
            this.prisma.deposit.update({
              where: { id: deposit.id },
              data: { status: 'FAILED' },
            }),
            ...(deposit.intentId
              ? [
                  this.prisma.depositIntent.update({
                    where: { id: deposit.intentId },
                    data: {
                      status: 'FAILED',
                      failureReason: 'Deposit log disappeared after chain reorganization',
                    },
                  }),
                ]
              : []),
          ]);
          continue;
        }
        if (stillCanonical) {
          await this.depositsService.recordDetectedDeposit({
            intentId: deposit.intentId ?? undefined,
            depositAddressId: deposit.depositAddressId ?? undefined,
            userId: deposit.userId ?? undefined,
            channel: deposit.channel,
            network: deposit.network,
            tokenContractId: deposit.tokenContractId ?? undefined,
            assetId: deposit.assetId,
            fromAddress: deposit.fromAddress ?? undefined,
            toAddress: deposit.toAddress,
            txHash: deposit.txHash,
            logIndex: deposit.logIndex ?? undefined,
            blockNumber: deposit.blockNumber,
            amount: deposit.amount.toString(),
            rawAmount: deposit.rawAmount ?? undefined,
            confirmations: Math.max(0, latestBlock - deposit.blockNumber + 1),
          });
        }
      } catch (error) {
        this.logger.warn(
          `Deposit reconciliation skipped ${deposit.txHash}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  async scanErc20Deposits(
    input: {
      assetSymbol: string;
      network?: string;
      fromBlock: number;
      toBlock?: number;
      latestBlock?: number;
      userId?: string;
    },
    existingTarget?: Erc20Target,
  ) {
    const target = existingTarget ?? await this.getScanTarget(input.assetSymbol, input.network);
    const { asset, network } = target;
    const latestBlock =
      input.latestBlock ?? (await this.rpcProvider.getLatestBlockNumber(network.chainKey));
    const toBlock = input.toBlock ?? latestBlock;
    const result = await this.scanErc20Targets(
      {
        networkKey: network.chainKey,
        fromBlock: input.fromBlock,
        toBlock,
        latestBlock,
        userId: input.userId,
      },
      [target],
    );
    return {
      asset: asset.symbol,
      network: network.chainKey,
      fromBlock: input.fromBlock,
      toBlock,
      latestBlock,
      scannedLogs: result.scannedLogs,
      deposits: result.deposits,
    };
  }

  private async scanErc20Targets(
    input: {
      networkKey: string;
      fromBlock: number;
      toBlock: number;
      latestBlock: number;
      userId?: string;
    },
    targets: Erc20Target[],
  ) {
    const first = targets[0];
    if (!first) return { scannedLogs: 0, deposits: [] };
    for (const target of targets) {
      const { asset, tokenContract, network } = target;
      if (
        network.chainKey !== first.network.chainKey ||
        target.legacyChain !== first.legacyChain
      ) {
        throw new BadRequestException('ERC20 batch must use one network');
      }
      if (tokenContract.standard !== TokenStandard.ERC20 || !tokenContract.address) {
        throw new BadRequestException('Only ERC20 token assets can be indexed by this scanner');
      }
      if (
        (!tokenContract.contractVerifiedAt || !tokenContract.contractCodeHash) &&
        (!asset.contractVerifiedAt || !asset.contractCodeHash)
      ) {
        throw new BadRequestException('Asset contract is not verified');
      }
    }

    const personalAddresses = await this.prisma.userDepositAddress.findMany({
      where: {
        network: first.legacyChain,
        status: 'ACTIVE',
        ...(input.userId ? { userId: input.userId } : {}),
      },
      select: { id: true, userId: true, address: true },
    });
    const batchSize = this.config.get<number>('DEPOSIT_ADDRESS_SCAN_BATCH_SIZE', 100);
    const blockRanges = this.blockRanges(input.fromBlock, input.toBlock, input.networkKey);
    const logs: RpcLog[] = [];
    const treasuryAddress = input.userId
      ? null
      : await this.depositsService.getActiveTreasuryAddress(first.legacyChain);
    const scanAddresses = [
      ...personalAddresses.map((address) => address.address),
      ...(treasuryAddress ? [treasuryAddress] : []),
    ];
    const tokenAddresses = targets.map((target) => target.tokenContract.address!);
    for (let offset = 0; offset < scanAddresses.length; offset += batchSize) {
      const batch = scanAddresses.slice(offset, offset + batchSize);
      for (const range of blockRanges) {
        const destinationTopics = batch.map((address) => this.addressToTopic(address));
        const destinationTopic =
          destinationTopics.length === 1 ? destinationTopics[0]! : destinationTopics;
        logs.push(
          ...(await this.fetchTransferLogs({
            networkKey: input.networkKey,
            tokenAddress: tokenAddresses.length === 1 ? tokenAddresses[0]! : tokenAddresses,
            destinationTopic,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
          })),
        );
      }
    }
    const addressByDestination = new Map(
      personalAddresses.map((address) => [address.address.toLowerCase(), address]),
    );
    const targetByContract = new Map(
      targets.map((target) => [target.tokenContract.address!.toLowerCase(), target]),
    );

    const deposits = [];
    for (const log of logs) {
      const target = targetByContract.get(log.address.toLowerCase());
      if (!target) continue;
      const { asset, tokenContract, network } = target;
      const parsed = decodeEventLog({
        abi: [TRANSFER_EVENT],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
      });

      if (parsed.eventName !== 'Transfer') {
        continue;
      }

      const args = parsed.args as TransferArgs;
      const fromAddress = getAddress(args.from);
      const toAddress = getAddress(args.to);
      const amount = formatUnits(args.value, tokenContract.decimals);
      const confirmations = Math.max(0, input.latestBlock - log.blockNumber + 1);
      const personalAddress = addressByDestination.get(toAddress.toLowerCase());
      const intent = await this.prisma.depositIntent.findFirst({
        where: {
          assetId: asset.id,
          tokenContractId: tokenContract.id,
          fromAddress: fromAddress.toLowerCase(),
          treasuryAddress: toAddress.toLowerCase(),
          amount,
          status: { in: ['PENDING', 'SUBMITTED', 'DETECTED', 'CONFIRMED'] },
          OR: [{ txHash: null }, { txHash: log.transactionHash.toLowerCase() }],
        },
        orderBy: { createdAt: 'asc' },
      });

      if (
        personalAddress &&
        (await this.shouldSkipPersonalDepositDetection({
          depositAddressId: personalAddress.id,
          tokenContractId: tokenContract.id,
          incomingRawAmount: args.value,
          network,
          personalAddress: personalAddress.address,
          tokenContract,
        }))
      ) {
        continue;
      }

      if (
        personalAddress &&
        (await this.depositsService.shouldSkipInternalPersonalDepositTransfer({
          userId: personalAddress.userId,
          fromAddress,
          network: first.legacyChain,
        }))
      ) {
        continue;
      }

      const deposit = await this.depositsService.recordDetectedDeposit({
          intentId: intent?.id,
          depositAddressId: personalAddress?.id,
          userId: personalAddress?.userId,
          network: first.legacyChain,
          tokenContractId: tokenContract.id,
          requireIntent: !personalAddress,
          channel: intent ? 'WEB3_INTENT' : personalAddress ? 'PERSONAL_ADDRESS' : 'UNMATCHED',
          assetId: asset.id,
          fromAddress,
          toAddress,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          blockNumber: log.blockNumber,
          amount,
          rawAmount: args.value.toString(),
          confirmations,
        });
      deposits.push(deposit);
    }

    return {
      scannedLogs: logs.length,
      deposits,
    };
  }

  async syncPersonalDepositsForUser(
    userId: string,
    options?: { mode?: 'blocking' | 'background' },
  ): Promise<void> {
    const mode = options?.mode ?? 'blocking';
    const now = Date.now();
    const cooldownMs = this.config.get<number>('DEPOSIT_PERSONAL_SYNC_COOLDOWN_MS', 300_000);
    if (
      mode === 'background' &&
      now - (this.lastUserSyncAt.get(userId) ?? 0) < cooldownMs
    ) {
      return;
    }
    const inFlight = this.userSyncInFlight.get(userId);
    if (inFlight) {
      if (mode === 'background') {
        return;
      }
      return inFlight;
    }

    this.lastUserSyncAt.set(userId, now);
    const task = this.runPersonalDepositSync(userId).finally(() => {
      this.userSyncInFlight.delete(userId);
    });
    this.userSyncInFlight.set(userId, task);

    if (mode === 'background') {
      void task.catch((error) => {
        this.logger.warn(
          `Background deposit sync failed for ${userId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      });
      return;
    }

    return task;
  }

  private async runPersonalDepositSync(userId: string): Promise<void> {
    const addresses = await this.prisma.userDepositAddress.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { id: true, userId: true, address: true, network: true },
    });
    if (addresses.length === 0) {
      await this.depositsService.creditReadyDeposits();
      return;
    }

    const legacyChains = [...new Set(addresses.map((address) => address.network))];
    const addressByLegacy = new Map<Chain, Array<{ id: string; userId: string; address: string }>>();
    for (const address of addresses) {
      const bucket = addressByLegacy.get(address.network) ?? [];
      bucket.push({ id: address.id, userId: address.userId, address: address.address });
      addressByLegacy.set(address.network, bucket);
    }

    const contracts = await this.prisma.tokenContract.findMany({
      where: this.depositEnabledContractFilter(legacyChains),
      include: { asset: true, network: true },
    });
    const depositReadinessChecked = new Set<string>();

    for (const contract of contracts) {
      const legacyChain = contract.network.legacyChain;
      if (!legacyChain) {
        continue;
      }
      const personalAddresses = addressByLegacy.get(legacyChain) ?? [];
      if (personalAddresses.length === 0) {
        continue;
      }

      if (contract.network.family === NetworkFamily.EVM) {
        try {
          await this.assertDepositWorkerReadyOnce(
            depositReadinessChecked,
            contract.network.chainKey,
          );
          const latest = await this.getLatestBlock(contract.network);
          const configuredLookback = contract.standard === TokenStandard.NATIVE
            ? this.config.get<number>('DEPOSIT_PERSONAL_NATIVE_SYNC_LOOKBACK_BLOCKS', 20) ?? 20
            : this.config.get<number>('DEPOSIT_PERSONAL_SYNC_LOOKBACK_BLOCKS', 5000) ?? 5000;
          const lookback = Math.min(
            configuredLookback,
            this.maxPersonalScanBlocks(contract.network.chainKey, contract.standard),
          );
          // Personal sync must catch up history for newly provisioned addresses.
          // The global indexer cursor only scans forward and would skip past deposits.
          const fromBlock = Math.max(0, latest - lookback);
          await this.scanDeposits({
            assetSymbol: contract.asset.symbol,
            network: contract.network.chainKey,
            fromBlock,
            toBlock: latest,
            latestBlock: latest,
            userId,
          });
        } catch (error) {
          this.logger.warn(
            `Personal deposit sync skipped ${contract.asset.symbol} on ${contract.network.chainKey} for ${userId}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        }
        if (this.isBalanceFallbackEnabled()) {
          await this.reconcilePersonalTokenBalanceDeposit({
            userId,
            asset: contract.asset,
            tokenContract: contract,
            network: contract.network,
            legacyChain,
            personalAddresses,
          }).catch((reconcileError) => {
            this.logger.warn(
              `Personal deposit balance reconcile failed ${contract.asset.symbol} on ${contract.network.chainKey} for ${userId}: ${
                reconcileError instanceof Error ? reconcileError.message : 'unknown error'
              }`,
            );
          });
        }
        continue;
      }

      try {
        // Route TVM scans through the same per-address cursor path as the
        // global indexer. Direct adapter scans replayed full Tron history and
        // could race the cron scanner while writing the same deposit.
        await this.scanDeposits({
          assetSymbol: contract.asset.symbol,
          network: contract.network.chainKey,
          fromBlock: 0,
          userId,
        });
      } catch (error) {
        this.logger.warn(
          `Personal deposit sync skipped ${contract.asset.symbol} on ${contract.network.chainKey} for ${userId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
      if (this.isBalanceFallbackEnabled()) {
        await this.reconcilePersonalTokenBalanceDeposit({
          userId,
          asset: contract.asset,
          tokenContract: contract,
          network: contract.network,
          legacyChain,
          personalAddresses,
        }).catch((reconcileError) => {
          this.logger.warn(
            `Personal deposit balance reconcile failed ${contract.asset.symbol} on ${contract.network.chainKey} for ${userId}: ${
              reconcileError instanceof Error ? reconcileError.message : 'unknown error'
            }`,
          );
        });
      }
    }

    await this.depositsService.creditReadyDeposits();
  }

  async scanDeposits(input: {
    assetSymbol: string;
    network?: string;
    fromBlock: number;
    toBlock?: number;
    latestBlock?: number;
    userId?: string;
  }) {
    const target = await this.getScanTarget(input.assetSymbol, input.network);
    if (target.network.family !== NetworkFamily.EVM) {
      const personalAddresses = await this.prisma.userDepositAddress.findMany({
        where: {
          network: target.legacyChain,
          status: 'ACTIVE',
          ...(input.userId ? { userId: input.userId } : {}),
        },
        select: { id: true, userId: true, address: true },
      });
      if (target.network.family === NetworkFamily.TVM) {
        return this.scanTronDepositsWithAddressCursors(input, target, personalAddresses);
      }
      const result = await this.nonEvm.scanDeposits({
        asset: target.asset,
        tokenContract: {
          ...target.tokenContract,
          network: target.network,
          asset: target.asset,
        },
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
        personalAddresses,
      });
      const deposits = await this.recordNonEvmDetectedDeposits({
        asset: target.asset,
        tokenContract: target.tokenContract,
        network: target.network,
        legacyChain: target.legacyChain,
        detected: result.deposits,
      });
      return {
        asset: target.asset.symbol,
        network: target.network.chainKey,
        fromBlock: input.fromBlock,
        toBlock: result.toBlock,
        latestBlock: result.latestBlock,
        scannedLogs: 0,
        scannedTransactions: result.scannedTransactions,
        deposits,
      };
    }
    if (target.tokenContract.standard === TokenStandard.NATIVE) {
      return this.scanNativeDeposits(input, target);
    }
    return this.scanErc20Deposits(input, target);
  }

  async scanNativeDeposits(
    input: {
      assetSymbol: string;
      network?: string;
      fromBlock: number;
      toBlock?: number;
      latestBlock?: number;
      userId?: string;
    },
    existingTarget?: Awaited<ReturnType<DepositIndexerService['getScanTarget']>>,
  ) {
    const target = existingTarget ?? await this.getScanTarget(input.assetSymbol, input.network);
    const { asset, tokenContract, network } = target;
    if (tokenContract.standard !== TokenStandard.NATIVE) {
      throw new BadRequestException('Only native assets can be indexed by this scanner');
    }

    await this.depositsService.reclassifySweepGasFundingDeposits(target.legacyChain);
    const sweepGasSources = new Set(
      (
        await this.prisma.custodyAccount.findMany({
          where: {
            role: CustodyAccountRole.SWEEP_GAS,
            network: target.legacyChain,
          },
          select: { address: true },
        })
      ).map((account) => account.address.toLowerCase()),
    );

    const latestBlock =
      input.latestBlock ?? (await this.rpcProvider.getLatestBlockNumber(network.chainKey));
    const toBlock = input.toBlock ?? latestBlock;
    const personalAddresses = await this.prisma.userDepositAddress.findMany({
      where: {
        network: target.legacyChain,
        status: 'ACTIVE',
        ...(input.userId ? { userId: input.userId } : {}),
      },
      select: { id: true, userId: true, address: true },
    });
    const addressByDestination = new Map(
      personalAddresses.map((address) => [address.address.toLowerCase(), address]),
    );
    const deposits = [];
    let scannedTransactions = 0;

    for (let blockNumber = input.fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      const block = await this.rpcProvider.getBlockWithTransactions(blockNumber, network.chainKey);
      for (const tx of block.transactions) {
        scannedTransactions += 1;
        if (!tx.to || BigInt(tx.value) <= 0n) {
          continue;
        }
        if (tx.from && sweepGasSources.has(tx.from.toLowerCase())) {
          continue;
        }
        const personalAddress = addressByDestination.get(tx.to.toLowerCase());
        if (!personalAddress) {
          continue;
        }
        if (
          await this.depositsService.shouldSkipInternalPersonalDepositTransfer({
            userId: personalAddress.userId,
            fromAddress: tx.from,
            network: target.legacyChain,
          })
        ) {
          continue;
        }
        const amount = formatUnits(BigInt(tx.value), tokenContract.decimals);
        const confirmations = Math.max(0, latestBlock - block.number + 1);
        const deposit = await this.depositsService.recordDetectedDeposit({
          depositAddressId: personalAddress.id,
          userId: personalAddress.userId,
          network: target.legacyChain,
          tokenContractId: tokenContract.id,
          channel: 'PERSONAL_ADDRESS',
          assetId: asset.id,
          fromAddress: tx.from,
          toAddress: tx.to,
          txHash: tx.hash,
          blockNumber: block.number,
          amount,
          rawAmount: tx.value,
          confirmations,
        });
        deposits.push(deposit);
      }
    }

    return {
      asset: asset.symbol,
      network: network.chainKey,
      fromBlock: input.fromBlock,
      toBlock,
      latestBlock,
      scannedLogs: 0,
      scannedTransactions,
      deposits,
    };
  }

  private addressToTopic(address: string): string {
    return `0x${'0'.repeat(24)}${getAddress(address).slice(2).toLowerCase()}`;
  }

  private blockRanges(fromBlock: number, toBlock: number, networkKey: string) {
    const maxRange = this.maxBlockRange(networkKey);
    const ranges: Array<{ fromBlock: number; toBlock: number }> = [];
    for (let from = fromBlock; from <= toBlock; from += maxRange) {
      ranges.push({
        fromBlock: from,
        toBlock: Math.min(from + maxRange - 1, toBlock),
      });
    }
    return ranges;
  }

  private async fetchTransferLogs(input: {
    networkKey: string;
    tokenAddress: string | string[];
    destinationTopic: string | string[];
    fromBlock: number;
    toBlock: number;
  }): Promise<RpcLog[]> {
    try {
      const logs = await this.rpcProvider.getLogs({
        networkKey: input.networkKey,
        address: input.tokenAddress,
        topics: [TRANSFER_TOPIC, null, input.destinationTopic],
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
      });
      await this.pauseBetweenLogRequests();
      return logs;
    } catch (error) {
      if (!this.isLogRangeLimitError(error) || input.fromBlock >= input.toBlock) {
        throw error;
      }
      const mid = input.fromBlock + Math.floor((input.toBlock - input.fromBlock) / 2);
      if (mid <= input.fromBlock) {
        throw error;
      }
      const left = await this.fetchTransferLogs({ ...input, toBlock: mid });
      const right = await this.fetchTransferLogs({ ...input, fromBlock: mid + 1 });
      return [...left, ...right];
    }
  }

  private pauseBetweenLogRequests(): Promise<void> {
    const pauseMs = this.config.get<number>('DEPOSIT_INDEXER_RPC_PAUSE_MS', 0);
    if (pauseMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  private isBalanceFallbackEnabled(): boolean {
    return this.config.get<boolean>('DEPOSIT_INDEXER_BALANCE_FALLBACK_ENABLED', true);
  }

  private shouldRunEvmFallbackScan(now = Date.now()): boolean {
    if (!this.config.get<boolean>('ALCHEMY_ADDRESS_ACTIVITY_ENABLED', false)) {
      return true;
    }
    const intervalMs = this.config.get<number>('DEPOSIT_EVM_FALLBACK_SCAN_MS', 300_000);
    if (now - this.lastEvmFallbackScanAt < intervalMs) {
      return false;
    }
    this.lastEvmFallbackScanAt = now;
    return true;
  }

  async reconcileAllPersonalDepositBalances(): Promise<{ reconciled: number }> {
    const addresses = await this.prisma.userDepositAddress.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, userId: true, address: true, network: true },
    });
    if (addresses.length === 0) {
      return { reconciled: 0 };
    }

    const legacyChains = [...new Set(addresses.map((address) => address.network))];
    const addressByLegacy = new Map<Chain, Array<{ id: string; userId: string; address: string }>>();
    for (const address of addresses) {
      const bucket = addressByLegacy.get(address.network) ?? [];
      bucket.push({ id: address.id, userId: address.userId, address: address.address });
      addressByLegacy.set(address.network, bucket);
    }

    const contracts = await this.prisma.tokenContract.findMany({
      where: this.depositEnabledContractFilter(legacyChains),
      include: { asset: true, network: true },
    });

    let reconciled = 0;
    for (const contract of contracts) {
      const legacyChain = contract.network.legacyChain;
      if (!legacyChain) {
        continue;
      }
      const personalAddresses = addressByLegacy.get(legacyChain) ?? [];
      if (personalAddresses.length === 0) {
        continue;
      }
      if (contract.network.family !== NetworkFamily.EVM) {
        try {
          this.nonEvm.assertSupportedNetwork(contract.network);
        } catch (_error) {
          continue;
        }
      }

      const result = await this.reconcilePersonalTokenBalanceDeposit({
        asset: contract.asset,
        tokenContract: contract,
        network: contract.network,
        legacyChain,
        personalAddresses,
      });
      reconciled += result.reconciled;
    }

    return { reconciled };
  }

  async reconcilePersonalEvmBalanceDeposit(input: {
    userId: string;
    asset: { id: string; symbol: string };
    tokenContract: { id: string; address: string | null; decimals: number; standard: TokenStandard };
    network: Network;
    legacyChain: Chain;
    personalAddresses: Array<{ id: string; userId: string; address: string }>;
  }): Promise<{ reconciled: number }> {
    return this.reconcilePersonalTokenBalanceDeposit(input);
  }

  async reconcilePersonalTokenBalanceDeposit(input: {
    userId?: string;
    asset: { id: string; symbol: string };
    tokenContract: { id: string; address: string | null; decimals: number; standard: TokenStandard };
    network: Network;
    legacyChain: Chain;
    personalAddresses: Array<{ id: string; userId: string; address: string }>;
  }): Promise<{ reconciled: number }> {
    if (!this.supportsBalanceReconcile(input.tokenContract, input.network)) {
      return { reconciled: 0 };
    }

    const latestBlock = await this.getLatestBlock(input.network);
    let reconciled = 0;

    for (const personalAddress of input.personalAddresses) {
      if (input.userId && personalAddress.userId !== input.userId) {
        continue;
      }

      const onChain = await this.readOnChainRawTokenBalance({
        personalAddress: personalAddress.address,
        tokenContract: input.tokenContract,
        network: input.network,
      });
      if (onChain === null) {
        continue;
      }

      const tracked = await this.sumTrackedRawDeposits(
        personalAddress.id,
        input.tokenContract.id,
      );
      if (onChain <= tracked) {
        continue;
      }

      const rawDelta = onChain - tracked;
      const amount = formatUnits(rawDelta, input.tokenContract.decimals);
      const txHash = this.buildBalanceReconcileTxHash({
        depositAddressId: personalAddress.id,
        tokenContractId: input.tokenContract.id,
        rawDelta,
      });
      const toAddress =
        input.network.family === NetworkFamily.EVM
          ? getAddress(personalAddress.address)
          : personalAddress.address;

      await this.depositsService.recordDetectedDeposit({
        depositAddressId: personalAddress.id,
        userId: personalAddress.userId,
        channel: 'PERSONAL_ADDRESS',
        network: input.legacyChain,
        tokenContractId: input.tokenContract.id,
        assetId: input.asset.id,
        toAddress,
        txHash,
        logIndex: BALANCE_RECONCILE_LOG_INDEX,
        blockNumber: latestBlock,
        amount,
        rawAmount: rawDelta.toString(),
        confirmations: input.network.confirmations,
      });
      reconciled += 1;
    }

    return { reconciled };
  }

  private supportsBalanceReconcile(
    tokenContract: { address: string | null; standard: TokenStandard },
    network: Network,
  ): boolean {
    if (!tokenContract.address) {
      return false;
    }
    if (network.family === NetworkFamily.EVM) {
      return (
        this.config.get<boolean>('DEPOSIT_EVM_BALANCE_RECONCILE_ENABLED', false) &&
        tokenContract.standard === TokenStandard.ERC20
      );
    }
    // Tron balances are only a reconciliation signal. A swept address can receive
    // the same amount again, so a lifetime balance delta cannot identify a deposit.
    if (network.family === NetworkFamily.TVM) return false;
    if (network.family === NetworkFamily.SVM) {
      return tokenContract.standard === TokenStandard.SPL;
    }
    return false;
  }

  private async readOnChainRawTokenBalance(input: {
    personalAddress: string;
    tokenContract: { address: string | null; decimals: number; standard: TokenStandard };
    network: Network;
  }): Promise<bigint | null> {
    if (!input.tokenContract.address) {
      return null;
    }

    if (input.network.family === NetworkFamily.EVM) {
      if (input.tokenContract.standard !== TokenStandard.ERC20) {
        return null;
      }
      return parseUnits(
        (
          await this.rpcProvider.getBalance(
            input.personalAddress,
            input.tokenContract.address,
            input.network.chainKey,
            input.tokenContract.decimals,
          )
        ).value,
        input.tokenContract.decimals,
      );
    }

    const balance = await this.nonEvm.getBalance({
      network: input.network,
      tokenContract: input.tokenContract,
      address: input.personalAddress,
    });
    if (balance.status !== 'AVAILABLE' || !balance.rawBalance) {
      return null;
    }
    try {
      return BigInt(balance.rawBalance);
    } catch (_error) {
      return null;
    }
  }

  private async shouldSkipPersonalDepositDetection(input: {
    depositAddressId: string;
    tokenContractId: string;
    incomingRawAmount: bigint;
    network: Network;
    personalAddress: string;
    tokenContract: { address: string | null; decimals: number; standard: TokenStandard };
  }): Promise<boolean> {
    const tracked = await this.sumTrackedRawDeposits(
      input.depositAddressId,
      input.tokenContractId,
    );
    if (tracked <= 0n) {
      return false;
    }

    const onChain = await this.readOnChainRawTokenBalance({
      personalAddress: input.personalAddress,
      tokenContract: input.tokenContract,
      network: input.network,
    });
    if (onChain === null) {
      return false;
    }
    if (tracked >= onChain) {
      return true;
    }
    return tracked + input.incomingRawAmount > onChain;
  }

  private async sumTrackedRawDeposits(
    depositAddressId: string,
    tokenContractId: string,
  ): Promise<bigint> {
    const deposits = await this.prisma.deposit.findMany({
      where: {
        depositAddressId,
        tokenContractId,
        status: { in: ['PENDING_CONFIRMATION', 'DETECTED', 'CREDITED'] },
      },
      select: { rawAmount: true },
    });

    return deposits.reduce((sum, deposit) => {
      if (!deposit.rawAmount) {
        return sum;
      }
      try {
        return sum + BigInt(deposit.rawAmount);
      } catch (_error) {
        return sum;
      }
    }, 0n);
  }

  private buildBalanceReconcileTxHash(input: {
    depositAddressId: string;
    tokenContractId: string;
    rawDelta: bigint;
  }): string {
    const digest = createHash('sha256')
      .update(
        `balance-reconcile:${input.depositAddressId}:${input.tokenContractId}:${input.rawDelta.toString()}`,
      )
      .digest('hex');
    return `0x${digest}`;
  }

  private isLogRangeLimitError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    return /limit exceeded|query returned more than|too many|block range|eth_getLogs requests with up to/i.test(
      error.message,
    );
  }

  private async getScanTarget(assetSymbol: string, networkKey?: string) {
    const asset = await this.assetsService.getBySymbol(assetSymbol);
    const key = networkKey?.trim().toLowerCase() || this.defaultNetworkKey();
    const network = await this.prisma.network.findUnique({ where: { chainKey: key } });
    if (!network) {
      throw new BadRequestException(`Unsupported network: ${key}`);
    }
    if (!network.legacyChain) {
      throw new BadRequestException('Network is missing legacy storage mapping');
    }
    if (network.family !== NetworkFamily.EVM) {
      this.nonEvm.assertSupportedNetwork(network);
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
    if (!tokenContract?.depositEnabled) {
      throw new BadRequestException('Only enabled token assets can be indexed by this scanner');
    }
    if (tokenContract.standard === TokenStandard.ERC20 && !tokenContract.address) {
      throw new BadRequestException('Only enabled ERC20 token assets can be indexed by this scanner');
    }
    const addressedStandards: TokenStandard[] = [TokenStandard.SPL, TokenStandard.TRC20];
    if (addressedStandards.includes(tokenContract.standard) && !tokenContract.address) {
      throw new BadRequestException(`Only enabled ${tokenContract.standard} token assets can be indexed by this scanner`);
    }
    return {
      asset,
      tokenContract,
      network,
      legacyChain: network.legacyChain,
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

  private depositEnabledContractFilter(legacyChains?: Chain[]) {
    const mainnetOnly = this.config.get<boolean>('DEPOSIT_INDEXER_MAINNET_ONLY', false);
    return {
      depositEnabled: true,
      network: {
        depositEnabled: true,
        ...(mainnetOnly ? { mainnet: true } : {}),
        ...(legacyChains ? { legacyChain: { in: legacyChains } } : {}),
      },
      OR: [
        { standard: TokenStandard.NATIVE },
        { standard: TokenStandard.ERC20, address: { not: null } },
        { standard: TokenStandard.SPL, address: { not: null } },
        { standard: TokenStandard.BTC },
        { standard: TokenStandard.TRC20, address: { not: null } },
      ],
    };
  }

  private async assertDepositWorkerReadyOnce(
    checked: Set<string>,
    chainKey: string,
  ): Promise<void> {
    if (checked.has(chainKey)) {
      return;
    }
    await this.readiness.assertWorkerReady('deposit', chainKey);
    checked.add(chainKey);
  }

  private cursorKey(networkKey: string, tokenContractId: string): string {
    return `deposit-indexer:${networkKey}:${tokenContractId}`;
  }

  private async recordNonEvmDetectedDeposits(input: {
    asset: { id: string };
    tokenContract: {
      id: string;
      address: string | null;
      decimals: number;
      standard: TokenStandard;
      minDepositAmount?: { toString(): string };
    };
    network: Network;
    legacyChain: Chain;
    detected: Array<{
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
    }>;
  }) {
    const deposits = [];
    for (const detected of input.detected) {
      const belowMinimum = new Prisma.Decimal(detected.amount).lessThan(
        new Prisma.Decimal(input.tokenContract.minDepositAmount?.toString() ?? '0'),
      );
      const internalTronGas = input.network.family === NetworkFamily.TVM &&
        input.tokenContract.standard === TokenStandard.NATIVE &&
        await this.depositsService.isInternalTronSweepGasFunding({
          txHash: detected.txHash,
          fromAddress: detected.fromAddress,
        });
      const forceUnmatched = belowMinimum || internalTronGas;
      const intent = await this.prisma.depositIntent.findFirst({
        where: {
          assetId: input.asset.id,
          tokenContractId: input.tokenContract.id,
          treasuryAddress: detected.toAddress,
          amount: detected.amount,
          status: { in: ['PENDING', 'SUBMITTED', 'DETECTED', 'CONFIRMED'] },
          OR: [{ txHash: null }, { txHash: detected.txHash }],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (
        !forceUnmatched &&
        input.network.family !== NetworkFamily.TVM &&
        await this.shouldSkipPersonalDepositDetection({
          depositAddressId: detected.depositAddressId,
          tokenContractId: input.tokenContract.id,
          incomingRawAmount: BigInt(detected.rawAmount),
          network: input.network,
          personalAddress: detected.toAddress,
          tokenContract: input.tokenContract,
        })
      ) {
        continue;
      }
      if (
        await this.depositsService.shouldSkipInternalPersonalDepositTransfer({
          userId: detected.userId,
          fromAddress: detected.fromAddress,
          network: input.legacyChain,
        })
      ) {
        continue;
      }
      deposits.push(
        await this.depositsService.recordDetectedDeposit({
          intentId: forceUnmatched ? undefined : intent?.id,
          depositAddressId: detected.depositAddressId,
          userId: forceUnmatched ? undefined : detected.userId,
          network: input.legacyChain,
          tokenContractId: input.tokenContract.id,
          channel: 'PERSONAL_ADDRESS',
          assetId: input.asset.id,
          fromAddress: detected.fromAddress,
          toAddress: detected.toAddress,
          txHash: detected.txHash,
          logIndex:
            input.tokenContract.standard === TokenStandard.NATIVE
              ? undefined
              : detected.outputIndex,
          blockNumber: detected.blockNumber,
          amount: detected.amount,
          rawAmount: detected.rawAmount,
          confirmations: detected.confirmations,
          forceUnmatched,
        }),
      );
    }
    return deposits;
  }

  private async scanTronDepositsWithAddressCursors(
    input: {
      assetSymbol: string;
      network?: string;
      fromBlock: number;
      toBlock?: number;
      latestBlock?: number;
      userId?: string;
    },
    target: Awaited<ReturnType<DepositIndexerService['getScanTarget']>>,
    personalAddresses: Array<{ id: string; userId: string; address: string }>,
  ) {
    const deposits = [];
    let latestBlock = input.latestBlock ?? 0;
    let toBlock = input.toBlock ?? 0;
    let scannedTransactions = 0;
    const overlapMs = this.config.get<number>('TRON_SCAN_TIMESTAMP_OVERLAP_MS', 60_000);
    const fixedToTimestampMs = Date.now();
    const stream = `${target.tokenContract.standard}:${target.tokenContract.id}`;

    for (const personalAddress of personalAddresses) {
      const key = `tron:${target.network.id}:${personalAddress.id}:${stream}`;
      const cursor = await this.prisma.tronDepositScanCursor.findUnique({ where: { key } });
      const storedTimestamp = Number(cursor?.lastTimestampMs ?? 0);
      const fromTimestampMs = Math.max(0, storedTimestamp - overlapMs);
      const result = await this.nonEvm.scanDeposits({
        asset: target.asset,
        tokenContract: {
          ...target.tokenContract,
          network: target.network,
          asset: target.asset,
        },
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
        fromTimestampMs,
        toTimestampMs: fixedToTimestampMs,
        personalAddresses: [personalAddress],
      });
      const recorded = await this.recordNonEvmDetectedDeposits({
        asset: target.asset,
        tokenContract: target.tokenContract,
        network: target.network,
        legacyChain: target.legacyChain,
        detected: result.deposits,
      });
      deposits.push(...recorded);
      latestBlock = Math.max(latestBlock, result.latestBlock);
      toBlock = Math.max(toBlock, result.toBlock);
      scannedTransactions += result.scannedTransactions;
      const lastTimestampMs = BigInt(result.toTimestampMs ?? fixedToTimestampMs);
      await this.prisma.tronDepositScanCursor.upsert({
        where: { key },
        update: {
          lastTimestampMs,
          lastBlock: result.toBlock,
        },
        create: {
          key,
          networkId: target.network.id,
          depositAddressId: personalAddress.id,
          stream,
          lastTimestampMs,
          lastBlock: result.toBlock,
        },
      });
    }

    return {
      asset: target.asset.symbol,
      network: target.network.chainKey,
      fromBlock: input.fromBlock,
      toBlock,
      latestBlock,
      scannedLogs: 0,
      scannedTransactions,
      deposits,
    };
  }

  private async getLatestBlock(network: Network): Promise<number> {
    const key = network.chainKey.toLowerCase();
    const cached = this.latestBlockCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const value = network.family === NetworkFamily.EVM
      ? this.rpcProvider.getLatestBlockNumber(network.chainKey)
      : this.nonEvm.getLatestBlock(network);
    this.latestBlockCache.set(key, { expiresAt: Date.now() + 2_000, value });
    try {
      return await value;
    } catch (error) {
      this.latestBlockCache.delete(key);
      throw error;
    }
  }

  private maxBlockRange(networkKey: string): number {
    const configured = this.config.get<number>('DEPOSIT_INDEXER_MAX_BLOCK_RANGE', 250) ?? 250;
    return networkKey === 'bnb' || networkKey === 'bnb-testnet'
      ? Math.min(configured, 10)
      : configured;
  }

  private maxBlocksPerRun(networkKey: string, standard: TokenStandard): number {
    if (standard === TokenStandard.NATIVE) {
      return this.config.get<number>('DEPOSIT_PERSONAL_NATIVE_SYNC_LOOKBACK_BLOCKS', 20) ?? 20;
    }
    return this.maxBlockRange(networkKey) * 5;
  }

  private maxPersonalScanBlocks(networkKey: string, standard: TokenStandard): number {
    if (standard === TokenStandard.NATIVE) {
      return this.config.get<number>('DEPOSIT_PERSONAL_NATIVE_SYNC_LOOKBACK_BLOCKS', 20) ?? 20;
    }
    return this.maxBlockRange(networkKey) * (networkKey.startsWith('bnb') ? 20 : 5);
  }

  private resolveScanFromBlock(input: {
    stored: number;
    latest: number;
    network: Pick<Network, 'family' | 'reorgOverlapBlocks'>;
    tokenStandard: TokenStandard;
  }): number {
    const configuredStart = this.config.get<number>('DEPOSIT_INDEXER_START_BLOCK', 0);
    const anchor = input.stored > 0
      ? input.stored
      : configuredStart && configuredStart > 0
        ? configuredStart
        : input.latest;

    const configuredOverlap = this.config.get<number>(
      'DEPOSIT_INDEXER_REORG_OVERLAP_BLOCKS',
      30,
    );
    const overlap = input.network.family !== NetworkFamily.EVM
      ? input.network.reorgOverlapBlocks
      : input.tokenStandard === TokenStandard.NATIVE
        ? this.config.get<number>('DEPOSIT_INDEXER_NATIVE_REORG_OVERLAP_BLOCKS', 2)
        : Math.min(input.network.reorgOverlapBlocks, configuredOverlap);
    return Math.max(0, anchor - overlap);
  }
}
