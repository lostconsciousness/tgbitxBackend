import { Module } from '@nestjs/common';
import { TreasuryModule } from '../treasury/treasury.module';
import { HyperliquidExecutionService } from './hyperliquid-execution.service';

@Module({
  imports: [TreasuryModule],
  providers: [HyperliquidExecutionService],
  exports: [HyperliquidExecutionService],
})
export class HyperliquidModule {}
