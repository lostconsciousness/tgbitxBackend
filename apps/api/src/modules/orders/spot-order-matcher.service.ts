import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OrdersService } from './orders.service';

@Injectable()
export class SpotOrderMatcherService {
  private readonly logger = new Logger(SpotOrderMatcherService.name);
  private running = false;

  constructor(private readonly orders: OrdersService) {}

  @Interval(1_000)
  async matchOpenOrders(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.orders.matchOpenSpotOrders();
    } catch (error) {
      this.logger.warn(
        `Spot order matcher failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      this.running = false;
    }
  }
}
