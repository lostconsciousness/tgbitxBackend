import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MarketDataService } from './market-data.service';
import { OrderBookSubscriptionPayload } from './types/orderbook.types';

@WebSocketGateway({
  namespace: 'market-data',
  cors: { origin: true, credentials: true },
})
export class MarketDataGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  private readonly logger = new Logger(MarketDataGateway.name);
  private readonly unsubscribeByClient = new Map<string, Map<string, () => void>>();

  constructor(private readonly marketDataService: MarketDataService) {}

  handleConnection(client: Socket): void {
    this.unsubscribeByClient.set(client.id, new Map());
  }

  handleDisconnect(client: Socket): void {
    const subscriptions = this.unsubscribeByClient.get(client.id);
    if (subscriptions) {
      for (const unsubscribe of subscriptions.values()) {
        unsubscribe();
      }
    }
    this.unsubscribeByClient.delete(client.id);
  }

  @SubscribeMessage('subscribeOrderbook')
  async subscribeOrderbook(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: OrderBookSubscriptionPayload,
  ): Promise<{ ok: boolean; symbol?: string; error?: string }> {
    if (!payload?.symbol || typeof payload.symbol !== 'string') {
      return { ok: false, error: 'symbol is required' };
    }

    const symbol = payload.symbol.trim().toUpperCase();
    const clientSubscriptions = this.getClientSubscriptions(client.id);
    if (clientSubscriptions.has(symbol)) {
      return { ok: true, symbol };
    }

    try {
      const unsubscribe = await this.marketDataService.subscribeOrderBook({
        symbol,
        onSnapshot: (snapshot) => {
          client.emit('orderbook', snapshot);
        },
      });
      clientSubscriptions.set(symbol, unsubscribe);
      return { ok: true, symbol };
    } catch (error) {
      this.logger.warn(
        `Failed to subscribe client ${client.id} to ${symbol}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return {
        ok: false,
        symbol,
        error: error instanceof Error ? error.message : 'Failed to subscribe orderbook',
      };
    }
  }

  @SubscribeMessage('unsubscribeOrderbook')
  unsubscribeOrderbook(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: OrderBookSubscriptionPayload,
  ): { ok: boolean; symbol?: string } {
    const symbol = payload?.symbol?.trim().toUpperCase();
    if (!symbol) {
      return { ok: false };
    }

    const clientSubscriptions = this.getClientSubscriptions(client.id);
    const unsubscribe = clientSubscriptions.get(symbol);
    if (unsubscribe) {
      unsubscribe();
      clientSubscriptions.delete(symbol);
    }

    return { ok: true, symbol };
  }

  private getClientSubscriptions(clientId: string): Map<string, () => void> {
    const existing = this.unsubscribeByClient.get(clientId);
    if (existing) {
      return existing;
    }

    const subscriptions = new Map<string, () => void>();
    this.unsubscribeByClient.set(clientId, subscriptions);
    return subscriptions;
  }
}
