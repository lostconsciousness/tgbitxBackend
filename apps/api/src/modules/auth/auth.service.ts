import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { SessionsService } from '../sessions/sessions.service';
import { toUserResponse } from '../users/user.presenter';
import { UsersService } from '../users/users.service';
import { AuthResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './types/jwt-payload';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly sessionsService: SessionsService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(
    dto: RegisterDto,
    metadata: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResponseDto> {
    const existingUser = await this.usersService.findByEmail(dto.email);
    if (existingUser) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });
    const user = await this.usersService.createUser({
      email: dto.email,
      passwordHash,
    });

    return this.issueTokens(user, metadata);
  }

  async login(
    dto: LoginDto,
    metadata: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResponseDto> {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    this.assertCanAuthenticate(user);

    const passwordMatches = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.issueTokens(user, metadata);
  }

  async refresh(
    refreshToken: string,
    metadata: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResponseDto> {
    const rotated = await this.sessionsService.rotateRefreshToken(refreshToken);

    return this.createAuthResponse(rotated.user, rotated.session.id, rotated.refreshToken);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.sessionsService.revokeByRefreshToken(refreshToken);
  }

  private async issueTokens(
    user: User,
    metadata: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResponseDto> {
    this.assertCanAuthenticate(user);

    const { session, refreshToken } = await this.sessionsService.createSession({
      userId: user.id,
      userAgent: metadata.userAgent,
      ipAddress: metadata.ipAddress,
    });

    return this.createAuthResponse(user, session.id, refreshToken);
  }

  private async createAuthResponse(
    user: User,
    sessionId: string,
    refreshToken: string,
  ): Promise<AuthResponseDto> {
    const expiresIn = this.config.get<number>('JWT_ACCESS_TTL_SECONDS', 900);
    const payload: JwtPayload = {
      sub: user.id,
      sid: sessionId,
      email: user.email,
      role: user.role,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn,
      issuer: this.config.get<string>('JWT_ISSUER'),
      audience: this.config.get<string>('JWT_AUDIENCE'),
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });

    return {
      user: toUserResponse(user),
      accessToken,
      refreshToken,
      expiresIn,
    };
  }

  private assertCanAuthenticate(user: Pick<User, 'status'>): void {
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('User is not active');
    }
  }
}
