import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../database/prisma.service';
import { AccountService } from '../account/account.service';
import { HyperliquidExecutionService } from '../hyperliquid/hyperliquid-execution.service';
import { PositionsService } from '../positions/positions.service';
import { SessionsService } from '../sessions/sessions.service';
import { UserUpdatesService } from '../user-updates/user-updates.service';
import { PrivateRealtimeGateway } from './private-realtime.gateway';

describe('PrivateRealtimeGateway payload serialization', () => {
  it('serializes Prisma BigInt fields before sending a socket event', () => {
    const gateway = new PrivateRealtimeGateway(
      {} as JwtService,
      {} as ConfigService,
      {} as SessionsService,
      {} as AccountService,
      {} as PrismaService,
      {} as HyperliquidExecutionService,
      {} as PositionsService,
      {} as UserUpdatesService,
    );

    const serialized = (gateway as unknown as {
      toRealtimePayload(payload: unknown): unknown;
    }).toRealtimePayload({
      id: 'withdrawal-1',
      broadcastNonce: 42n,
      gasUsed: 21000n,
    });

    expect(serialized).toEqual({
      id: 'withdrawal-1',
      broadcastNonce: '42',
      gasUsed: '21000',
    });
  });

  it('emits a committed position without waiting for a slow overview', async () => {
    let resolveOverview!: (value: {
      balances: unknown[];
      portfolio: Record<string, unknown>;
    }) => void;
    const overview = new Promise<{
      balances: unknown[];
      portfolio: Record<string, unknown>;
    }>((resolve) => {
      resolveOverview = resolve;
    });
    const emit = jest.fn();
    const gateway = new PrivateRealtimeGateway(
      {} as JwtService,
      {} as ConfigService,
      {} as SessionsService,
      {
        invalidateOverviewCache: jest.fn(),
        getOverview: jest.fn().mockReturnValue(overview),
      } as unknown as AccountService,
      {} as PrismaService,
      {} as HyperliquidExecutionService,
      {
        listUserPositions: jest.fn().mockResolvedValue([{ id: 'position-1' }]),
      } as unknown as PositionsService,
      {} as UserUpdatesService,
    );
    const privateGateway = gateway as unknown as {
      server: { to(room: string): { emit: typeof emit } };
      emitUserUpdate(userId: string, kinds: Set<string>): Promise<void>;
    };
    privateGateway.server = { to: jest.fn().mockReturnValue({ emit }) };

    const update = privateGateway.emitUserUpdate(
      'user-1',
      new Set(['balances', 'positions']),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(emit).toHaveBeenCalledWith('positions', [{ id: 'position-1' }]);
    expect(emit).not.toHaveBeenCalledWith('balances', expect.anything());

    resolveOverview({ balances: [{ asset: 'USDC' }], portfolio: { total: '1' } });
    await update;
    expect(emit).toHaveBeenCalledWith('balances', [{ asset: 'USDC' }]);
  });
});
