import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const deposits = await prisma.deposit.findMany({
    where: { network: 'ARBITRUM_SEPOLIA' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { asset: true },
  });
  console.log('Recent deposits:');
  for (const d of deposits) {
    console.log(
      `${d.status} ${d.asset.symbol} ${d.amount.toString()} sweep=${d.sweepId ?? 'none'} addr=${d.depositAddressId?.slice(0, 8) ?? 'none'}`,
    );
  }
  const sweeps = await prisma.depositSweep.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { asset: true },
  });
  console.log('\nRecent sweeps:');
  for (const s of sweeps) {
    console.log(`${s.status} ${s.asset.symbol} ${s.amount.toString()} ${s.failureReason ?? ''}`);
  }
  await prisma.$disconnect();
}

main();
