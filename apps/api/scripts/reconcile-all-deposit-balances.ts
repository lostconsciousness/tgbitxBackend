import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DepositIndexerService } from '../src/modules/deposits/deposit-indexer.service';
import { DepositsService } from '../src/modules/deposits/deposits.service';
import { AccountService } from '../src/modules/account/account.service';
import { PrismaService } from '../src/database/prisma.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const indexer = app.get(DepositIndexerService);
    const deposits = app.get(DepositsService);
    const account = app.get(AccountService);
    const prisma = app.get(PrismaService);
    const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
    if (!user) {
      throw new Error('trader@example.com not found');
    }

    const result = await indexer.reconcileAllPersonalDepositBalances();
    console.log('reconcileAllPersonalDepositBalances', result);
    await deposits.creditReadyDeposits();
    console.log('creditReadyDeposits done');

    const overview = await account.getOverview(user.id);
    const usdt = overview.balances.find(
      (row) => (row.asset as { symbol: string }).symbol === 'USDT',
    );
    console.log('USDT overview', {
      available: usdt?.available,
      pendingDeposit: usdt?.pendingDeposit,
      total: usdt?.total,
      status: usdt?.status,
    });
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
