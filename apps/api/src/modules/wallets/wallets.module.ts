import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { AccountModule } from '../account/account.module';
import { RpcModule } from '../rpc/rpc.module';
import { PrivyWalletProvider } from './privy-wallet-provider.service';
import { WalletNonceCleanupService } from './wallet-nonce-cleanup.service';
import { WalletJwksController } from './wallet-jwks.controller';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [AuditModule, AccountModule, JwtModule.register({}), RpcModule],
  controllers: [WalletsController, WalletJwksController],
  providers: [WalletsService, PrivyWalletProvider, WalletNonceCleanupService],
  exports: [WalletsService, PrivyWalletProvider],
})
export class WalletsModule {}
