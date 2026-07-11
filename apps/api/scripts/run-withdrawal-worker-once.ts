import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { WithdrawalsService } from '../src/modules/withdrawals/withdrawals.service';
import { PrismaService } from '../src/database/prisma.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const prisma = app.get(PrismaService);
    const withdrawals = app.get(WithdrawalsService);
    const before = await prisma.withdrawal.findFirst({
      where: { id: 'cmqwpisnh0038ytrdr2u247uq' },
      select: { status: true, broadcastAttempts: true, lastBroadcastError: true, txHash: true },
    });
    console.log('Before:', before);
    await withdrawals.processApprovedWithdrawals();
    const after = await prisma.withdrawal.findFirst({
      where: { id: 'cmqwpisnh0038ytrdr2u247uq' },
      select: { status: true, broadcastAttempts: true, lastBroadcastError: true, txHash: true },
    });
    console.log('After:', after);
  } finally {
    await app.close();
  }
}

main().catch(console.error);
