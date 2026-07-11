import 'dotenv/config';
import { Chain } from '@prisma/client';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DepositsService } from '../src/modules/deposits/deposits.service';
import { AccountService } from '../src/modules/account/account.service';
import { PrismaService } from '../src/database/prisma.service';

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const deposits = app.get(DepositsService);
  const account = app.get(AccountService);
  const prisma = app.get(PrismaService);

  const reclassified = await deposits.reclassifyInternalDepositAddressTransferDeposits(Chain.SOLANA);
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  const overview = user ? await account.getOverview(user.id) : null;
  const sol = overview?.balances.find((row) => (row.asset as { symbol: string }).symbol === 'SOL');

  console.log(
    JSON.stringify(
      {
        reclassified,
        solBalance: sol
          ? {
              available: sol.available,
              total: sol.total,
              pendingDeposit: sol.pendingDeposit,
            }
          : null,
      },
      null,
      2,
    ),
  );

  await app.close();
}
