import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { OrdersModule } from '../orders/orders.module';
import { LiquidationsService } from './liquidations.service';

@Module({
  imports: [MarketDataModule, OrdersModule],
  providers: [LiquidationsService],
  exports: [LiquidationsService],
})
export class LiquidationsModule {}
