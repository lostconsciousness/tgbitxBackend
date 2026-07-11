import { Module } from '@nestjs/common';
import { HyperliquidModule } from '../hyperliquid/hyperliquid.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { MarketsModule } from '../markets/markets.module';
import { RoutingModule } from '../routing/routing.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { SettingsModule } from '../settings/settings.module';
import { InternalSwapProviderService } from './internal-swap-provider.service';
import { PerpTriggerMatcherService } from './perp-trigger-matcher.service';
import { SpotOrderMatcherService } from './spot-order-matcher.service';
import { ProviderOrderReconciliationService } from './provider-order-reconciliation.service';

@Module({
  imports: [
    HyperliquidModule,
    LedgerModule,
    MarketDataModule,
    MarketsModule,
    RoutingModule,
    SettingsModule,
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    InternalSwapProviderService,
    SpotOrderMatcherService,
    PerpTriggerMatcherService,
    ProviderOrderReconciliationService,
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
