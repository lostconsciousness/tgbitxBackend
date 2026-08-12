import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
import {
  UserUpdate,
  UserUpdatesService,
} from '../user-updates/user-updates.service';

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
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  private server!: Server;

  private readonly logger = new Logger(PrivateRealtimeGateway.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly userUpdateTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingUserUpdates = new Map<string, Set<string>>();
  private unsubscribeUserUpdates?: () => void;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sessions: SessionsService,
    private readonly account: AccountService,
    private readonly prisma: PrismaService,
    private readonly hyperliquid: HyperliquidExecutionService,
    private readonly positions: PositionsService,
    private readonly userUpdates: UserUpdatesService,
  ) {}

  onModuleInit(): void {
    this.unsubscribeUserUpdates = this.userUpdates.subscribe((update) =>
      this.queueUserUpdate(update),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribeUserUpdates?.();
    for (const timer of this.timers.values()) clearInterval(timer);
    for (const timer of this.userUpdateTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.userUpdateTimers.clear();
    this.pendingUserUpdates.clear();
  }

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
      this.logger.log(`Private socket connected: ${client.id}`);
      await this.emitSnapshotSafely(client, 'initial');
      const timer = setInterval(
        () => void this.emitSnapshotSafely(client, 'fallback'),
        Math.max(
          10_000,
          this.config.get<number>('PRIVATE_WS_FALLBACK_SNAPSHOT_MS', 30_000),
        ),
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
    this.logger.log(`Private socket disconnected: ${client.id}`);
  }

  @SubscribeMessage('resync')
  async resync(@ConnectedSocket() client: AuthenticatedSocket) {
    return { ok: await this.emitSnapshotSafely(client, 'client-resync') };
  }

  emitToUser(userId: string, event: string, payload: unknown): void {
    if (!this.server) {
      return;
    }
    this.server.to(`user:${userId}`).emit(event, this.toRealtimePayload(payload));
  }

  private emitToClient(
    client: AuthenticatedSocket,
    event: string,
    payload: unknown,
  ): void {
    client.emit(event, this.toRealtimePayload(payload));
  }

  private toRealtimePayload(payload: unknown): unknown {
    const serialized = JSON.stringify(
      payload,
      (_key, value) => typeof value === 'bigint' ? value.toString() : value,
    );
    return serialized === undefined ? null : JSON.parse(serialized);
  }

  async notifyUserBalancesUpdated(userId: string): Promise<void> {
    this.userUpdates.publish(userId, ['balances', 'deposits']);
  }

  private queueUserUpdate(update: UserUpdate): void {
    const kinds = this.pendingUserUpdates.get(update.userId) ?? new Set<string>();
    for (const kind of update.kinds) kinds.add(kind);
    this.pendingUserUpdates.set(update.userId, kinds);
    if (this.userUpdateTimers.has(update.userId)) return;
    const timer = setTimeout(() => {
      this.userUpdateTimers.delete(update.userId);
      const pending = this.pendingUserUpdates.get(update.userId) ?? new Set<string>();
      this.pendingUserUpdates.delete(update.userId);
      void this.emitUserUpdate(update.userId, pending).catch((error) =>
        this.logger.warn(
          `Realtime user update failed for ${update.userId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        ),
      );
    }, this.config.get<number>('PRIVATE_WS_EVENT_DEBOUNCE_MS', 25));
    this.userUpdateTimers.set(update.userId, timer);
  }

  private async emitUserUpdate(userId: string, kinds: Set<string>): Promise<void> {
    if (!this.server) return;
    this.account.invalidateOverviewCache(userId);
    const failedSections: string[] = [];
    const tasks: Promise<void>[] = [];
    const emitWhenReady = <T>(
      section: string,
      operation: Promise<T>,
      emit: (value: T) => void,
    ) => {
      tasks.push(
        operation
          .then(emit)
          .catch(() => {
            failedSections.push(section);
          }),
      );
    };
    if (kinds.has('balances')) {
      emitWhenReady('overview', this.account.getOverview(userId), (overview) => {
        this.emitToUser(userId, 'balances', overview.balances);
        this.emitToUser(userId, 'portfolio', overview.portfolio);
      });
    }
    if (kinds.has('orders')) {
      emitWhenReady(
        'orders',
        this.prisma.order.findMany({
          where: { userId },
          include: { market: true, providerOrder: true, trades: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        (orders) => this.emitToUser(userId, 'orders', orders),
      );
    }
    if (kinds.has('positions')) {
      emitWhenReady(
        'positions',
        this.positions.listUserPositions(userId, { includeLiveMarks: false }),
        (positions) => this.emitToUser(userId, 'positions', positions),
      );
    }
    if (kinds.has('trades')) {
      emitWhenReady(
        'trades',
        this.prisma.trade.findMany({
          where: { userId },
          orderBy: { executedAt: 'desc' },
          take: 50,
        }),
        (trades) => this.emitToUser(userId, 'trades', trades),
      );
    }
    if (kinds.has('deposits')) {
      emitWhenReady(
        'deposits',
        this.prisma.deposit.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        (deposits) => this.emitToUser(userId, 'deposits', deposits),
      );
    }
    await Promise.all(tasks);
    if (failedSections.length > 0) {
      this.logger.warn(
        `Partial realtime update for ${userId}; failed sections: ${failedSections.join(', ')}`,
      );
      this.emitToUser(userId, 'snapshot_partial', {
        sections: failedSections,
        retryable: true,
      });
    }
    this.emitToUser(userId, 'account_updated', {
      kinds: [...kinds],
      occurredAt: new Date().toISOString(),
    });
  }

  private async emitSnapshot(client: AuthenticatedSocket): Promise<void> {
    const userId = client.data.userId;
    if (!userId || !client.connected) {
      return;
    }
    const results = await Promise.allSettled([
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
        this.positions.listUserPositions(userId, { includeLiveMarks: false }),
        this.prisma.liquidationEvent.findMany({
          where: { position: { userId } },
          orderBy: { triggeredAt: 'desc' },
          take: 20,
        }),
    ] as const);
    const [
      overviewResult,
      depositsResult,
      withdrawalsResult,
      ordersResult,
      tradesResult,
      positionsResult,
      liquidationsResult,
    ] = results;
    if (overviewResult.status === 'fulfilled') {
      this.emitToClient(client, 'balances', overviewResult.value.balances);
      this.emitToClient(client, 'portfolio', overviewResult.value.portfolio);
    }
    if (depositsResult.status === 'fulfilled') {
      this.emitToClient(client, 'deposits', depositsResult.value);
    }
    if (withdrawalsResult.status === 'fulfilled') {
      this.emitToClient(client, 'withdrawals', withdrawalsResult.value);
    }
    if (ordersResult.status === 'fulfilled') {
      this.emitToClient(client, 'orders', ordersResult.value);
    }
    if (tradesResult.status === 'fulfilled') {
      this.emitToClient(client, 'trades', tradesResult.value);
    }
    if (positionsResult.status === 'fulfilled') {
      this.emitToClient(client, 'positions', positionsResult.value);
    }
    // This payload is a state snapshot, not a newly-triggered liquidation.
    // Keep it on a separate event so clients cannot accidentally show a
    // liquidation toast for an empty array or replay historical events after
    // every reconnect/fallback snapshot. A real liquidation notification must
    // use the singular `liquidation` event at the point it is committed.
    if (liquidationsResult.status === 'fulfilled') {
      this.emitToClient(client, 'liquidations_snapshot', liquidationsResult.value);
    }
    this.emitToClient(client, 'provider_status', {
      hyperliquidExecutionEnabled: this.hyperliquid.isExecutionEnabled(),
      marketDataProvider: this.config.get<string>('MARKET_DATA_PROVIDER', 'MOCK'),
    });
    const positions = positionsResult.status === 'fulfilled' ? positionsResult.value : [];
    const nearLiquidation = positions.filter((position) => {
      if (position.status !== 'OPEN' || !position.maintenanceMargin) {
        return false;
      }
      return new Prisma.Decimal(position.margin)
        .plus(position.unrealizedPnl)
        .lessThanOrEqualTo(new Prisma.Decimal(position.maintenanceMargin).mul('1.5'));
    });
    if (nearLiquidation.length > 0) {
      this.emitToClient(client, 'risk_alert', {
        type: 'NEAR_LIQUIDATION',
        positions: nearLiquidation.map((position) => position.id),
      });
    }
    const sectionNames = [
      'overview',
      'deposits',
      'withdrawals',
      'orders',
      'trades',
      'positions',
      'liquidations',
    ];
    const failedSections = results.flatMap((result, index) =>
      result.status === 'rejected' ? [sectionNames[index]!] : [],
    );
    if (failedSections.length > 0) {
      this.logger.warn(
        `Partial private snapshot for ${client.id}; failed sections: ${failedSections.join(', ')}`,
      );
      this.emitToClient(client, 'snapshot_partial', {
        sections: failedSections,
        retryable: true,
      });
    }
  }

  private async emitSnapshotSafely(
    client: AuthenticatedSocket,
    reason: string,
  ): Promise<boolean> {
    try {
      await this.emitSnapshot(client);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Private socket snapshot failed (${reason}) for ${client.id}: ${message}`,
      );
      if (client.connected) {
        client.emit('snapshot_error', { reason, retryable: true });
      }
      return false;
    }
  }
}
