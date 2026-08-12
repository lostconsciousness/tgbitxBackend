import { Module } from '@nestjs/common';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { MockMarketDataProvider } from './mock-market-data.provider';
import { HyperliquidMarketDataProvider } from './hyperliquid-market-data.provider';
import { MarketsModule } from '../markets/markets.module';
import { MarketDataGateway } from './market-data.gateway';

@Module({
  imports: [MarketsModule],
  controllers: [MarketDataController],
  providers: [
    MarketDataService,
    MarketDataGateway,
    MockMarketDataProvider,
    HyperliquidMarketDataProvider,
  ],
  exports: [MarketDataService],
})
export class MarketDataModule {}
