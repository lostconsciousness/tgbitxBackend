import { Module } from '@nestjs/common';
import { SpotController } from './spot.controller';
import { OneInchSwapProviderService } from './one-inch-swap-provider.service';

@Module({
  controllers: [SpotController],
  providers: [OneInchSwapProviderService],
  exports: [OneInchSwapProviderService],
})
export class SpotModule {}
