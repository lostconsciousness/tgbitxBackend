import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const addresses = await prisma.userDepositAddress.findMany({
    where: { network: 'ARBITRUM_SEPOLIA' },
  });
  for (const a of addresses) {
    console.log(
      `${a.id} ${a.status} ${a.address} providerWalletRef=${a.providerWalletRef ?? 'MISSING'}`,
    );
  }
  await prisma.$disconnect();
}

main();
