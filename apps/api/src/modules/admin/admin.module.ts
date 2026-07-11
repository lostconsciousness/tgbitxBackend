import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminController } from './admin.controller';
import { RiskAdminController } from './risk-admin.controller';
import { SettingsModule } from '../settings/settings.module';
import { HyperliquidModule } from '../hyperliquid/hyperliquid.module';

@Module({
  imports: [AuditModule, SettingsModule, HyperliquidModule],
  controllers: [AdminController, RiskAdminController],
})
export class AdminModule {}
