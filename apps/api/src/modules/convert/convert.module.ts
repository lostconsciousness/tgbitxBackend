import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { RpcModule } from '../rpc/rpc.module';
import { SpotModule } from '../spot/spot.module';
import { TreasuryModule } from '../treasury/treasury.module';
import { ConvertController } from './convert.controller';
import { ConvertService } from './convert.service';
import { ConvertOrderbookService } from './convert-orderbook.service';
import { ConvertOrderbookGateway } from './convert-orderbook.gateway';

@Module({
  imports: [LedgerModule, MarketDataModule, RpcModule, SpotModule, TreasuryModule],
  controllers: [ConvertController],
  providers: [ConvertService, ConvertOrderbookService, ConvertOrderbookGateway],
  exports: [ConvertService, ConvertOrderbookService],
})
export class ConvertModule {}
