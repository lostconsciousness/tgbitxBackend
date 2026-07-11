import { ConfigService } from '@nestjs/config';
import {
  Chain,
  Prisma,
  PrismaClient,
  WalletProvider,
  WalletStatus,
  WalletType,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/modules/audit/audit.service';
import { RpcProvider } from '../src/modules/rpc/rpc-provider.interface';
import { WalletsService } from '../src/modules/wallets/wallets.service';

const ADDRESS_1 = '0x1111111111111111111111111111111111111111';
const ADDRESS_2 = '0x2222222222222222222222222222222222222222';

describe('Wallets PostgreSQL integration', () => {
  const prisma = new PrismaClient();
  const userIds: string[] = [];
  let service: WalletsService;

  beforeAll(async () => {
    await prisma.$connect();
    service = createService(new AuditService(prisma as any));
  });

  afterEach(async () => {
    await prisma.auditLog.deleteMany({
      where: { actorUserId: { in: userIds } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: userIds } },
    });
    userIds.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('atomically consumes one nonce and writes one audit record under concurrency', async () => {
    const userId = await createUser();
    const challenge = await service.createSiweNonce({
      userId,
      address: ADDRESS_1,
      origin: 'http://localhost:3000',
    });
    const input = {
      userId,
      address: ADDRESS_1,
      nonce: challenge.nonce,
      signature: `0x${'1'.repeat(130)}`,
      audit: { ipAddress: '127.0.0.1', userAgent: 'integration-test' },
    };

    const results = await Promise.allSettled([
      service.connectWallet(input),
      service.connectWallet(input),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(prisma.wallet.count({ where: { userId } })).resolves.toBe(1);
    await expect(
      prisma.auditLog.count({
        where: { actorUserId: userId, action: 'WALLET_CONNECT' },
      }),
    ).resolves.toBe(1);
  });

  it('rolls back wallet and nonce changes when audit persistence fails', async () => {
    const userId = await createUser();
    const failingService = createService({
      record: jest.fn().mockRejectedValue(new Error('audit unavailable')),
    } as unknown as AuditService);
    const challenge = await failingService.createSiweNonce({
      userId,
      address: ADDRESS_1,
      origin: 'http://localhost:3000',
    });

    await expect(
      failingService.connectWallet({
        userId,
        address: ADDRESS_1,
        nonce: challenge.nonce,
        signature: `0x${'2'.repeat(130)}`,
      }),
    ).rejects.toThrow('audit unavailable');

    await expect(prisma.wallet.count({ where: { userId } })).resolves.toBe(0);
    await expect(
      prisma.walletSiweNonce.findUniqueOrThrow({
        where: { nonce: challenge.nonce },
        select: { usedAt: true },
      }),
    ).resolves.toEqual({ usedAt: null });
  });

  it('enforces lowercase addresses and one active primary/embedded wallet', async () => {
    const userId = await createUser();
    const now = new Date();

    await prisma.wallet.create({
      data: {
        userId,
        chain: Chain.ARBITRUM,
        type: WalletType.EXTERNAL,
        provider: WalletProvider.SIWE,
        address: ADDRESS_1,
        status: WalletStatus.ACTIVE,
        isPrimary: true,
        verifiedAt: now,
      },
    });

    await expect(
      prisma.wallet.create({
        data: {
          userId,
          chain: Chain.ARBITRUM,
          type: WalletType.EXTERNAL,
          provider: WalletProvider.SIWE,
          address: ADDRESS_2,
          status: WalletStatus.ACTIVE,
          isPrimary: true,
          verifiedAt: now,
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    await prisma.wallet.create({
      data: {
        userId,
        chain: Chain.ARBITRUM,
        type: WalletType.EMBEDDED,
        provider: WalletProvider.PRIVY,
        address: '0x3333333333333333333333333333333333333333',
        providerUserRef: `did:privy:${userId}`,
        providerWalletRef: `privy-${randomUUID()}`,
        status: WalletStatus.ACTIVE,
      },
    });

    await expect(
      prisma.wallet.create({
        data: {
          userId,
          chain: Chain.ARBITRUM,
          type: WalletType.EMBEDDED,
          provider: WalletProvider.PRIVY,
          address: '0x4444444444444444444444444444444444444444',
          providerUserRef: `did:privy:${userId}`,
          providerWalletRef: `privy-${randomUUID()}`,
          status: WalletStatus.ACTIVE,
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    await expect(
      prisma.wallet.create({
        data: {
          userId,
          chain: Chain.ARBITRUM,
          type: WalletType.EXTERNAL,
          provider: WalletProvider.SIWE,
          address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          status: WalletStatus.ACTIVE,
        },
      }),
    ).rejects.toThrow(/wallets_address_lowercase_check|check constraint/i);
  });

  function createService(auditService: AuditService): WalletsService {
    return new WalletsService(
      prisma as any,
      {
        get: jest.fn((key: string, fallback?: unknown) => {
          const values: Record<string, unknown> = {
            SIWE_URI: 'http://localhost:3000',
            SIWE_ALLOWED_ORIGINS: 'http://localhost:3000',
            SIWE_CHAIN_ID: 42161,
            SIWE_NONCE_TTL_SECONDS: 600,
            MAX_EXTERNAL_WALLETS: 5,
          };
          return values[key] ?? fallback;
        }),
      } as unknown as ConfigService,
      {
        verifyMessage: jest.fn().mockResolvedValue(true),
      } as unknown as RpcProvider,
      auditService,
    );
  }

  async function createUser(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `wallet-integration-${randomUUID()}@example.com`,
        passwordHash: 'integration-test-only',
      },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  }
});
