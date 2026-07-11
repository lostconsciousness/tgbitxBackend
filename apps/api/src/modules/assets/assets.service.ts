import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  Chain,
  CustodyAccountRole,
  CustodyAccountStatus,
  NetworkFamily,
  Prisma,
  TokenStandard,
} from '@prisma/client';
import { getAddress, keccak256 } from 'viem';
import { PrismaService } from '../../database/prisma.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { RPC_PROVIDER } from '../rpc/rpc.module';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { UpdateAssetTransfersDto } from './dto/update-asset-transfers.dto';
import { UpsertTokenContractDto } from './dto/upsert-token-contract.dto';
import { BulkEnableAssetTransfersDto, BulkVerifyAssetsDto } from './dto/bulk-assets.dto';

type BulkAssetAction = 'verify' | 'enable_transfers';
type BulkAssetStatus = 'verified' | 'enabled' | 'would_verify' | 'would_enable' | 'skipped' | 'failed';

type BulkAssetResult = {
  assetSymbol: string;
  network: string;
  standard: TokenStandard;
  action: BulkAssetAction;
  status: BulkAssetStatus;
  reason: string | null;
  contractAddress: string | null;
  chainId: number | null;
  verifiedChainId: number | null;
  decimals: number;
};

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RPC_PROVIDER) private readonly rpcProvider: RpcProvider,
  ) {}

  list() {
    return this.prisma.asset.findMany({
      include: {
        tokenContracts: {
          where: {
            OR: [
              { depositEnabled: true, network: { depositEnabled: true } },
              { withdrawalEnabled: true, network: { withdrawalEnabled: true } },
            ],
          },
          include: { network: true },
          orderBy: [{ network: { chainKey: 'asc' } }, { standard: 'asc' }],
        },
      },
      orderBy: { symbol: 'asc' },
    });
  }

  async getPublicBySymbol(symbol: string) {
    const asset = await this.prisma.asset.findUnique({
      where: { symbol: symbol.toUpperCase() },
      include: {
        tokenContracts: {
          where: {
            OR: [
              { depositEnabled: true, network: { depositEnabled: true } },
              { withdrawalEnabled: true, network: { withdrawalEnabled: true } },
            ],
          },
          include: { network: true },
          orderBy: [{ network: { chainKey: 'asc' } }, { standard: 'asc' }],
        },
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return asset;
  }

  async getBySymbol(symbol: string) {
    const asset = await this.prisma.asset.findUnique({
      where: { symbol: symbol.toUpperCase() },
      include: { tokenContracts: { include: { network: true } } },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return asset;
  }

  create(dto: CreateAssetDto) {
    return this.prisma.$transaction(async (tx) => {
      const chain = dto.chain ?? Chain.ARBITRUM;
      const asset = await tx.asset.create({
        data: {
          symbol: dto.symbol.toUpperCase(),
          name: dto.name,
          iconUrl: dto.iconUrl,
          type: dto.type,
          chain,
          tokenAddress: dto.tokenAddress ? getAddress(dto.tokenAddress) : undefined,
          decimals: dto.decimals,
          depositEnabled: false,
          withdrawalEnabled: false,
          withdrawalFeeAmount: dto.withdrawalFeeAmount
            ? new Prisma.Decimal(dto.withdrawalFeeAmount)
            : undefined,
          minWithdrawalAmount: dto.minWithdrawalAmount
            ? new Prisma.Decimal(dto.minWithdrawalAmount)
            : undefined,
        },
      });
      if (dto.tokenAddress) {
        const network = await tx.network.findFirst({ where: { legacyChain: chain } });
        if (network) {
          await tx.tokenContract.create({
            data: {
              assetId: asset.id,
              networkId: network.id,
              standard: TokenStandard.ERC20,
              address: getAddress(dto.tokenAddress),
              decimals: dto.decimals,
              depositEnabled: false,
              withdrawalEnabled: false,
              withdrawalFeeAmount: dto.withdrawalFeeAmount
                ? new Prisma.Decimal(dto.withdrawalFeeAmount)
                : undefined,
              minWithdrawalAmount: dto.minWithdrawalAmount
                ? new Prisma.Decimal(dto.minWithdrawalAmount)
                : undefined,
            },
          });
        }
      }
      return asset;
    });
  }

  async update(symbol: string, dto: UpdateAssetDto) {
    await this.getBySymbol(symbol);

    return this.prisma.asset.update({
      where: { symbol: symbol.toUpperCase() },
      data: {
        iconUrl: dto.iconUrl,
        withdrawalFeeAmount: dto.withdrawalFeeAmount
          ? new Prisma.Decimal(dto.withdrawalFeeAmount)
          : undefined,
        minWithdrawalAmount: dto.minWithdrawalAmount
          ? new Prisma.Decimal(dto.minWithdrawalAmount)
          : undefined,
      },
    });
  }

  async upsertTokenContract(symbol: string, dto: UpsertTokenContractDto) {
    const asset = await this.getBySymbol(symbol);
    const network = await this.getNetworkByKey(dto.network);
    const standard = dto.standard ?? TokenStandard.ERC20;
    const address = dto.tokenAddress
      ? standard === TokenStandard.ERC20
        ? getAddress(dto.tokenAddress)
        : dto.tokenAddress.trim()
      : null;

    if (standard === TokenStandard.ERC20 && !address) {
      throw new BadRequestException('ERC20 token contract address is required');
    }
    if (
      network.family === 'EVM' &&
      standard !== TokenStandard.ERC20 &&
      standard !== TokenStandard.NATIVE
    ) {
      throw new BadRequestException('EVM networks currently support ERC20 and native token contracts only');
    }
    if (standard === TokenStandard.NATIVE && address) {
      throw new BadRequestException('Native token contracts must not include a token address');
    }

    await this.prisma.tokenContract.upsert({
      where: {
        assetId_networkId_standard: {
          assetId: asset.id,
          networkId: network.id,
          standard,
        },
      },
      update: {
        address,
        decimals: dto.decimals,
        withdrawalFeeAmount: dto.withdrawalFeeAmount
          ? new Prisma.Decimal(dto.withdrawalFeeAmount)
          : undefined,
        minWithdrawalAmount: dto.minWithdrawalAmount
          ? new Prisma.Decimal(dto.minWithdrawalAmount)
          : undefined,
        depositEnabled: false,
        withdrawalEnabled: false,
        contractVerifiedAt: null,
        contractCodeHash: null,
        verifiedChainId: null,
      },
      create: {
        assetId: asset.id,
        networkId: network.id,
        standard,
        address,
        decimals: dto.decimals,
        depositEnabled: false,
        withdrawalEnabled: false,
        withdrawalFeeAmount: dto.withdrawalFeeAmount
          ? new Prisma.Decimal(dto.withdrawalFeeAmount)
          : undefined,
        minWithdrawalAmount: dto.minWithdrawalAmount
          ? new Prisma.Decimal(dto.minWithdrawalAmount)
          : undefined,
      },
    });

    return this.getBySymbol(asset.symbol);
  }

  async verifyContract(symbol: string, networkKey?: string) {
    const asset = await this.getBySymbol(symbol);
    const network = networkKey
      ? await this.getNetworkByKey(networkKey)
      : await this.getNetworkForLegacyChain(asset.chain);
    const tokenContract = network
      ? await this.prisma.tokenContract.findUnique({
          where: {
            assetId_networkId_standard: {
              assetId: asset.id,
              networkId: network.id,
              standard: TokenStandard.ERC20,
            },
          },
        })
      : null;
    if (networkKey && !tokenContract) {
      throw new BadRequestException('Token contract is not configured for this network');
    }
    const tokenAddress = tokenContract?.address ?? asset.tokenAddress;
    if (!tokenAddress) {
      throw new BadRequestException('Asset does not have an ERC20 contract address');
    }

    const chainId = await this.rpcProvider.getChainId(network?.chainKey);
    const expectedChainId = network?.chainId ?? (asset.chain === Chain.ARBITRUM_SEPOLIA ? 421614 : 42161);
    if (chainId !== expectedChainId) {
      throw new BadRequestException(`RPC chain mismatch: expected ${expectedChainId}, got ${chainId}`);
    }

    const [code, metadata] = await Promise.all([
      this.rpcProvider.getCode(tokenAddress, network?.chainKey),
      this.rpcProvider.getErc20Metadata(tokenAddress, network?.chainKey),
    ]);
    if (code === '0x' || code === '0x0') {
      throw new BadRequestException('Token address does not contain contract bytecode');
    }
    if (metadata.symbol.toUpperCase() !== asset.symbol) {
      throw new BadRequestException(
        `Token symbol mismatch: expected ${asset.symbol}, got ${metadata.symbol}`,
      );
    }
    const expectedDecimals = tokenContract?.decimals ?? asset.decimals;
    if (metadata.decimals !== expectedDecimals) {
      throw new BadRequestException(
        `Token decimals mismatch: expected ${expectedDecimals}, got ${metadata.decimals}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (tokenContract) {
        await tx.tokenContract.update({
          where: { id: tokenContract.id },
          data: {
            contractVerifiedAt: new Date(),
            contractCodeHash: keccak256(code as `0x${string}`),
            verifiedChainId: chainId,
          },
        });
      }
      if (networkKey) {
        return tx.asset.findUniqueOrThrow({ where: { id: asset.id } });
      }
      return tx.asset.update({
      where: { id: asset.id },
      data: {
        contractVerifiedAt: new Date(),
        contractCodeHash: keccak256(code as `0x${string}`),
        verifiedChainId: chainId,
      },
      });
    });
  }

  async updateTransfers(symbol: string, dto: UpdateAssetTransfersDto, networkKey?: string) {
    const asset = await this.getBySymbol(symbol);
    const network = networkKey
      ? await this.getNetworkByKey(networkKey)
      : await this.getNetworkForLegacyChain(asset.chain);
    const tokenContract = network
      ? await this.prisma.tokenContract.findUnique({
          where: {
            assetId_networkId_standard: {
              assetId: asset.id,
              networkId: network.id,
              standard: TokenStandard.ERC20,
            },
          },
        })
      : null;
    if (networkKey && !tokenContract) {
      throw new BadRequestException('Token contract is not configured for this network');
    }
    const verifiedChainId = tokenContract?.verifiedChainId ?? asset.verifiedChainId;
    const contractVerifiedAt = tokenContract?.contractVerifiedAt ?? asset.contractVerifiedAt;
    const contractCodeHash = tokenContract?.contractCodeHash ?? asset.contractCodeHash;
    if (
      (dto.depositEnabled || dto.withdrawalEnabled) &&
      (!contractVerifiedAt ||
        !contractCodeHash ||
        verifiedChainId !== (network?.chainId ?? (asset.chain === Chain.ARBITRUM_SEPOLIA ? 421614 : 42161)))
    ) {
      throw new BadRequestException('Asset contract must be verified before transfers are enabled');
    }

    return this.prisma.$transaction(async (tx) => {
      if (tokenContract) {
        await tx.tokenContract.update({
          where: { id: tokenContract.id },
          data: {
            depositEnabled: dto.depositEnabled,
            withdrawalEnabled: dto.withdrawalEnabled,
          },
        });
      }
      if (networkKey) {
        return tx.asset.findUniqueOrThrow({ where: { id: asset.id } });
      }
      return tx.asset.update({
      where: { id: asset.id },
      data: {
        depositEnabled: dto.depositEnabled,
        withdrawalEnabled: dto.withdrawalEnabled,
      },
      });
    });
  }

  async bulkVerify(dto: BulkVerifyAssetsDto) {
    const contracts = await this.findBulkTokenContracts(dto);
    const results: BulkAssetResult[] = [];

    for (const contract of contracts) {
      results.push(await this.verifyTokenContract(contract, Boolean(dto.dryRun)));
    }

    return {
      scope: 'testnet',
      dryRun: Boolean(dto.dryRun),
      results,
      summary: this.summarizeBulkResults(results),
    };
  }

  async bulkEnableTransfers(dto: BulkEnableAssetTransfersDto) {
    const deposits = dto.deposits ?? true;
    const withdrawals = dto.withdrawals ?? false;
    if (!deposits && !withdrawals) {
      throw new BadRequestException('At least one of deposits or withdrawals must be true');
    }

    const contracts = await this.findBulkTokenContracts(dto);
    const results: BulkAssetResult[] = [];

    for (const contract of contracts) {
      results.push(await this.enableTokenContractTransfers(contract, {
        deposits,
        withdrawals,
        dryRun: Boolean(dto.dryRun),
      }));
    }

    return {
      scope: 'testnet',
      dryRun: Boolean(dto.dryRun),
      deposits,
      withdrawals,
      results,
      summary: this.summarizeBulkResults(results),
    };
  }

  private async verifyTokenContract(
    contract: Awaited<ReturnType<AssetsService['findBulkTokenContracts']>>[number],
    dryRun: boolean,
  ): Promise<BulkAssetResult> {
    const base = this.toBulkResult(contract, 'verify');
    if (contract.network.mainnet) {
      return { ...base, status: 'failed', reason: 'Mainnet bulk verify is disabled' };
    }
    if (contract.network.family !== NetworkFamily.EVM) {
      return {
        ...base,
        status: 'skipped',
        reason: `${contract.network.family} adapter is not enabled`,
      };
    }
    if (!contract.network.chainId) {
      return { ...base, status: 'failed', reason: 'Network chainId is not configured' };
    }

    try {
      const chainId = await this.rpcProvider.getChainId(contract.network.chainKey);
      if (chainId !== contract.network.chainId) {
        return {
          ...base,
          status: 'failed',
          reason: `RPC chain mismatch: expected ${contract.network.chainId}, got ${chainId}`,
        };
      }

      if (contract.standard === TokenStandard.NATIVE) {
        if (!dryRun) {
          await this.prisma.tokenContract.update({
            where: { id: contract.id },
            data: {
              contractVerifiedAt: new Date(),
              contractCodeHash: null,
              verifiedChainId: chainId,
              metadata: this.mergeMetadata(contract.metadata, {
                verification: { kind: 'native', chainId },
              }),
            },
          });
        }
        return {
          ...base,
          status: dryRun ? 'would_verify' : 'verified',
          verifiedChainId: chainId,
          reason: null,
        };
      }

      if (contract.standard !== TokenStandard.ERC20) {
        return {
          ...base,
          status: 'skipped',
          reason: `${contract.standard} adapter is not enabled`,
        };
      }
      if (!contract.address) {
        return { ...base, status: 'skipped', reason: 'Token contract address is not configured' };
      }

      const [code, metadata] = await Promise.all([
        this.rpcProvider.getCode(contract.address, contract.network.chainKey),
        this.rpcProvider.getErc20Metadata(contract.address, contract.network.chainKey),
      ]);
      if (code === '0x' || code === '0x0') {
        return { ...base, status: 'failed', reason: 'Token address does not contain bytecode' };
      }
      if (metadata.symbol.toUpperCase() !== contract.asset.symbol) {
        return {
          ...base,
          status: 'failed',
          reason: `Token symbol mismatch: expected ${contract.asset.symbol}, got ${metadata.symbol}`,
        };
      }
      if (metadata.decimals !== contract.decimals) {
        return {
          ...base,
          status: 'failed',
          reason: `Token decimals mismatch: expected ${contract.decimals}, got ${metadata.decimals}`,
        };
      }

      const codeHash = keccak256(code as `0x${string}`);
      if (!dryRun) {
        await this.prisma.tokenContract.update({
          where: { id: contract.id },
          data: {
            contractVerifiedAt: new Date(),
            contractCodeHash: codeHash,
            verifiedChainId: chainId,
          },
        });
      }
      return {
        ...base,
        status: dryRun ? 'would_verify' : 'verified',
        verifiedChainId: chainId,
        reason: null,
      };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        reason: error instanceof Error ? error.message : 'Verification failed',
      };
    }
  }

  private async enableTokenContractTransfers(
    contract: Awaited<ReturnType<AssetsService['findBulkTokenContracts']>>[number],
    options: { deposits: boolean; withdrawals: boolean; dryRun: boolean },
  ): Promise<BulkAssetResult> {
    const base = this.toBulkResult(contract, 'enable_transfers');
    if (contract.network.mainnet) {
      return { ...base, status: 'failed', reason: 'Mainnet bulk enable is disabled' };
    }
    if (contract.network.family !== NetworkFamily.EVM) {
      return {
        ...base,
        status: 'skipped',
        reason: `${contract.network.family} adapter is not enabled`,
      };
    }
    if (!contract.network.legacyChain) {
      return { ...base, status: 'failed', reason: 'Network legacy chain mapping is missing' };
    }
    if (contract.standard === TokenStandard.ERC20 && !contract.address) {
      return { ...base, status: 'skipped', reason: 'Token contract address is not configured' };
    }
    if (!this.isContractVerifiedForNetwork(contract)) {
      return { ...base, status: 'skipped', reason: 'Token contract is not verified' };
    }

    let enableWithdrawals = options.withdrawals;
    let withdrawalSkipReason: string | null = null;
    if (options.withdrawals) {
      withdrawalSkipReason = await this.getWithdrawalReadinessIssue(contract.network.legacyChain);
      enableWithdrawals = !withdrawalSkipReason;
    }

    if (!options.deposits && !enableWithdrawals) {
      return {
        ...base,
        status: 'skipped',
        reason: withdrawalSkipReason ?? 'No transfer direction is eligible',
      };
    }

    if (!options.dryRun) {
      await this.prisma.$transaction(async (tx) => {
        await tx.network.update({
          where: { id: contract.networkId },
          data: {
            depositEnabled: options.deposits ? true : undefined,
            withdrawalEnabled: enableWithdrawals ? true : undefined,
          },
        });
        await tx.tokenContract.update({
          where: { id: contract.id },
          data: {
            depositEnabled: options.deposits ? true : undefined,
            withdrawalEnabled: enableWithdrawals ? true : undefined,
          },
        });
      });
    }

    return {
      ...base,
      status: options.dryRun ? 'would_enable' : 'enabled',
      reason: withdrawalSkipReason
        ? `Deposits eligible; withdrawals skipped: ${withdrawalSkipReason}`
        : null,
    };
  }

  private async findBulkTokenContracts(dto: BulkAssetBaseDtoLike) {
    if ((dto.scope ?? 'testnet').trim().toLowerCase() !== 'testnet') {
      throw new BadRequestException('Only scope=testnet is supported for bulk asset operations');
    }

    const networkKeys = dto.networks?.map((network) => network.trim().toLowerCase()).filter(Boolean);
    if (networkKeys?.length) {
      const selectedNetworks = await this.prisma.network.findMany({
        where: { chainKey: { in: networkKeys } },
      });
      const found = new Set(selectedNetworks.map((network) => network.chainKey));
      const missing = networkKeys.filter((network) => !found.has(network));
      if (missing.length) {
        throw new BadRequestException(`Unsupported networks: ${missing.join(', ')}`);
      }
      const mainnet = selectedNetworks.find((network) => network.mainnet);
      if (mainnet) {
        throw new BadRequestException(`Mainnet bulk operations are disabled: ${mainnet.chainKey}`);
      }
    }

    const standards = dto.standards?.length
      ? dto.standards
      : [
          TokenStandard.NATIVE,
          TokenStandard.ERC20,
          TokenStandard.SPL,
          TokenStandard.BTC,
          TokenStandard.TRC20,
        ];
    const assetSymbols = dto.assetSymbols?.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);

    return this.prisma.tokenContract.findMany({
      where: {
        standard: { in: standards },
        network: {
          mainnet: false,
          ...(networkKeys?.length ? { chainKey: { in: networkKeys } } : {}),
        },
        ...(assetSymbols?.length ? { asset: { symbol: { in: assetSymbols } } } : {}),
      },
      include: { asset: true, network: true },
      orderBy: [{ network: { chainKey: 'asc' } }, { asset: { symbol: 'asc' } }],
    });
  }

  private isContractVerifiedForNetwork(contract: {
    standard: TokenStandard;
    contractVerifiedAt: Date | null;
    contractCodeHash: string | null;
    verifiedChainId: number | null;
    network: { chainId: number | null };
  }) {
    if (!contract.contractVerifiedAt || contract.verifiedChainId !== contract.network.chainId) {
      return false;
    }
    return contract.standard === TokenStandard.NATIVE || Boolean(contract.contractCodeHash);
  }

  private async getWithdrawalReadinessIssue(network: Chain): Promise<string | null> {
    const account = await this.prisma.custodyAccount.findFirst({
      where: {
        role: CustodyAccountRole.WITHDRAWAL_HOT,
        network,
        status: CustodyAccountStatus.ACTIVE,
      },
    });
    if (!account) {
      return 'Active withdrawal hot wallet is not configured';
    }
    if (account.address.toLowerCase() === '0x0000000000000000000000000000000000000000') {
      return 'Withdrawal hot wallet cannot use the zero address';
    }
    if (!account.providerWalletRef) {
      return 'Withdrawal hot wallet provider ref is missing';
    }
    return null;
  }

  private toBulkResult(
    contract: Awaited<ReturnType<AssetsService['findBulkTokenContracts']>>[number],
    action: BulkAssetAction,
  ): BulkAssetResult {
    return {
      assetSymbol: contract.asset.symbol,
      network: contract.network.chainKey,
      standard: contract.standard,
      action,
      status: 'skipped',
      reason: null,
      contractAddress: contract.address,
      chainId: contract.network.chainId,
      verifiedChainId: contract.verifiedChainId,
      decimals: contract.decimals,
    };
  }

  private summarizeBulkResults(results: BulkAssetResult[]) {
    return results.reduce<Record<string, number>>((summary, result) => {
      summary[result.status] = (summary[result.status] ?? 0) + 1;
      return summary;
    }, {});
  }

  private mergeMetadata(
    metadata: Prisma.JsonValue,
    patch: Prisma.InputJsonObject,
  ): Prisma.InputJsonObject {
    const current =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Prisma.JsonObject)
        : {};
    return { ...current, ...patch };
  }

  private getNetworkForLegacyChain(chain: Chain) {
    return this.prisma.network.findFirst({ where: { legacyChain: chain } });
  }

  private async getNetworkByKey(chainKey: string) {
    const network = await this.prisma.network.findUnique({
      where: { chainKey: chainKey.trim().toLowerCase() },
    });
    if (!network) {
      throw new BadRequestException(`Unsupported network: ${chainKey}`);
    }
    return network;
  }
}

type BulkAssetBaseDtoLike = Pick<
  BulkVerifyAssetsDto,
  'scope' | 'networks' | 'assetSymbols' | 'standards'
>;
