import { Module } from '@nestjs/common';
import { OperationalSettingsService } from './operational-settings.service';

@Module({
  providers: [OperationalSettingsService],
  exports: [OperationalSettingsService],
})
export class SettingsModule {}
