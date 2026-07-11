import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccountModule } from '../account/account.module';
import { PositionsModule } from '../positions/positions.module';
import { SessionsModule } from '../sessions/sessions.module';
import { PrivateRealtimeGateway } from './private-realtime.gateway';
import { HyperliquidModule } from '../hyperliquid/hyperliquid.module';

@Module({
  imports: [
    JwtModule.register({}),
    AccountModule,
    PositionsModule,
    SessionsModule,
    HyperliquidModule,
  ],
  providers: [PrivateRealtimeGateway],
  exports: [PrivateRealtimeGateway],
})
export class RealtimeModule {}
