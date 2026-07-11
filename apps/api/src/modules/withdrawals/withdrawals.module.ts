import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WithdrawalsController } from './withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';
import { TreasuryModule } from '../treasury/treasury.module';
import { RpcModule } from '../rpc/rpc.module';
import { SettingsModule } from '../settings/settings.module';
import { OnchainModule } from '../onchain/onchain.module';
import { PrivyWebhookController } from './privy-webhook.controller';
import { DepositsModule } from '../deposits/deposits.module';
import { AccountModule } from '../account/account.module';

@Module({
  imports: [
    AssetsModule,
    AuditModule,
    LedgerModule,
    TreasuryModule,
    RpcModule,
    SettingsModule,
    OnchainModule,
    DepositsModule,
    AccountModule,
  ],
  controllers: [WithdrawalsController, PrivyWebhookController],
  providers: [WithdrawalsService],
  exports: [WithdrawalsService],
})
export class WithdrawalsModule {}
