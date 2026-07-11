import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Chain,
  WalletProvider,
  WalletStatus,
  WalletType,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import {
  SiweNonceExpiredException,
  SiweNonceInvalidException,
  SiweSignatureInvalidException,
  UnsupportedChainException,
  WalletAddressInUseException,
  WalletLimitReachedException,
} from './wallet.errors';
import { WalletsService } from './wallets.service';

const ADDRESS_1 = '0x1111111111111111111111111111111111111111';
const ADDRESS_2 = '0x2222222222222222222222222222222222222222';
const ADDRESS_6 = '0x6666666666666666666666666666666666666666';

type StoredNonce = {
  id: string;
  userId: string;
  address: string;
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  message: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};

type StoredWallet = {
  id: string;
  userId: string;
  chain: Chain;
  type: WalletType;
  provider: WalletProvider;
  address: string;
  providerUserRef: string | null;
  providerWalletRef: string | null;
  label: string | null;
  status: WalletStatus;
  isPrimary: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

describe('WalletsService', () => {
  let nonces: StoredNonce[];
  let wallets: StoredWallet[];
  let rpcProvider: jest.Mocked<Pick<RpcProvider, 'verifyMessage'>>;
  let service: WalletsService;

  beforeEach(() => {
    nonces = [];
    wallets = [];
    rpcProvider = {
      verifyMessage: jest.fn().mockResolvedValue(true),
    };

    service = new WalletsService(
      createPrismaMock(),
      createConfigMock(),
      rpcProvider as unknown as RpcProvider,
      {
        record: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      } as unknown as AuditService,
    );
  });

  it('connects a valid external wallet and makes the first wallet primary', async () => {
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_1,
      chainId: 42161,
    });

    const wallet = await service.connectWallet({
      userId: 'user-1',
      address: ADDRESS_1,
      nonce: challenge.nonce,
      signature: `0x${'1'.repeat(130)}`,
    });

    expect(wallet).toMatchObject({
      address: ADDRESS_1,
      type: WalletType.EXTERNAL,
      provider: WalletProvider.SIWE,
      status: WalletStatus.ACTIVE,
      isPrimary: true,
    });
  });

  it('rejects unsupported chains before creating a challenge', async () => {
    await expect(
      service.createSiweNonce({
        userId: 'user-1',
        address: ADDRESS_1,
        chainId: 999_999,
      }),
    ).rejects.toBeInstanceOf(UnsupportedChainException);
  });

  it('accepts any configured enabled EVM chain for SIWE', async () => {
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_1,
      chainId: 1,
    });

    expect(challenge.chainId).toBe(1);
  });

  it('builds SIWE challenges for an explicitly allowed frontend origin', async () => {
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_1,
      origin: 'https://frontend.example',
    });

    expect(challenge).toMatchObject({
      domain: 'frontend.example',
      uri: 'https://frontend.example',
    });
  });

  it('rejects a frontend origin outside the SIWE allowlist', async () => {
    await expect(
      service.createSiweNonce({
        userId: 'user-1',
        address: ADDRESS_1,
        origin: 'https://evil.example',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid signature without consuming the nonce', async () => {
    rpcProvider.verifyMessage.mockResolvedValue(false);
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_1,
    });

    await expect(
      service.connectWallet({
        userId: 'user-1',
        address: ADDRESS_1,
        nonce: challenge.nonce,
        signature: `0x${'2'.repeat(130)}`,
      }),
    ).rejects.toBeInstanceOf(SiweSignatureInvalidException);

    expect(nonces[0]?.usedAt).toBeNull();
  });

  it('rejects replay of a consumed nonce', async () => {
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_1,
    });
    const input = {
      userId: 'user-1',
      address: ADDRESS_1,
      nonce: challenge.nonce,
      signature: `0x${'3'.repeat(130)}`,
    };

    await service.connectWallet(input);

    await expect(service.connectWallet(input)).rejects.toBeInstanceOf(
      SiweNonceInvalidException,
    );
  });

  it('rejects an expired nonce', async () => {
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_1,
    });
    if (nonces[0]) {
      nonces[0].expiresAt = new Date(Date.now() - 1);
    }

    await expect(
      service.connectWallet({
        userId: 'user-1',
        address: ADDRESS_1,
        nonce: challenge.nonce,
        signature: `0x${'7'.repeat(130)}`,
      }),
    ).rejects.toBeInstanceOf(SiweNonceExpiredException);
  });

  it('rejects a SIWE message with a mismatched domain', async () => {
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_1,
    });
    if (nonces[0]) {
      nonces[0].message = nonces[0].message.replace(
        'localhost:3000 wants',
        'evil.example wants',
      );
    }

    await expect(
      service.connectWallet({
        userId: 'user-1',
        address: ADDRESS_1,
        nonce: challenge.nonce,
        signature: `0x${'8'.repeat(130)}`,
      }),
    ).rejects.toBeInstanceOf(SiweNonceInvalidException);
  });

  it('allows only one of two parallel requests to consume the same nonce', async () => {
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_1,
    });
    const input = {
      userId: 'user-1',
      address: ADDRESS_1,
      nonce: challenge.nonce,
      signature: `0x${'4'.repeat(130)}`,
    };

    const results = await Promise.allSettled([
      service.connectWallet(input),
      service.connectWallet(input),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('does not link an address owned by another user', async () => {
    wallets.push(createWallet({ userId: 'user-2', address: ADDRESS_1 }));
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_1,
    });

    await expect(
      service.connectWallet({
        userId: 'user-1',
        address: ADDRESS_1,
        nonce: challenge.nonce,
        signature: `0x${'5'.repeat(130)}`,
      }),
    ).rejects.toBeInstanceOf(WalletAddressInUseException);
  });

  it('allows linking an address revoked on another account', async () => {
    wallets.push(
      createWallet({
        id: 'wallet-revoked',
        userId: 'user-2',
        address: ADDRESS_1,
        status: WalletStatus.REVOKED,
        isPrimary: false,
      }),
    );
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_1,
    });

    const wallet = await service.connectWallet({
      userId: 'user-1',
      address: ADDRESS_1,
      nonce: challenge.nonce,
      signature: `0x${'9'.repeat(130)}`,
    });

    expect(wallet).toMatchObject({
      address: ADDRESS_1,
      status: WalletStatus.ACTIVE,
      isPrimary: true,
    });
    expect(wallets).toHaveLength(1);
    expect(wallets[0]).toMatchObject({
      id: 'wallet-revoked',
      userId: 'user-1',
      status: WalletStatus.ACTIVE,
    });
  });

  it('enforces the active external wallet limit', async () => {
    for (let index = 1; index <= 5; index += 1) {
      wallets.push(
        createWallet({
          id: `wallet-${index}`,
          address: `0x${index.toString(16).padStart(40, '0')}`,
        }),
      );
    }
    const challenge = await service.createSiweNonce({
      userId: 'user-1',
      address: ADDRESS_6,
    });

    await expect(
      service.connectWallet({
        userId: 'user-1',
        address: ADDRESS_6,
        nonce: challenge.nonce,
        signature: `0x${'6'.repeat(130)}`,
      }),
    ).rejects.toBeInstanceOf(WalletLimitReachedException);
  });

  it('syncs a Privy wallet idempotently', async () => {
    const input = {
      userId: 'user-1',
      address: ADDRESS_1,
      providerUserRef: 'did:privy:user-1',
      providerWalletRef: 'privy-wallet-1',
    };

    const first = await service.syncEmbeddedWallet(input);
    const second = await service.syncEmbeddedWallet(input);

    expect(first.id).toBe(second.id);
    expect(wallets).toHaveLength(1);
    expect(second).toMatchObject({
      type: WalletType.EMBEDDED,
      provider: WalletProvider.PRIVY,
      isPrimary: true,
    });
  });

  it('preserves case-sensitive Solana and Tron Privy addresses', async () => {
    const solana = await service.syncEmbeddedWallet({
      userId: 'user-1',
      chain: Chain.SOLANA,
      address: '11111111111111111111111111111111',
      providerUserRef: 'did:privy:user-1',
      providerWalletRef: 'privy-solana-1',
    });
    const tron = await service.syncEmbeddedWallet({
      userId: 'user-1',
      chain: Chain.TRON,
      address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      providerUserRef: 'did:privy:user-1',
      providerWalletRef: 'privy-tron-1',
    });

    expect(solana).toMatchObject({
      chain: Chain.SOLANA,
      address: '11111111111111111111111111111111',
    });
    expect(tron).toMatchObject({
      chain: Chain.TRON,
      address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    });
  });

  it('moves primary status and selects a replacement when revoked', async () => {
    const first = createWallet({ id: 'wallet-1', address: ADDRESS_1, isPrimary: true });
    const second = createWallet({ id: 'wallet-2', address: ADDRESS_2 });
    wallets.push(first, second);

    await service.setPrimaryWallet('user-1', second.id);
    expect(wallets.find((wallet) => wallet.id === second.id)?.isPrimary).toBe(true);

    await service.revokeWallet('user-1', second.id);
    expect(wallets.find((wallet) => wallet.id === first.id)?.isPrimary).toBe(true);
    expect(wallets.find((wallet) => wallet.id === second.id)?.status).toBe(
      WalletStatus.REVOKED,
    );
  });

  function createConfigMock(): ConfigService {
    const values: Record<string, unknown> = {
      SIWE_DOMAIN: 'localhost:3000',
      SIWE_URI: 'http://localhost:3000',
      SIWE_CHAIN_ID: 42161,
      SIWE_NONCE_TTL_SECONDS: 600,
      SIWE_ALLOWED_ORIGINS: 'http://localhost:3000,https://frontend.example',
      MAX_EXTERNAL_WALLETS: 5,
      MAINNET_ENABLED: true,
      MAINNET_ENABLED_NETWORKS: 'ethereum,arbitrum,base',
    };
    return {
      get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    } as unknown as ConfigService;
  }

  function createPrismaMock(): PrismaService {
    const walletMatches = (wallet: StoredWallet, where: Record<string, any>): boolean => {
      if (where.id && typeof where.id === 'string' && wallet.id !== where.id) return false;
      if (where.userId && wallet.userId !== where.userId) return false;
      if (where.chain && wallet.chain !== where.chain) return false;
      if (where.type && wallet.type !== where.type) return false;
      if (where.status && wallet.status !== where.status) return false;
      if (where.isPrimary !== undefined && wallet.isPrimary !== where.isPrimary) return false;
      if (where.id?.not && wallet.id === where.id.not) return false;
      return true;
    };

    const prisma: Record<string, any> = {
      network: {
        findMany: jest.fn(() =>
          Promise.resolve([
            {
              chainKey: 'ethereum',
              displayName: 'Ethereum',
              caip2: 'eip155:1',
              chainId: 1,
              mainnet: true,
              family: 'EVM',
              legacyChain: Chain.ETHEREUM,
            },
            {
              chainKey: 'arbitrum',
              displayName: 'Arbitrum One',
              caip2: 'eip155:42161',
              chainId: 42161,
              mainnet: true,
              family: 'EVM',
              legacyChain: Chain.ARBITRUM,
            },
            {
              chainKey: 'base',
              displayName: 'Base',
              caip2: 'eip155:8453',
              chainId: 8453,
              mainnet: true,
              family: 'EVM',
              legacyChain: Chain.BASE,
            },
          ]),
        ),
      },
      walletSiweNonce: {
        create: jest.fn(({ data }) => {
          const record: StoredNonce = {
            id: `nonce-${nonces.length + 1}`,
            usedAt: null,
            createdAt: new Date(),
            ...data,
          };
          nonces.push(record);
          return Promise.resolve(record);
        }),
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(nonces.find((record) => record.nonce === where.nonce) ?? null),
        ),
        updateMany: jest.fn(({ where, data }) => {
          const record = nonces.find((candidate) => candidate.id === where.id);
          if (
            !record ||
            record.userId !== where.userId ||
            record.usedAt ||
            record.expiresAt <= where.expiresAt.gt
          ) {
            return Promise.resolve({ count: 0 });
          }
          Object.assign(record, data);
          return Promise.resolve({ count: 1 });
        }),
      },
      wallet: {
        findMany: jest.fn(({ where }) =>
          Promise.resolve(wallets.filter((wallet) => wallet.userId === where.userId)),
        ),
        findUnique: jest.fn(({ where }) => {
          if (where.chain_address) {
            return Promise.resolve(
              wallets.find(
                (wallet) =>
                  wallet.chain === where.chain_address.chain &&
                  wallet.address === where.chain_address.address,
              ) ?? null,
            );
          }
          if (where.providerWalletRef) {
            return Promise.resolve(
              wallets.find(
                (wallet) => wallet.providerWalletRef === where.providerWalletRef,
              ) ?? null,
            );
          }
          return Promise.resolve(null);
        }),
        findFirst: jest.fn(({ where }) =>
          Promise.resolve(wallets.find((wallet) => walletMatches(wallet, where)) ?? null),
        ),
        count: jest.fn(({ where }) =>
          Promise.resolve(wallets.filter((wallet) => walletMatches(wallet, where)).length),
        ),
        create: jest.fn(({ data }) => {
          const wallet = createWallet({
            id: `wallet-${wallets.length + 1}`,
            providerUserRef: null,
            providerWalletRef: null,
            label: null,
            verifiedAt: null,
            ...data,
          });
          wallets.push(wallet);
          return Promise.resolve(wallet);
        }),
        update: jest.fn(({ where, data }) => {
          const wallet = wallets.find((candidate) => candidate.id === where.id);
          if (!wallet) throw new Error('wallet not found');
          Object.assign(wallet, data, { updatedAt: new Date() });
          return Promise.resolve(wallet);
        }),
        updateMany: jest.fn(({ where, data }) => {
          const matches = wallets.filter((wallet) => walletMatches(wallet, where));
          matches.forEach((wallet) => Object.assign(wallet, data, { updatedAt: new Date() }));
          return Promise.resolve({ count: matches.length });
        }),
      },
    };
    prisma.$transaction = jest.fn((operation) => operation(prisma));
    return prisma as unknown as PrismaService;
  }

  function createWallet(overrides: Partial<StoredWallet>): StoredWallet {
    return {
      id: overrides.id ?? `wallet-${wallets.length + 1}`,
      userId: 'user-1',
      chain: Chain.ARBITRUM,
      type: WalletType.EXTERNAL,
      provider: WalletProvider.SIWE,
      address: ADDRESS_1,
      providerUserRef: null,
      providerWalletRef: null,
      label: null,
      status: WalletStatus.ACTIVE,
      isPrimary: false,
      verifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }
});
