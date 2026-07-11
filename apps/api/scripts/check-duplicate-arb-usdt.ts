import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (!user) return;

  const dupes = await prisma.deposit.findMany({
    where: {
      userId: user.id,
      amount: 4.9,
      network: 'ARBITRUM',
      status: 'CREDITED',
    },
    include: { tokenContract: { include: { network: true } } },
    orderBy: { createdAt: 'asc' },
  });

  console.log('Arbitrum 4.9 USDT credited deposits:', dupes.length);
  for (const d of dupes) {
    console.log({
      id: d.id,
      txHash: d.txHash.slice(0, 18) + '...',
      logIndex: d.logIndex,
      idempotencyKey: d.idempotencyKey,
      toAddress: d.toAddress,
      rawAmount: d.rawAmount,
      createdAt: d.createdAt.toISOString(),
      creditedAt: d.creditedAt?.toISOString(),
    });
  }

  await prisma.$disconnect();
}

main().catch(console.error);
