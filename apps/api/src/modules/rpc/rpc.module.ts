import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ViemRpcProvider } from './viem-rpc.provider';
import { RpcController } from './rpc.controller';

export const RPC_PROVIDER = Symbol('RPC_PROVIDER');

@Module({
  controllers: [RpcController],
  providers: [
    {
      provide: RPC_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new ViemRpcProvider(config),
    },
  ],
  exports: [RPC_PROVIDER],
})
export class RpcModule {}
