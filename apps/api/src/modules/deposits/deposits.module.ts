import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RpcModule } from '../rpc/rpc.module';
import { WalletsModule } from '../wallets/wallets.module';
import { DepositIndexerService } from './deposit-indexer.service';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';
import { OnchainModule } from '../onchain/onchain.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { DepositAddressService } from './deposit-address.service';
import { DepositSweepService } from './deposit-sweep.service';
import { AccountModule } from '../account/account.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    AssetsModule,
    AuditModule,
    LedgerModule,
    RpcModule,
    WalletsModule,
    OnchainModule,
    TreasuryModule,
    AccountModule,
    RealtimeModule,
  ],
  controllers: [DepositsController],
  providers: [
    DepositsService,
    DepositIndexerService,
    DepositAddressService,
    DepositSweepService,
  ],
  exports: [
    DepositsService,
    DepositIndexerService,
    DepositAddressService,
    DepositSweepService,
  ],
})
export class DepositsModule {}
