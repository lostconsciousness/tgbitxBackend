import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountModule } from './modules/account/account.module';
import { AdminModule } from './modules/admin/admin.module';
import { AssetsModule } from './modules/assets/assets.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { DepositsModule } from './modules/deposits/deposits.module';
import { HealthModule } from './modules/health/health.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { MarketsModule } from './modules/markets/markets.module';
import { MarketDataModule } from './modules/market-data/market-data.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { RpcModule } from './modules/rpc/rpc.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { UsersModule } from './modules/users/users.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WithdrawalsModule } from './modules/withdrawals/withdrawals.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { envValidationSchema } from './config/env.validation';
import { TreasuryModule } from './modules/treasury/treasury.module';
import { HyperliquidModule } from './modules/hyperliquid/hyperliquid.module';
import { RoutingModule } from './modules/routing/routing.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PositionsModule } from './modules/positions/positions.module';
import { LiquidationsModule } from './modules/liquidations/liquidations.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { OnchainModule } from './modules/onchain/onchain.module';
import { SpotModule } from './modules/spot/spot.module';
import { ConvertModule } from './modules/convert/convert.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['apps/api/.env', '.env', '../../.env'],
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
    ScheduleModule.forRoot(),
    DatabaseModule,
    RedisModule,
    AuditModule,
    UsersModule,
    SessionsModule,
    AuthModule,
    AccountModule,
    AdminModule,
    AssetsModule,
    MarketsModule,
    MarketDataModule,
    WalletsModule,
    RpcModule,
    OnchainModule,
    LedgerModule,
    TreasuryModule,
    HyperliquidModule,
    RoutingModule,
    OrdersModule,
    SpotModule,
    ConvertModule,
    PositionsModule,
    LiquidationsModule,
    RealtimeModule,
    DepositsModule,
    WithdrawalsModule,
    ReconciliationModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
