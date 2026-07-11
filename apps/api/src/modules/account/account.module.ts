import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { PositionsModule } from '../positions/positions.module';
import { RpcModule } from '../rpc/rpc.module';
import { OnchainModule } from '../onchain/onchain.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AssetValuationService } from './asset-valuation.service';

@Module({
  imports: [LedgerModule, MarketDataModule, RpcModule, OnchainModule, PositionsModule],
  controllers: [AccountController],
  providers: [AccountService, AssetValuationService],
  exports: [AccountService, AssetValuationService],
})
export class AccountModule {}
