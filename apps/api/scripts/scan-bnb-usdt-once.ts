import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DepositIndexerService } from '../src/modules/deposits/deposit-indexer.service';
import { DepositsService } from '../src/modules/deposits/deposits.service';
import { PrismaService } from '../src/database/prisma.service';
import { RPC_PROVIDER } from '../src/modules/rpc/rpc.module';
import { RpcProvider } from '../src/modules/rpc/rpc-provider.interface';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const indexer = app.get(DepositIndexerService);
    const deposits = app.get(DepositsService);
    const prisma = app.get(PrismaService);
    const rpc = app.get<RpcProvider>(RPC_PROVIDER);
    const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
    if (!user) {
      throw new Error('trader@example.com not found');
    }
    const latest = await rpc.getLatestBlockNumber('bnb');
    const lookback = Number(process.env.SCAN_LOOKBACK_BLOCKS ?? 3_000);
    const fromBlock = Math.max(0, latest - lookback);
    console.log(`Scanning BNB USDT blocks ${fromBlock}..${latest} for ${user.email}`);
    const result = await indexer.scanDeposits({
      assetSymbol: 'USDT',
      network: 'bnb',
      fromBlock,
      toBlock: latest,
      userId: user.id,
    });
    console.log('scan result', {
      scannedLogs: result.scannedLogs,
      deposits: result.deposits?.length ?? 0,
    });
    await deposits.creditReadyDeposits();
    console.log('creditReadyDeposits done');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
