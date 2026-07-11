import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Chain,
  NetworkFamily,
  Prisma,
  UserDepositAddressStatus,
} from '@prisma/client';
import { createHash } from 'crypto';
import { getAddress } from 'viem';
import { PrismaService } from '../../database/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { AuditService } from '../audit/audit.service';
import { PrivyCustodyService } from '../treasury/privy-custody.service';
import { NonEvmTestnetAdapterService } from '../onchain/non-evm-testnet-adapter.service';

@Injectable()
export class DepositAddressService {
  private readonly logger = new Logger(DepositAddressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: AssetsService,
    private readonly custody: PrivyCustodyService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly nonEvm: NonEvmTestnetAdapterService,
  ) {}

  async provision(userId: string, assetSymbol: string, networkKey?: string) {
    const target = await this.getEligibleTarget(assetSymbol, networkKey);
    const network = target.legacyChain;

    const existing = await this.prisma.userDepositAddress.findUnique({
      where: { userId_network: { userId, network } },
    });
    if (existing?.status === UserDepositAddressStatus.ACTIVE) {
      return this.toResponse(existing, target);
    }
    if (existing?.status === UserDepositAddressStatus.PAUSED) {
      throw new ServiceUnavailableException('Personal deposit address is paused');
    }

    const externalId = this.externalId(userId, network);
    const row = existing
      ? existing.status === UserDepositAddressStatus.FAILED
        ? await this.prisma.userDepositAddress.update({
            where: { id: existing.id },
            data: {
              status: UserDepositAddressStatus.PROVISIONING,
              failureReason: null,
            },
          })
        : existing
      : await this.createProvisioningRow(userId, network, externalId);
    if (target.network.family === NetworkFamily.SVM && target.network.mainnet) {
      const policyId = this.config.get<string>('PRIVY_SOLANA_POLICY_ID');
      if (!policyId || !this.custody.isSolanaEnabled()) {
        await this.markFailed(row.id, 'Privy Solana wallet or policy is not configured');
        throw new ServiceUnavailableException('Solana deposit provisioning is disabled');
      }
      try {
        const wallet = await this.custody.createOrGetSolanaWallet({
          externalId,
          displayName: `Deposit ${target.network.chainKey} ${userId.slice(-8)}`,
          policyId,
        });
        const active = await this.prisma.userDepositAddress.update({
          where: { id: row.id },
          data: {
            address: wallet.address,
            provider: 'PRIVY',
            providerWalletRef: wallet.id,
            policyRef: policyId,
            status: UserDepositAddressStatus.ACTIVE,
            failureReason: null,
            provisionedAt: new Date(),
          },
        });
        await this.audit.record({
          actorUserId: userId,
          action: 'PERSONAL_DEPOSIT_ADDRESS_PROVISIONED',
          entityType: 'UserDepositAddress',
          entityId: active.id,
          metadata: { network, address: wallet.address, provider: 'PRIVY' },
        });
        return this.toResponse(active, target);
      } catch (error) {
        await this.markFailed(row.id, this.safeErrorMessage(error));
        throw new ServiceUnavailableException('Could not provision a Solana deposit address');
      }
    }

    if (target.network.family === NetworkFamily.TVM && target.network.mainnet) {
      const policyId = this.config.get<string>('PRIVY_TRON_POLICY_ID');
      if (!policyId || !this.custody.isTronEnabled()) {
        await this.markFailed(row.id, 'Privy Tron wallet or policy is not configured');
        throw new ServiceUnavailableException('Tron deposit provisioning is disabled');
      }
      try {
        const wallet = await this.custody.createOrGetTronWallet({
          externalId,
          displayName: `Deposit ${target.network.chainKey} ${userId.slice(-8)}`,
          policyId,
        });
        const active = await this.prisma.userDepositAddress.update({
          where: { id: row.id },
          data: {
            address: wallet.address,
            provider: 'PRIVY',
            providerWalletRef: wallet.id,
            policyRef: policyId,
            status: UserDepositAddressStatus.ACTIVE,
            failureReason: null,
            provisionedAt: new Date(),
          },
        });
        await this.audit.record({
          actorUserId: userId,
          action: 'PERSONAL_DEPOSIT_ADDRESS_PROVISIONED',
          entityType: 'UserDepositAddress',
          entityId: active.id,
          metadata: { network, address: wallet.address, provider: 'PRIVY' },
        });
        return this.toResponse(active, target);
      } catch (error) {
        await this.markFailed(row.id, this.safeErrorMessage(error));
        throw new ServiceUnavailableException('Could not provision a Tron deposit address');
      }
    }

    if (target.network.family !== NetworkFamily.EVM) {
      try {
        const wallet = await this.nonEvm.provisionDepositAddress(target.network);
        const address = this.nonEvm.normalizeAddress(target.network, wallet.address);
        const active = await this.prisma.userDepositAddress.update({
          where: { id: row.id },
          data: {
            address,
            provider: 'EXTERNAL',
            providerWalletRef: wallet.providerWalletRef,
            status: UserDepositAddressStatus.ACTIVE,
            failureReason: null,
            provisionedAt: new Date(),
          },
        });
        await this.audit.record({
          actorUserId: userId,
          action: 'PERSONAL_DEPOSIT_ADDRESS_PROVISIONED',
          entityType: 'UserDepositAddress',
          entityId: active.id,
          metadata: { network, address, provider: 'EXTERNAL' },
        });
        return this.toResponse(active, target);
      } catch (error) {
        this.logger.warn(
          `Non-EVM deposit address provisioning failed: ${this.safeErrorMessage(error)}`,
        );
        await this.markFailed(row.id, this.safeErrorMessage(error));
        throw new ServiceUnavailableException('Could not provision a personal deposit address');
      }
    }

    const policyId = this.config.get<string>('PRIVY_DEPOSIT_SWEEP_POLICY_ID');
    if (!policyId) {
      await this.markFailed(row.id, 'PRIVY_DEPOSIT_SWEEP_POLICY_ID is not configured');
      throw new ServiceUnavailableException('Personal deposit address provisioning is disabled');
    }

    try {
      const wallet = await this.custody.createOrGetWallet({
        externalId,
        displayName: `Deposit ${network} ${userId.slice(-8)}`,
        policyId,
      });
      const address = getAddress(wallet.address).toLowerCase();
      const active = await this.prisma.userDepositAddress.update({
        where: { id: row.id },
        data: {
          address,
          providerWalletRef: wallet.id,
          policyRef: policyId,
          status: UserDepositAddressStatus.ACTIVE,
          failureReason: null,
          provisionedAt: new Date(),
        },
      });
      await this.audit.record({
        actorUserId: userId,
        action: 'PERSONAL_DEPOSIT_ADDRESS_PROVISIONED',
        entityType: 'UserDepositAddress',
        entityId: active.id,
        metadata: { network, address, provider: 'PRIVY' },
      });
      return this.toResponse(active, target);
    } catch (error) {
      const reason = this.safeErrorMessage(error);
      this.logger.warn(
        `Personal deposit address provisioning failed: ${reason}`,
      );
      await this.markFailed(row.id, reason);
      throw new ServiceUnavailableException('Could not provision a personal deposit address');
    }
  }

  async getExisting(userId: string, assetSymbol: string, networkKey?: string) {
    const target = await this.getEligibleTarget(assetSymbol, networkKey);
    const address = await this.prisma.userDepositAddress.findUnique({
      where: {
        userId_network: { userId, network: target.legacyChain },
      },
    });
    if (!address) {
      throw new NotFoundException('Personal deposit address has not been created');
    }
    if (address.status !== UserDepositAddressStatus.ACTIVE) {
      throw new ServiceUnavailableException(
        `Personal deposit address is ${address.status.toLowerCase()}`,
      );
    }
    return this.toResponse(address, target);
  }

  listAdmin(input: { status?: UserDepositAddressStatus; take?: number } = {}) {
    return this.prisma.userDepositAddress.findMany({
      where: input.status ? { status: input.status } : undefined,
      include: { user: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(input.take ?? 100, 200),
    });
  }

  private async createProvisioningRow(userId: string, network: Chain, externalId: string) {
    try {
      return await this.prisma.userDepositAddress.create({
        data: {
          userId,
          network,
          address: this.placeholderAddress(userId, network),
          externalId,
          status: UserDepositAddressStatus.PROVISIONING,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.userDepositAddress.findUniqueOrThrow({
          where: { userId_network: { userId, network } },
        });
      }
      throw error;
    }
  }

  private markFailed(id: string, failureReason: string) {
    return this.prisma.userDepositAddress.update({
      where: { id },
      data: { status: UserDepositAddressStatus.FAILED, failureReason },
    });
  }

  private async getEligibleTarget(symbol: string, networkKey?: string) {
    const asset = await this.assets.getBySymbol(symbol.toUpperCase());
    const network = await this.resolveNetwork(networkKey);
    if (!network.legacyChain) {
      throw new BadRequestException('Network is missing legacy storage mapping');
    }
    if (!network.depositEnabled) {
      throw new BadRequestException('Deposits are disabled for this network');
    }
    const tokenContract = await this.prisma.tokenContract.findUnique({
      where: {
        assetId_networkId_standard: {
          assetId: asset.id,
          networkId: network.id,
          standard: 'NATIVE',
        },
      },
    }) ?? await this.prisma.tokenContract.findUnique({
      where: {
        assetId_networkId_standard: {
          assetId: asset.id,
          networkId: network.id,
            standard:
              network.family === NetworkFamily.SVM
                ? 'SPL'
                : network.family === NetworkFamily.UTXO
                  ? 'BTC'
                  : network.family === NetworkFamily.TVM
                    ? 'TRC20'
                    : 'ERC20',
        },
      },
    });
    if (!tokenContract?.depositEnabled) {
      throw new BadRequestException('Deposits are disabled for this asset');
    }
    if (
      tokenContract.standard === 'ERC20' &&
      (!tokenContract.address ||
        (!tokenContract.contractVerifiedAt && !asset.contractVerifiedAt) ||
        (!tokenContract.contractCodeHash && !asset.contractCodeHash))
    ) {
      throw new BadRequestException('Deposits are disabled for this asset');
    }
    return {
      asset,
      tokenContract,
      network,
      legacyChain: network.legacyChain,
    };
  }

  private toResponse(
    depositAddress: { id: string; address: string; status: UserDepositAddressStatus },
    target: Awaited<ReturnType<DepositAddressService['getEligibleTarget']>>,
  ) {
    return {
      id: depositAddress.id,
      network: target.network.chainKey,
      networkDisplayName: target.network.displayName,
      networkIconUrl: target.network.iconUrl,
      caip2: target.network.caip2,
      chainId: target.network.chainId,
      address:
        target.network.family === NetworkFamily.EVM
          ? getAddress(depositAddress.address)
          : depositAddress.address,
      asset: {
        symbol: target.asset.symbol,
        name: target.asset.name,
        iconUrl: target.asset.iconUrl,
        tokenAddress: target.tokenContract.address
          ? target.tokenContract.address.startsWith('0x')
            ? getAddress(target.tokenContract.address)
            : target.tokenContract.address
          : null,
        tokenStandard: target.tokenContract.standard,
        decimals: target.tokenContract.decimals,
      },
      requiredConfirmations: target.network.confirmations,
      status: depositAddress.status,
      memo: null,
      tag: null,
      acceptsFromAnyAddress: true,
    };
  }

  private externalId(userId: string, network: Chain): string {
    const digest = createHash('sha256').update(userId).digest('hex').slice(0, 32);
    return `deposit_${network.toLowerCase()}_${digest}`;
  }

  private placeholderAddress(userId: string, network: Chain): string {
    return `pending:${network}:${createHash('sha256').update(userId).digest('hex')}`;
  }

  private async resolveNetwork(networkKey?: string) {
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

  private safeErrorMessage(error: unknown): string {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return `Prisma ${error.code}`;
    }
    if (error instanceof Error) {
      return error.message.replace(/wallet-auth:[A-Za-z0-9+/=:_-]+/g, 'wallet-auth:<redacted>');
    }
    return 'Unknown error';
  }
}
