import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Session, User, UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { SessionsService } from './sessions.service';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'trader@example.com',
    passwordHash: 'hash',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    createdAt: new Date('2026-06-08T00:00:00.000Z'),
    updatedAt: new Date('2026-06-08T00:00:00.000Z'),
    ...overrides,
  };
}

describe('SessionsService', () => {
  let service: SessionsService;
  let currentUser: User;
  let sessions: Map<string, Session>;
  let sessionCounter: number;

  beforeEach(() => {
    currentUser = makeUser();
    sessions = new Map<string, Session>();
    sessionCounter = 0;

    const prisma = {
      session: {
        create: jest.fn(async ({ data }) => {
          sessionCounter += 1;
          const now = new Date('2026-06-08T00:00:00.000Z');
          const session: Session = {
            id: `session-${sessionCounter}`,
            userId: data.userId,
            refreshTokenHash: data.refreshTokenHash,
            userAgent: data.userAgent ?? null,
            ipAddress: data.ipAddress ?? null,
            expiresAt: data.expiresAt,
            revokedAt: null,
            lastUsedAt: now,
            createdAt: now,
            updatedAt: now,
          };
          sessions.set(session.id, session);
          return session;
        }),
        findUnique: jest.fn(async ({ where }) => {
          const session = sessions.get(where.id);
          return session ? { ...session, user: currentUser } : null;
        }),
        update: jest.fn(async ({ where, data }) => {
          const session = sessions.get(where.id);
          if (!session) {
            throw new Error('Session not found');
          }
          const updatedSession: Session = {
            ...session,
            ...data,
            updatedAt: new Date('2026-06-08T00:00:00.000Z'),
          };
          sessions.set(updatedSession.id, updatedSession);
          return updatedSession;
        }),
      },
    } as unknown as PrismaService;

    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'JWT_REFRESH_TTL_DAYS') {
          return 30;
        }
        return fallback;
      }),
    } as unknown as ConfigService;

    service = new SessionsService(prisma, config);
  });

  it('stores only a hash of the refresh token secret', async () => {
    const result = await service.createSession({ userId: currentUser.id });
    const session = sessions.get(result.session.id);
    const [, secret] = result.refreshToken.split('.');

    expect(session?.refreshTokenHash).toBeDefined();
    expect(session?.refreshTokenHash).not.toBe(secret);
    expect(session?.refreshTokenHash).not.toContain(secret);
  });

  it('rotates refresh tokens and rejects the old token after rotation', async () => {
    const initial = await service.createSession({ userId: currentUser.id });
    const rotated = await service.rotateRefreshToken(initial.refreshToken);

    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    await expect(service.rotateRefreshToken(initial.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.rotateRefreshToken(rotated.refreshToken)).resolves.toBeDefined();
  });

  it('revokes a refresh token session on logout', async () => {
    const initial = await service.createSession({ userId: currentUser.id });

    await service.revokeByRefreshToken(initial.refreshToken);

    expect(sessions.get(initial.session.id)?.revokedAt).toBeInstanceOf(Date);
    await expect(service.rotateRefreshToken(initial.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects refresh tokens for suspended users', async () => {
    const initial = await service.createSession({ userId: currentUser.id });
    currentUser = makeUser({ status: UserStatus.SUSPENDED });

    await expect(service.rotateRefreshToken(initial.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
