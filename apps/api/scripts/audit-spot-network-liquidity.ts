import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { TokenStandard } from '@prisma/client';
import { formatUnits } from 'viem';
import { PrismaService } from '../src/database/prisma.service';
import { DatabaseModule } from '../src/database/database.module';
import { RPC_PROVIDER, RpcModule } from '../src/modules/rpc/rpc.module';
import { RpcProvider } from '../src/modules/rpc/rpc-provider.interface';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';
import { TreasuryModule } from '../src/modules/treasury/treasury.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['apps/api/.env', '.env', '../../.env'],
      isGlobal: true,
    }),
    DatabaseModule,
    RpcModule,
    TreasuryModule,
  ],
})
class AuditSpotNetworkLiquidityModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(AuditSpotNetworkLiquidityModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const custody = app.get(PrivyCustodyService);
    const rpc = app.get<RpcProvider>(RPC_PROVIDER);
    const walletId = process.env.PRIVY_SPOT_LIQUIDITY_WALLET_ID?.trim();
    if (!walletId) {
      throw new Error('PRIVY_SPOT_LIQUIDITY_WALLET_ID is required');
    }
    const wallet = await custody.getWalletAddress(walletId);
    const networks = await prisma.network.findMany({
      where: { family: 'EVM', mainnet: true },
      include: {
        tokenContracts: {
          where: {
            standard: TokenStandard.ERC20,
            contractVerifiedAt: { not: null },
            asset: { symbol: { in: ['USDC', 'USDT'] } },
          },
          include: { asset: true },
        },
      },
      orderBy: { chainKey: 'asc' },
    });
    const results = [];
    for (const network of networks) {
      try {
        const native = await rpc.getBalance(wallet, undefined, network.chainKey);
        const stablecoins: Record<string, string> = {};
        for (const contract of network.tokenContracts) {
          if (!contract.address) continue;
          stablecoins[contract.asset.symbol] = (
            await rpc.getBalance(
              wallet,
              contract.address,
              network.chainKey,
              contract.decimals,
            )
          ).value;
        }
        results.push({
          network: network.chainKey,
          chainId: network.chainId,
          gas: formatUnits(BigInt(native.value), 18),
          stablecoins,
        });
      } catch (error) {
        results.push({
          network: network.chainKey,
          chainId: network.chainId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    process.stderr.write(`${JSON.stringify({ wallet, results }, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
