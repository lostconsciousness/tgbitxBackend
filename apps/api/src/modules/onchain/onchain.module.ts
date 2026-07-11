import { Module } from '@nestjs/common';
import { RpcModule } from '../rpc/rpc.module';
import { OnchainReadinessController } from './onchain-readiness.controller';
import { OnchainReadinessService } from './onchain-readiness.service';
import { NetworkAdaptersService } from './network-adapters.service';
import { NonEvmTestnetAdapterService } from './non-evm-testnet-adapter.service';
import { TreasuryModule } from '../treasury/treasury.module';

@Module({
  imports: [RpcModule, TreasuryModule],
  controllers: [OnchainReadinessController],
  providers: [OnchainReadinessService, NetworkAdaptersService, NonEvmTestnetAdapterService],
  exports: [OnchainReadinessService, NetworkAdaptersService, NonEvmTestnetAdapterService],
})
export class OnchainModule {}
