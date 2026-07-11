import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RpcModule } from '../rpc/rpc.module';
import { PrivyCustodyService } from './privy-custody.service';
import { TreasuryController } from './treasury.controller';
import { TreasuryService } from './treasury.service';

@Module({
  imports: [RpcModule, AuditModule],
  controllers: [TreasuryController],
  providers: [PrivyCustodyService, TreasuryService],
  exports: [PrivyCustodyService, TreasuryService],
})
export class TreasuryModule {}
