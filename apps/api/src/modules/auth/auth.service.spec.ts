import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User, UserRole, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { SessionsService } from '../sessions/sessions.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'trader@example.com',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$placeholder',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    createdAt: new Date('2026-06-08T00:00:00.000Z'),
    updatedAt: new Date('2026-06-08T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AuthService', () => {
  let authService: AuthService;
  let usersService: jest.Mocked<Pick<UsersService, 'findByEmail' | 'createUser'>>;
  let sessionsService: jest.Mocked<Pick<SessionsService, 'createSession' | 'rotateRefreshToken' | 'revokeByRefreshToken'>>;
  let jwtService: jest.Mocked<Pick<JwtService, 'signAsync'>>;

  beforeEach(() => {
    usersService = {
      findByEmail: jest.fn(),
      createUser: jest.fn(),
    };
    sessionsService = {
      createSession: jest.fn(),
      rotateRefreshToken: jest.fn(),
      revokeByRefreshToken: jest.fn(),
    };
    jwtService = {
      signAsync: jest.fn().mockResolvedValue('access-token'),
    };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'JWT_ACCESS_TTL_SECONDS') {
          return 900;
        }
        if (key === 'JWT_ISSUER') {
          return 'dream-crypto-exchange';
        }
        if (key === 'JWT_AUDIENCE') {
          return 'dream-crypto-exchange-api';
        }
        return fallback;
      }),
      getOrThrow: jest.fn((key: string) => {
        if (key === 'JWT_ACCESS_SECRET') {
          return 'test-jwt-secret-at-least-32-chars';
        }
        throw new Error(`Missing config ${key}`);
      }),
    } as unknown as ConfigService;

    authService = new AuthService(
      usersService as unknown as UsersService,
      sessionsService as unknown as SessionsService,
      jwtService as unknown as JwtService,
      config,
    );
  });

  it('registers a user, hashes password, and never returns the password hash', async () => {
    const user = makeUser();
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUser.mockImplementation(async (params) => {
      expect(await argon2.verify(params.passwordHash, 'very-secure-password')).toBe(true);
      return makeUser({ passwordHash: params.passwordHash });
    });
    sessionsService.createSession.mockResolvedValue({
      session: {
        id: 'session-1',
        userId: user.id,
        refreshTokenHash: 'hash',
        userAgent: 'jest',
        ipAddress: '127.0.0.1',
        expiresAt: new Date('2026-07-08T00:00:00.000Z'),
        revokedAt: null,
        lastUsedAt: new Date('2026-06-08T00:00:00.000Z'),
        createdAt: new Date('2026-06-08T00:00:00.000Z'),
        updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      },
      refreshToken: 'session-1.secret',
    });

    const result = await authService.register(
      { email: user.email, password: 'very-secure-password' },
      { userAgent: 'jest', ipAddress: '127.0.0.1' },
    );

    expect(result.user).toEqual({
      id: user.id,
      email: user.email,
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
      createdAt: user.createdAt,
    });
    expect(result).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(result)).not.toContain('very-secure-password');
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('session-1.secret');
  });

  it('rejects duplicate registration emails', async () => {
    usersService.findByEmail.mockResolvedValue(makeUser());

    await expect(
      authService.register(
        { email: 'trader@example.com', password: 'very-secure-password' },
        {},
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('logs in with a valid password', async () => {
    const passwordHash = await argon2.hash('very-secure-password', { type: argon2.argon2id });
    const user = makeUser({ passwordHash });
    usersService.findByEmail.mockResolvedValue(user);
    sessionsService.createSession.mockResolvedValue({
      session: {
        id: 'session-1',
        userId: user.id,
        refreshTokenHash: 'hash',
        userAgent: null,
        ipAddress: null,
        expiresAt: new Date('2026-07-08T00:00:00.000Z'),
        revokedAt: null,
        lastUsedAt: new Date('2026-06-08T00:00:00.000Z'),
        createdAt: new Date('2026-06-08T00:00:00.000Z'),
        updatedAt: new Date('2026-06-08T00:00:00.000Z'),
      },
      refreshToken: 'session-1.secret',
    });

    await expect(
      authService.login({ email: user.email, password: 'very-secure-password' }, {}),
    ).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'session-1.secret',
    });
  });

  it('rejects login with an invalid password', async () => {
    const passwordHash = await argon2.hash('very-secure-password', { type: argon2.argon2id });
    usersService.findByEmail.mockResolvedValue(makeUser({ passwordHash }));

    await expect(
      authService.login({ email: 'trader@example.com', password: 'wrong-password' }, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects suspended users during login', async () => {
    usersService.findByEmail.mockResolvedValue(makeUser({ status: UserStatus.SUSPENDED }));

    await expect(
      authService.login({ email: 'trader@example.com', password: 'very-secure-password' }, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
