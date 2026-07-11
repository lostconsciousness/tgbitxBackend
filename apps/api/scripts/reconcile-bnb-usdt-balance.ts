import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DepositIndexerService } from '../src/modules/deposits/deposit-indexer.service';
import { DepositsService } from '../src/modules/deposits/deposits.service';
import { PrismaService } from '../src/database/prisma.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const indexer = app.get(DepositIndexerService);
    const deposits = app.get(DepositsService);
    const prisma = app.get(PrismaService);
    const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
    if (!user) {
      throw new Error('trader@example.com not found');
    }

    const target = await prisma.tokenContract.findFirst({
      where: {
        network: { chainKey: 'bnb' },
        asset: { symbol: 'USDT' },
        depositEnabled: true,
      },
      include: { asset: true, network: true },
    });
    if (!target?.network.legacyChain) {
      throw new Error('BNB USDT token contract not found');
    }

    const personalAddresses = await prisma.userDepositAddress.findMany({
      where: {
        userId: user.id,
        network: target.network.legacyChain,
        status: 'ACTIVE',
      },
      select: { id: true, userId: true, address: true },
    });
    if (personalAddresses.length === 0) {
      throw new Error('No active BNB deposit address for trader');
    }

    const result = await indexer.reconcilePersonalEvmBalanceDeposit({
      userId: user.id,
      asset: target.asset,
      tokenContract: target,
      network: target.network,
      legacyChain: target.network.legacyChain,
      personalAddresses,
    });
    console.log('balance reconcile', result);
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
