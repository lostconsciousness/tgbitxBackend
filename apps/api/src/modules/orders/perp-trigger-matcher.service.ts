import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OrdersService } from './orders.service';

@Injectable()
export class PerpTriggerMatcherService {
  private readonly logger = new Logger(PerpTriggerMatcherService.name);
  private running = false;

  constructor(private readonly orders: OrdersService) {}

  @Interval(1_000)
  async matchOpenTriggers(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.orders.matchOpenPerpTriggerOrders();
    } catch (error) {
      this.logger.warn(
        `Perp trigger matcher failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      this.running = false;
    }
  }
}
