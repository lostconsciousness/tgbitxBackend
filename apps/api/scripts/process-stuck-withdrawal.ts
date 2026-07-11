import { NestFactory } from '@nestjs/core';
import { WithdrawalStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { WithdrawalsService } from '../src/modules/withdrawals/withdrawals.service';

const WITHDRAWAL_ID = process.argv[2] ?? 'cmqwt7ugb0040evtre0kgebcs';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const withdrawals = app.get(WithdrawalsService);

    const before = await prisma.withdrawal.findUnique({
      where: { id: WITHDRAWAL_ID },
      select: {
        id: true,
        status: true,
        amount: true,
        lastBroadcastError: true,
        txHash: true,
      },
    });
    console.log('Before:', before);

    if (!before) {
      throw new Error('Withdrawal not found');
    }

    if (
      before.status === WithdrawalStatus.CONFIRMED ||
      before.status === WithdrawalStatus.FAILED ||
      before.status === WithdrawalStatus.CANCELLED ||
      before.status === WithdrawalStatus.REJECTED
    ) {
      console.log('Withdrawal already terminal:', before.status);
      return;
    }

    await withdrawals.processApprovedWithdrawals();

    const afterWorker = await prisma.withdrawal.findUnique({
      where: { id: WITHDRAWAL_ID },
      select: {
        id: true,
        status: true,
        amount: true,
        lastBroadcastError: true,
        txHash: true,
      },
    });
    console.log('After worker:', afterWorker);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
