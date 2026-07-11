import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DepositSweepService } from '../src/modules/deposits/deposit-sweep.service';
import { PrismaService } from '../src/database/prisma.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const sweep = app.get(DepositSweepService);
    const prisma = app.get(PrismaService);
    console.log('Running deposit sweep once...');
    await sweep.runOnce();
    const active = await prisma.depositSweep.findMany({
      where: { id: { in: ['cmqvlmmny000kn0pahx2a9ovv', 'cmqvlxzls000kkhs19nec8dly'] } },
      select: { id: true, status: true, gasFundingTxHash: true, txHash: true, failureReason: true },
    });
    console.log('After run:', active);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
