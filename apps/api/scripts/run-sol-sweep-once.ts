import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DepositSweepService } from '../src/modules/deposits/deposit-sweep.service';
import { PrismaService } from '../src/database/prisma.service';
import { Chain, DepositSweepStatus } from '@prisma/client';

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const sweeps = app.get(DepositSweepService);

  const sweep = await prisma.depositSweep.findUnique({
    where: { id: 'cmqvk8h6g000rfelmdtlokmmd' },
    include: { depositAddress: true, asset: true },
  });
  if (!sweep) {
    throw new Error('Sweep not found');
  }

  const network = await prisma.network.findFirst({
    where: { legacyChain: sweep.depositAddress.network as Chain },
    select: { family: true, chainKey: true },
  });

  await prisma.depositSweep.update({
    where: { id: sweep.id },
    data: { status: DepositSweepStatus.PENDING, failureReason: null },
  });

  const familyProbe = await (sweeps as any).getDepositAddressFamily(sweep.depositAddress.network);
  await (sweeps as any).processSweep(sweep);

  const after = await prisma.depositSweep.findUnique({ where: { id: sweep.id } });
  console.log(
    JSON.stringify(
      {
        depositNetwork: sweep.depositAddress.network,
        networkLookup: network,
        familyProbe,
        afterStatus: after?.status,
        afterFailure: after?.failureReason,
        txHash: after?.txHash,
      },
      null,
      2,
    ),
  );

  await app.close();
}
