import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import request = require('supertest');
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

const authResponse = {
  user: {
    id: 'user-1',
    email: 'trader@example.com',
    role: UserRole.USER,
    status: UserStatus.ACTIVE,
    createdAt: new Date('2026-06-08T00:00:00.000Z'),
  },
  accessToken: 'access-token',
  refreshToken: 'session-1.secret',
  expiresIn: 900,
};

describe('AuthController', () => {
  let app: INestApplication;
  let authService: jest.Mocked<Pick<AuthService, 'register' | 'login' | 'refresh' | 'logout'>>;

  beforeEach(async () => {
    authService = {
      register: jest.fn().mockResolvedValue(authResponse),
      login: jest.fn().mockResolvedValue(authResponse),
      refresh: jest.fn().mockResolvedValue({
        ...authResponse,
        accessToken: 'next-access-token',
        refreshToken: 'session-1.next-secret',
      }),
      logout: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: authService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          const requestContext = context.switchToHttp().getRequest();
          requestContext.user = {
            id: 'user-1',
            email: 'trader@example.com',
            role: UserRole.USER,
            status: UserStatus.ACTIVE,
            sessionId: 'session-1',
            createdAt: new Date('2026-06-08T00:00:00.000Z'),
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /auth/register returns user and tokens', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .set('user-agent', 'jest-supertest')
      .send({ email: 'TRADER@example.com', password: 'very-secure-password' })
      .expect(201);

    expect(response.body).toMatchObject({
      user: {
        id: 'user-1',
        email: 'trader@example.com',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
      },
      accessToken: 'access-token',
      refreshToken: 'session-1.secret',
      expiresIn: 900,
    });
    expect(authService.register).toHaveBeenCalledWith(
      { email: 'trader@example.com', password: 'very-secure-password' },
      expect.objectContaining({ userAgent: expect.any(String) }),
    );
  });

  it('POST /auth/login rejects invalid payloads before service call', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'bad-email', password: 'short' })
      .expect(400);

    expect(authService.login).not.toHaveBeenCalled();
  });

  it('GET /auth/me returns current authenticated user', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('authorization', 'Bearer access-token')
      .expect(200);

    expect(response.body).toMatchObject({
      id: 'user-1',
      email: 'trader@example.com',
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
    });
  });

  it('POST /auth/refresh rotates refresh token', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('user-agent', 'jest-supertest')
      .send({ refreshToken: 'session-1.secret' })
      .expect(200);

    expect(response.body).toMatchObject({
      accessToken: 'next-access-token',
      refreshToken: 'session-1.next-secret',
    });
    expect(authService.refresh).toHaveBeenCalledWith(
      'session-1.secret',
      expect.objectContaining({ userAgent: expect.any(String) }),
    );
  });

  it('POST /auth/logout revokes refresh token and returns 204', async () => {
    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: 'session-1.secret' })
      .expect(204);

    expect(authService.logout).toHaveBeenCalledWith('session-1.secret');
  });
});
