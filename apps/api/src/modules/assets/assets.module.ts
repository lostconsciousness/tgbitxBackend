import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { RpcModule } from '../rpc/rpc.module';

@Module({
  imports: [AuditModule, RpcModule],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
