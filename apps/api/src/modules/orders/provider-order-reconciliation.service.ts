import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { OrdersService } from './orders.service';

@Injectable()
export class ProviderOrderReconciliationService {
  private readonly logger = new Logger(ProviderOrderReconciliationService.name);
  private running = false;
  private lastRunAt = 0;

  constructor(
    private readonly orders: OrdersService,
    private readonly config: ConfigService,
  ) {}

  @Interval('provider-order-reconciliation', 1_000)
  async reconcile(): Promise<void> {
    if (this.running) return;
    const configuredInterval = this.config.get<number>(
      'PROVIDER_RECONCILIATION_INTERVAL_MS',
      5_000,
    );
    if (configuredInterval <= 0) return;
    if (Date.now() - this.lastRunAt < configuredInterval) return;

    this.running = true;
    this.lastRunAt = Date.now();
    try {
      await this.orders.reconcilePendingProviderOrders();
    } catch (error) {
      this.logger.error(
        'Provider order reconciliation failed',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }
}
