import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Chain,
  NetworkFamily,
  Prisma,
  WalletProvider,
  WalletStatus,
  WalletType,
} from '@prisma/client';
import {
  chainFromEvmChainId,
  isSiweEligibleNetworkKey,
  parseEnabledNetworkKeys,
} from '../../common/utils/evm-chain-id';
import { randomBytes } from 'node:crypto';
import { SiweMessage } from 'siwe';
import { getAddress } from 'viem';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RPC_PROVIDER } from '../rpc/rpc.module';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import {
  PrivyWalletNotReadyException,
  SiweNonceExpiredException,
  SiweNonceInvalidException,
  SiweSignatureInvalidException,
  UnsupportedChainException,
  WalletAddressInUseException,
  WalletLimitReachedException,
  WalletNotFoundException,
} from './wallet.errors';
import { toWalletResponse } from './wallet.presenter';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(RPC_PROVIDER) private readonly rpcProvider: RpcProvider,
    private readonly auditService: AuditService,
  ) {}

  async listUserWallets(userId: string) {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId, status: WalletStatus.ACTIVE },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
    return wallets.map(toWalletResponse);
  }

  async listActiveUserWallets(userId: string) {
    const wallets = await this.prisma.wallet.findMany({
      where: {
        userId,
        status: WalletStatus.ACTIVE,
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
    return wallets.map(toWalletResponse);
  }

  async createSiweNonce(input: {
    userId: string;
    address: string;
    chainId?: number;
    origin?: string;
  }) {
    const chainId = input.chainId ?? this.defaultSiweChainId();
    await this.assertSupportedSiweChain(chainId);

    const address = this.normalizeChecksumAddress(input.address);
    const nonce = randomBytes(24).toString('hex');
    const issuedAt = new Date();
    const ttlSeconds = this.config.get<number>('SIWE_NONCE_TTL_SECONDS', 600);
    const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
    const { domain, uri } = this.resolveSiweOrigin(input.origin);
    const message = new SiweMessage({
      domain,
      address,
      statement:
        'Connect this wallet to your Dream Crypto Exchange account. This does not grant spending permissions.',
      uri,
      version: '1',
      chainId,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: expiresAt.toISOString(),
    }).prepareMessage();

    await this.prisma.walletSiweNonce.create({
      data: {
        userId: input.userId,
        address,
        nonce,
        domain,
        uri,
        chainId,
        message,
        issuedAt,
        expiresAt,
      },
    });

    return {
      address,
      nonce,
      message,
      domain,
      uri,
      chainId,
      issuedAt,
      expiresAt,
    };
  }

  async connectWallet(input: {
    userId: string;
    address: string;
    nonce: string;
    signature: string;
    audit?: { ipAddress?: string; userAgent?: string };
  }) {
    const checksumAddress = this.normalizeChecksumAddress(input.address);
    const storageAddress = this.normalizeStorageAddress(input.address);
    const nonceRecord = await this.prisma.walletSiweNonce.findUnique({
      where: { nonce: input.nonce },
    });

    if (
      !nonceRecord ||
      nonceRecord.userId !== input.userId ||
      nonceRecord.address !== checksumAddress ||
      nonceRecord.usedAt
    ) {
      throw new SiweNonceInvalidException();
    }
    if (nonceRecord.expiresAt.getTime() <= Date.now()) {
      throw new SiweNonceExpiredException();
    }

    await this.assertSupportedSiweChain(nonceRecord.chainId);
    const walletChain = this.chainFromChainId(nonceRecord.chainId);

    this.assertSiweMessage(nonceRecord.message, {
      address: checksumAddress,
      nonce: input.nonce,
      domain: nonceRecord.domain,
      uri: nonceRecord.uri,
      chainId: nonceRecord.chainId,
      issuedAt: nonceRecord.issuedAt,
      expiresAt: nonceRecord.expiresAt,
    });

    const signatureValid = await this.rpcProvider.verifyMessage({
      address: checksumAddress,
      message: nonceRecord.message,
      signature: input.signature,
    });
    if (!signatureValid) {
      throw new SiweSignatureInvalidException();
    }

    const wallet = await this.runSerializableTransaction(async (tx) => {
      const consumed = await tx.walletSiweNonce.updateMany({
        where: {
          id: nonceRecord.id,
          userId: input.userId,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw new SiweNonceInvalidException();
      }

      const existing = await tx.wallet.findUnique({
        where: {
          chain_address: {
            chain: walletChain,
            address: storageAddress,
          },
        },
      });
      if (
        existing &&
        existing.userId !== input.userId &&
        existing.status === WalletStatus.ACTIVE
      ) {
        throw new WalletAddressInUseException();
      }

      const hasPrimary = await tx.wallet.count({
        where: {
          userId: input.userId,
          status: WalletStatus.ACTIVE,
          isPrimary: true,
          ...(existing ? { id: { not: existing.id } } : {}),
        },
      });

      if (existing) {
        const transferringFromRevokedAccount =
          existing.userId !== input.userId && existing.status === WalletStatus.REVOKED;
        const updated = await tx.wallet.update({
          where: { id: existing.id },
          data: {
            ...(transferringFromRevokedAccount
              ? {
                  userId: input.userId,
                  type: WalletType.EXTERNAL,
                  provider: WalletProvider.SIWE,
                  providerUserRef: null,
                  providerWalletRef: null,
                  isPrimary: hasPrimary === 0,
                }
              : {
                  isPrimary: existing.isPrimary || hasPrimary === 0,
                }),
            status: WalletStatus.ACTIVE,
            verifiedAt: new Date(),
          },
        });
        await this.recordWalletAudit(tx, 'WALLET_CONNECT', input.userId, updated, input.audit);
        return updated;
      }

      const activeExternalWallets = await tx.wallet.count({
        where: {
          userId: input.userId,
          type: WalletType.EXTERNAL,
          status: WalletStatus.ACTIVE,
        },
      });
      if (
        activeExternalWallets >= this.config.get<number>('MAX_EXTERNAL_WALLETS', 5)
      ) {
        throw new WalletLimitReachedException();
      }

      const created = await tx.wallet.create({
        data: {
          userId: input.userId,
          chain: walletChain,
          type: WalletType.EXTERNAL,
          provider: WalletProvider.SIWE,
          address: storageAddress,
          status: WalletStatus.ACTIVE,
          isPrimary: hasPrimary === 0,
          verifiedAt: new Date(),
        },
      });
      await this.recordWalletAudit(tx, 'WALLET_CONNECT', input.userId, created, input.audit);
      return created;
    });

    return toWalletResponse(wallet);
  }

  async syncEmbeddedWallet(input: {
    userId: string;
    address: string;
    chain?: Chain;
    providerUserRef: string;
    providerWalletRef: string;
    audit?: { ipAddress?: string; userAgent?: string };
  }) {
    const chain = input.chain ?? this.configuredChain();
    this.assertSupportedEmbeddedChain(chain);
    const address = this.normalizeStorageAddressForChain(input.address, chain);
    const wallet = await this.runSerializableTransaction(async (tx) => {
      const [byAddress, byProviderRef, activeEmbedded] = await Promise.all([
        tx.wallet.findUnique({
          where: {
            chain_address: {
              chain,
              address,
            },
          },
        }),
        tx.wallet.findUnique({
          where: { providerWalletRef: input.providerWalletRef },
        }),
        tx.wallet.findFirst({
          where: {
            userId: input.userId,
            chain,
            type: WalletType.EMBEDDED,
            status: WalletStatus.ACTIVE,
          },
        }),
      ]);

      for (const existing of [byAddress, byProviderRef]) {
        if (
          existing &&
          existing.userId !== input.userId &&
          existing.status === WalletStatus.ACTIVE
        ) {
          throw new WalletAddressInUseException();
        }
      }

      const candidate = byProviderRef ?? byAddress;
      if (candidate && candidate.chain !== chain) {
        throw new PrivyWalletNotReadyException('Privy wallet chain does not match linked wallet');
      }
      if (
        candidate &&
        candidate.userId === input.userId &&
        candidate.status === WalletStatus.REVOKED
      ) {
        return candidate;
      }
      if (activeEmbedded && activeEmbedded.id !== candidate?.id) {
        throw new PrivyWalletNotReadyException(
          'An active embedded wallet is already linked to this account',
        );
      }

      const hasPrimary = await tx.wallet.count({
        where: {
          userId: input.userId,
          status: WalletStatus.ACTIVE,
          isPrimary: true,
          ...(candidate ? { id: { not: candidate.id } } : {}),
        },
      });

      if (candidate) {
        const transferringFromRevokedAccount =
          candidate.userId !== input.userId && candidate.status === WalletStatus.REVOKED;
        const updated = await tx.wallet.update({
          where: { id: candidate.id },
          data: {
            ...(transferringFromRevokedAccount
              ? {
                  userId: input.userId,
                  isPrimary: hasPrimary === 0,
                }
              : {
                  isPrimary: candidate.isPrimary || hasPrimary === 0,
                }),
            type: WalletType.EMBEDDED,
            provider: WalletProvider.PRIVY,
            providerUserRef: input.providerUserRef,
            providerWalletRef: input.providerWalletRef,
            status: WalletStatus.ACTIVE,
            verifiedAt: new Date(),
          },
        });
        await this.recordWalletAudit(
          tx,
          'WALLET_EMBEDDED_SYNC',
          input.userId,
          updated,
          input.audit,
        );
        return updated;
      }

      const created = await tx.wallet.create({
        data: {
          userId: input.userId,
          chain,
          type: WalletType.EMBEDDED,
          provider: WalletProvider.PRIVY,
          address,
          providerUserRef: input.providerUserRef,
          providerWalletRef: input.providerWalletRef,
          status: WalletStatus.ACTIVE,
          isPrimary: hasPrimary === 0,
          verifiedAt: new Date(),
        },
      });
      await this.recordWalletAudit(
        tx,
        'WALLET_EMBEDDED_SYNC',
        input.userId,
        created,
        input.audit,
      );
      return created;
    });

    return toWalletResponse(wallet);
  }

  async setPrimaryWallet(
    userId: string,
    walletId: string,
    audit?: { ipAddress?: string; userAgent?: string },
  ) {
    const wallet = await this.runSerializableTransaction(async (tx) => {
      const existing = await tx.wallet.findFirst({
        where: {
          id: walletId,
          userId,
          status: WalletStatus.ACTIVE,
        },
      });
      if (!existing) {
        throw new WalletNotFoundException();
      }

      await tx.wallet.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false },
      });
      const updated = await tx.wallet.update({
        where: { id: existing.id },
        data: { isPrimary: true },
      });
      await this.recordWalletAudit(tx, 'WALLET_SET_PRIMARY', userId, updated, audit);
      return updated;
    });

    return toWalletResponse(wallet);
  }

  async revokeWallet(
    userId: string,
    walletId: string,
    audit?: { ipAddress?: string; userAgent?: string },
  ) {
    const wallet = await this.runSerializableTransaction(async (tx) => {
      const existing = await tx.wallet.findFirst({
        where: { id: walletId, userId },
      });
      if (!existing) {
        throw new WalletNotFoundException();
      }

      const wasPrimary = existing.isPrimary;
      const revoked = await tx.wallet.update({
        where: { id: existing.id },
        data: {
          status: WalletStatus.REVOKED,
          isPrimary: false,
        },
      });

      if (wasPrimary) {
        const replacement = await tx.wallet.findFirst({
          where: {
            userId,
            status: WalletStatus.ACTIVE,
            id: { not: existing.id },
          },
          orderBy: [{ verifiedAt: 'desc' }, { createdAt: 'asc' }],
        });
        if (replacement) {
          await tx.wallet.update({
            where: { id: replacement.id },
            data: { isPrimary: true },
          });
        }
      }

      await this.recordWalletAudit(tx, 'WALLET_REVOKE', userId, revoked, audit);
      return revoked;
    });

    return toWalletResponse(wallet);
  }

  async listSupportedSiweNetworks() {
    const enabledKeys = parseEnabledNetworkKeys(
      this.config.get<string>('MAINNET_ENABLED_NETWORKS'),
    );
    const mainnetOnly =
      this.config.get<boolean>('DISPLAY_MAINNET_ONLY', false) ||
      this.config.get<boolean>('MAINNET_ENABLED', false);

    const networks = await this.prisma.network.findMany({
      where: {
        family: NetworkFamily.EVM,
        chainId: { not: null },
        ...(mainnetOnly ? { mainnet: true } : {}),
        ...(enabledKeys.size > 0 ? { chainKey: { in: [...enabledKeys] } } : {}),
      },
      orderBy: [{ mainnet: 'desc' }, { chainKey: 'asc' }],
    });

    return networks.filter(
      (network) =>
        network.chainId !== null &&
        isSiweEligibleNetworkKey(network.chainKey) &&
        chainFromEvmChainId(network.chainId) !== null,
    );
  }

  async getSupportedSiweChainIds(): Promise<number[]> {
    const networks = await this.listSupportedSiweNetworks();
    if (networks.length > 0) {
      return [...new Set(networks.map((network) => network.chainId!))];
    }
    return [this.defaultSiweChainId()];
  }

  async getExternalWalletCapabilities() {
    const siweNetworks = await this.listSupportedSiweNetworks();
    const fallbackChainId = this.defaultSiweChainId();
    const defaultChainId = siweNetworks.some((network) => network.chainId === fallbackChainId)
      ? fallbackChainId
      : siweNetworks[0]?.chainId ?? fallbackChainId;
    const defaultNetwork =
      siweNetworks.find((network) => network.chainId === defaultChainId) ?? siweNetworks[0];

    return {
      chain: {
        name: defaultNetwork?.displayName ?? 'EVM',
        chainId: defaultChainId,
      },
      siweChains: siweNetworks.map((network) => ({
        network: network.chainKey,
        displayName: network.displayName,
        caip2: network.caip2,
        chainId: network.chainId!,
        mainnet: network.mainnet,
      })),
    };
  }

  async findActiveWalletByAddress(address: string) {
    const normalized = this.normalizeStorageAddress(address);
    return this.prisma.wallet.findUnique({
      where: {
        chain_address: {
          chain: this.configuredChain(),
          address: normalized,
        },
      },
    }).then((wallet) => (wallet?.status === WalletStatus.ACTIVE ? wallet : null));
  }

  private assertSiweMessage(
    rawMessage: string,
    expected: {
      address: string;
      nonce: string;
      domain: string;
      uri: string;
      chainId: number;
      issuedAt: Date;
      expiresAt: Date;
    },
  ): void {
    let message: SiweMessage;
    try {
      message = new SiweMessage(rawMessage);
    } catch (_error) {
      throw new SiweNonceInvalidException();
    }

    const valid =
      message.version === '1' &&
      message.address === expected.address &&
      message.nonce === expected.nonce &&
      message.domain === expected.domain &&
      message.uri === expected.uri &&
      this.isSiweOriginAllowed(message.uri, message.domain) &&
      message.chainId === expected.chainId &&
      new Date(message.issuedAt ?? 0).getTime() === expected.issuedAt.getTime() &&
      new Date(message.expirationTime ?? 0).getTime() === expected.expiresAt.getTime();

    if (!valid) {
      throw new SiweNonceInvalidException();
    }
  }

  private defaultSiweChainId(): number {
    return this.config.get<number>('SIWE_CHAIN_ID', 421614);
  }

  private async assertSupportedSiweChain(chainId: number): Promise<void> {
    const supported = await this.getSupportedSiweChainIds();
    if (!supported.includes(chainId)) {
      throw new UnsupportedChainException();
    }
  }

  private chainFromChainId(chainId: number): Chain {
    const chain = chainFromEvmChainId(chainId);
    if (!chain) {
      throw new UnsupportedChainException();
    }
    return chain;
  }

  private configuredChain(): Chain {
    return chainFromEvmChainId(this.defaultSiweChainId()) ?? Chain.ARBITRUM_SEPOLIA;
  }

  private normalizeChecksumAddress(address: string): string {
    try {
      return getAddress(address);
    } catch (_error) {
      throw new BadRequestException('Invalid wallet address');
    }
  }

  private normalizeStorageAddress(address: string): string {
    return this.normalizeChecksumAddress(address).toLowerCase();
  }

  private normalizeStorageAddressForChain(address: string, chain: Chain): string {
    const trimmed = address.trim();
    if (chain === Chain.SOLANA) {
      try {
        const module = require('bs58');
        const base58 = module.default ?? module;
        const decoded = base58.decode(trimmed);
        if (decoded.length !== 32 || base58.encode(decoded) !== trimmed) {
          throw new Error('Non-canonical Solana address');
        }
        return trimmed;
      } catch (_error) {
        throw new BadRequestException('Invalid Solana wallet address');
      }
    }
    if (chain === Chain.TRON) {
      const tronModule = require('tronweb');
      const TronWeb = tronModule.TronWeb ?? tronModule.default ?? tronModule;
      if (!TronWeb.isAddress(trimmed)) {
        throw new BadRequestException('Invalid Tron wallet address');
      }
      return trimmed;
    }
    return this.normalizeStorageAddress(trimmed);
  }

  private assertSupportedEmbeddedChain(chain: Chain): void {
    if (![this.configuredChain(), Chain.SOLANA, Chain.TRON].includes(chain)) {
      throw new BadRequestException('Unsupported Privy embedded wallet chain');
    }
  }

  private resolveSiweOrigin(origin?: string): { domain: string; uri: string } {
    const fallback = this.config.get<string>('SIWE_URI', 'http://localhost:3000');
    const requested = origin ?? fallback;
    let parsed: URL;
    try {
      parsed = new URL(requested);
    } catch (_error) {
      throw new BadRequestException('Invalid SIWE origin');
    }

    if (!this.isSiweOriginAllowed(parsed.origin, parsed.host)) {
      throw new BadRequestException('SIWE origin is not allowed');
    }

    return {
      domain: parsed.host,
      uri: parsed.origin,
    };
  }

  private isSiweOriginAllowed(uri: string, domain: string): boolean {
    const fallback = this.config.get<string>('SIWE_URI', 'http://localhost:3000');
    const allowed = this.config
      .get<string>('SIWE_ALLOWED_ORIGINS', fallback)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    return allowed.some((value) => {
      try {
        const parsed = new URL(value);
        return parsed.origin === uri && parsed.host === domain;
      } catch (_error) {
        return false;
      }
    });
  }

  private recordWalletAudit(
    tx: Prisma.TransactionClient,
    action: string,
    userId: string,
    wallet: {
      id: string;
      address: string;
      chain: Chain;
      type: WalletType;
      provider: WalletProvider;
    },
    metadata?: { ipAddress?: string; userAgent?: string },
  ) {
    return this.auditService.record(
      {
        actorUserId: userId,
        action,
        entityType: 'Wallet',
        entityId: wallet.id,
        metadata: {
          address: wallet.address,
          chain: wallet.chain,
          type: wallet.type,
          provider: wallet.provider,
        },
        ...metadata,
      },
      tx,
    );
  }

  private async runSerializableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (this.isRetryableTransactionError(error) && attempt === 0) {
          continue;
        }
        if (this.isWalletUniqueConflict(error)) {
          throw new WalletAddressInUseException();
        }
        throw error;
      }
    }

    throw new BadRequestException('Wallet transaction failed');
  }

  private isRetryableTransactionError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
  }

  private isWalletUniqueConflict(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
