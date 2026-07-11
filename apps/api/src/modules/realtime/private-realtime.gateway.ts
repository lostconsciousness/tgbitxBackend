import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AccountService } from '../account/account.service';
import { JwtPayload } from '../auth/types/jwt-payload';
import { SessionsService } from '../sessions/sessions.service';
import { PrismaService } from '../../database/prisma.service';
import { HyperliquidExecutionService } from '../hyperliquid/hyperliquid-execution.service';
import { PositionsService } from '../positions/positions.service';
import { Prisma } from '@prisma/client';

type AuthenticatedSocket = Socket & {
  data: {
    userId?: string;
    sessionId?: string;
  };
};

@WebSocketGateway({
  namespace: 'private',
  cors: { origin: true, credentials: true },
})
export class PrivateRealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server!: Server;

  private readonly logger = new Logger(PrivateRealtimeGateway.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sessions: SessionsService,
    private readonly account: AccountService,
    private readonly prisma: PrismaService,
    private readonly hyperliquid: HyperliquidExecutionService,
    private readonly positions: PositionsService,
  ) {}

  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    try {
      const raw =
        client.handshake.auth?.token ??
        client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!raw || typeof raw !== 'string') {
        client.disconnect(true);
        return;
      }
      const payload = await this.jwt.verifyAsync<JwtPayload>(raw, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        issuer: this.config.get<string>('JWT_ISSUER'),
        audience: this.config.get<string>('JWT_AUDIENCE'),
      });
      const session = await this.sessions.findActiveSessionWithUser(payload.sid);
      if (!session || session.userId !== payload.sub) {
        client.disconnect(true);
        return;
      }
      client.data.userId = payload.sub;
      client.data.sessionId = payload.sid;
      await client.join(`user:${payload.sub}`);
      await this.emitSnapshot(client);
      const timer = setInterval(
        () => void this.emitSnapshot(client),
        this.config.get<number>('PRIVATE_WS_SNAPSHOT_MS', 2_000),
      );
      this.timers.set(client.id, timer);
    } catch (error) {
      this.logger.warn(
        `Rejected private socket ${client.id}: ${
          error instanceof Error ? error.message : 'invalid token'
        }`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket): void {
    const timer = this.timers.get(client.id);
    if (timer) {
      clearInterval(timer);
    }
    this.timers.delete(client.id);
  }

  @SubscribeMessage('resync')
  async resync(@ConnectedSocket() client: AuthenticatedSocket) {
    await this.emitSnapshot(client);
    return { ok: true };
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    if (!this.server) {
      return;
    }
    this.server.to(`user:${userId}`).emit(event, payload);
  }

  async notifyUserBalancesUpdated(userId: string): Promise<void> {
    if (!this.server) {
      return;
    }
    const [overview, deposits] = await Promise.all([
      this.account.getOverview(userId),
      this.prisma.deposit.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    this.emitToUser(userId, 'balances', overview.balances);
    this.emitToUser(userId, 'portfolio', overview.portfolio);
    this.emitToUser(userId, 'deposits', deposits);
  }

  private async emitSnapshot(client: AuthenticatedSocket): Promise<void> {
    const userId = client.data.userId;
    if (!userId || !client.connected) {
      return;
    }
    const [
      overview,
      deposits,
      withdrawals,
      orders,
      trades,
      positions,
      liquidations,
    ] =
      await Promise.all([
        this.account.getOverview(userId),
        this.prisma.deposit.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        this.prisma.withdrawal.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        this.prisma.order.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        this.prisma.trade.findMany({
          where: { userId },
          orderBy: { executedAt: 'desc' },
          take: 50,
        }),
        this.positions.listUserPositions(userId),
        this.prisma.liquidationEvent.findMany({
          where: { position: { userId } },
          orderBy: { triggeredAt: 'desc' },
          take: 20,
        }),
      ]);
    client.emit('balances', overview.balances);
    client.emit('portfolio', overview.portfolio);
    client.emit('deposits', deposits);
    client.emit('withdrawals', withdrawals);
    client.emit('orders', orders);
    client.emit('trades', trades);
    client.emit('positions', positions);
    client.emit('liquidations', liquidations);
    client.emit('provider_status', {
      hyperliquidExecutionEnabled: this.hyperliquid.isExecutionEnabled(),
      marketDataProvider: this.config.get<string>('MARKET_DATA_PROVIDER', 'MOCK'),
    });
    const nearLiquidation = positions.filter((position) => {
      if (position.status !== 'OPEN' || !position.maintenanceMargin) {
        return false;
      }
      return new Prisma.Decimal(position.margin)
        .plus(position.unrealizedPnl)
        .lessThanOrEqualTo(new Prisma.Decimal(position.maintenanceMargin).mul('1.5'));
    });
    if (nearLiquidation.length > 0) {
      client.emit('risk_alert', {
        type: 'NEAR_LIQUIDATION',
        positions: nearLiquidation.map((position) => position.id),
      });
    }
  }
}
