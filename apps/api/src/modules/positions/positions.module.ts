import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { OrdersModule } from '../orders/orders.module';
import { PositionsController } from './positions.controller';
import { PositionsService } from './positions.service';

@Module({
  imports: [OrdersModule, MarketDataModule],
  controllers: [PositionsController],
  providers: [PositionsService],
  exports: [PositionsService],
})
export class PositionsModule {}
