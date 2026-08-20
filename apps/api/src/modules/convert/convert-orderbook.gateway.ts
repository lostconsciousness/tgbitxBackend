import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { ConvertOrderbookService } from './convert-orderbook.service';

/**
 * Public Spot liquidity book over the existing `/market-data` namespace so the
 * frontend can reuse the market socket connection. Event name is distinct from
 * Hyperliquid `orderbook` snapshots.
 */
@WebSocketGateway({
  namespace: 'market-data',
  cors: { origin: true, credentials: true },
})
export class ConvertOrderbookGateway implements OnGatewayDisconnect {
  private readonly logger = new Logger(ConvertOrderbookGateway.name);
  private readonly unsubscribeByClient = new Map<string, Map<string, () => void>>();

  constructor(private readonly orderbooks: ConvertOrderbookService) {}

  handleDisconnect(client: Socket): void {
    const subscriptions = this.unsubscribeByClient.get(client.id);
    if (!subscriptions) return;
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    this.unsubscribeByClient.delete(client.id);
  }

  @SubscribeMessage('subscribeConvertOrderbook')
  subscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { pair?: string; symbol?: string },
  ): { ok: boolean; symbol?: string; error?: string } {
    const pair = (payload?.pair ?? payload?.symbol ?? '').trim();
    if (!pair) return { ok: false, error: 'pair is required' };

    try {
      const clientSubscriptions = this.getClientSubscriptions(client.id);
      const key = pair.toUpperCase();
      if (clientSubscriptions.has(key)) return { ok: true, symbol: key };

      const unsubscribe = this.orderbooks.subscribe(pair, (snapshot) => {
        client.emit('convertOrderbook', snapshot);
      });
      clientSubscriptions.set(key, unsubscribe);
      return { ok: true, symbol: key };
    } catch (error) {
      this.logger.warn(
        `convert orderbook subscribe failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to subscribe convert orderbook',
      };
    }
  }

  @SubscribeMessage('unsubscribeConvertOrderbook')
  unsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { pair?: string; symbol?: string },
  ): { ok: boolean; symbol?: string } {
    const pair = (payload?.pair ?? payload?.symbol ?? '').trim().toUpperCase();
    if (!pair) return { ok: false };
    const clientSubscriptions = this.getClientSubscriptions(client.id);
    const unsubscribe = clientSubscriptions.get(pair);
    if (unsubscribe) {
      unsubscribe();
      clientSubscriptions.delete(pair);
    }
    return { ok: true, symbol: pair };
  }

  private getClientSubscriptions(clientId: string): Map<string, () => void> {
    const existing = this.unsubscribeByClient.get(clientId);
    if (existing) return existing;
    const created = new Map<string, () => void>();
    this.unsubscribeByClient.set(clientId, created);
    return created;
  }
}
