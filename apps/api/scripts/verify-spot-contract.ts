import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DatabaseModule } from '../src/database/database.module';
import { AssetsModule } from '../src/modules/assets/assets.module';
import { AssetsService } from '../src/modules/assets/assets.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['apps/api/.env', '.env', '../../.env'],
      isGlobal: true,
    }),
    DatabaseModule,
    AssetsModule,
  ],
})
class VerifySpotContractModule {}

async function main(): Promise<void> {
  const symbol = process.argv[2]?.trim().toUpperCase();
  const network = process.argv[3]?.trim().toLowerCase();
  const address = process.argv[4]?.trim();
  const decimals = process.argv[5] ? Number(process.argv[5]) : undefined;
  if (!symbol || !network) {
    throw new Error('Usage: ts-node scripts/verify-spot-contract.ts <symbol> <network>');
  }
  const app = await NestFactory.createApplicationContext(VerifySpotContractModule, {
    logger: ['error', 'warn'],
  });
  try {
    const assets = app.get(AssetsService);
    if (address && Number.isInteger(decimals)) {
      await assets.upsertTokenContract(symbol, {
        network,
        tokenAddress: address,
        decimals: decimals!,
        minWithdrawalAmount: '0',
        withdrawalFeeAmount: '0',
      });
    }
    await assets.verifyContract(symbol, network);
    console.log(JSON.stringify({ verified: true, symbol, network }));
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
