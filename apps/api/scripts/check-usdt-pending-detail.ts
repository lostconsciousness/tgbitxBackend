import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (!user) return;

  const deposits = await prisma.deposit.findMany({
    where: { userId: user.id, asset: { symbol: 'USDT' } },
    include: { tokenContract: { include: { network: true } } },
    orderBy: { createdAt: 'desc' },
  });

  console.log('All USDT deposits:');
  for (const d of deposits) {
    console.log(
      `${d.status.padEnd(20)} ${String(d.amount).padStart(6)} ${d.network.padEnd(12)} to=${d.toAddress.slice(0, 12)}... id=${d.id}`,
    );
  }

  const addresses = await prisma.userDepositAddress.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    orderBy: { network: 'asc' },
  });
  console.log('\nDeposit addresses (partial):');
  for (const a of addresses) {
    if (
      a.address.toLowerCase().startsWith('0xdbcd') ||
      a.address.startsWith('TYz4') ||
      a.address.toLowerCase().startsWith('0x4393')
    ) {
      console.log(`${a.network} ${a.address}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
