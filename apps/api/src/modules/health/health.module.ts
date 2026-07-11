import { Module } from '@nestjs/common';
import { HyperliquidModule } from '../hyperliquid/hyperliquid.module';
import { SettingsModule } from '../settings/settings.module';
import { HealthController } from './health.controller';

@Module({
  imports: [HyperliquidModule, SettingsModule],
  controllers: [HealthController],
})
export class HealthModule {}
