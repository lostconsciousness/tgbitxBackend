import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { SettingsModule } from '../settings/settings.module';
import { BbookRiskMonitorService } from './bbook-risk-monitor.service';

@Module({
  imports: [SettingsModule],
  providers: [RoutingService, BbookRiskMonitorService],
  exports: [RoutingService],
})
export class RoutingModule {}
