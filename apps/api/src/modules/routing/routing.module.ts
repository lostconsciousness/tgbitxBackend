import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  providers: [RoutingService],
  exports: [RoutingService],
})
export class RoutingModule {}
