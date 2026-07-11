import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const usdt = await prisma.asset.findUnique({ where: { symbol: 'USDT' } });
  if (!usdt) {
    console.log('USDT asset not found');
    return;
  }
  const updated = await prisma.tokenContract.updateMany({
    where: { assetId: usdt.id },
    data: { minWithdrawalAmount: '0' },
  });
  await prisma.asset.update({
    where: { id: usdt.id },
    data: { minWithdrawalAmount: '0' },
  });
  const rows = await prisma.tokenContract.findMany({
    where: { assetId: usdt.id },
    include: { network: { select: { chainKey: true } } },
  });
  console.log(`Updated ${updated.count} token contracts`);
  for (const row of rows) {
    console.log(`${row.network.chainKey}: min=${row.minWithdrawalAmount.toString()}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
