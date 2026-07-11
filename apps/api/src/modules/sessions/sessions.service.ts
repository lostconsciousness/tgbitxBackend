import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Session, User, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';

type SessionWithUser = Session & {
  user: User;
};

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createSession(params: {
    userId: string;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<{ session: Session; refreshToken: string }> {
    const secret = this.generateRefreshSecret();
    const refreshTokenHash = await this.hashSecret(secret);
    const expiresAt = this.getRefreshExpiry();

    const session = await this.prisma.session.create({
      data: {
        userId: params.userId,
        refreshTokenHash,
        userAgent: params.userAgent,
        ipAddress: params.ipAddress,
        expiresAt,
      },
    });

    return {
      session,
      refreshToken: this.formatRefreshToken(session.id, secret),
    };
  }

  async rotateRefreshToken(refreshToken: string): Promise<{
    session: Session;
    user: User;
    refreshToken: string;
  }> {
    const { session, secret } = await this.verifyRefreshToken(refreshToken);
    const nextSecret = this.generateRefreshSecret();
    const refreshTokenHash = await this.hashSecret(nextSecret);

    const updatedSession = await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash,
        lastUsedAt: new Date(),
      },
    });

    return {
      session: updatedSession,
      user: session.user,
      refreshToken: this.formatRefreshToken(updatedSession.id, nextSecret),
    };
  }

  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    const { session } = await this.verifyRefreshToken(refreshToken);

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        revokedAt: new Date(),
        lastUsedAt: new Date(),
      },
    });
  }

  async findActiveSessionWithUser(sessionId: string): Promise<SessionWithUser | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });

    if (!session || this.isSessionInactive(session) || session.user.status !== UserStatus.ACTIVE) {
      return null;
    }

    return session;
  }

  private async verifyRefreshToken(refreshToken: string): Promise<{
    session: SessionWithUser;
    secret: string;
  }> {
    const { sessionId, secret } = this.parseRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });

    if (!session || this.isSessionInactive(session) || session.user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const isValid = await argon2.verify(session.refreshTokenHash, secret);
    if (!isValid) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return { session, secret };
  }

  private parseRefreshToken(refreshToken: string): { sessionId: string; secret: string } {
    const separatorIndex = refreshToken.indexOf('.');
    if (separatorIndex <= 0 || separatorIndex === refreshToken.length - 1) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return {
      sessionId: refreshToken.slice(0, separatorIndex),
      secret: refreshToken.slice(separatorIndex + 1),
    };
  }

  private isSessionInactive(session: Pick<Session, 'expiresAt' | 'revokedAt'>): boolean {
    return Boolean(session.revokedAt) || session.expiresAt.getTime() <= Date.now();
  }

  private generateRefreshSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  private formatRefreshToken(sessionId: string, secret: string): string {
    return `${sessionId}.${secret}`;
  }

  private hashSecret(secret: string): Promise<string> {
    return argon2.hash(secret, {
      type: argon2.argon2id,
    });
  }

  private getRefreshExpiry(): Date {
    const ttlDays = this.config.get<number>('JWT_REFRESH_TTL_DAYS', 30);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + ttlDays);
    return expiresAt;
  }
}
