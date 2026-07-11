import 'dotenv/config';
import { PrismaClient, Chain } from '@prisma/client';

const prisma = new PrismaClient();

void main().finally(async () => {
  await prisma.$disconnect();
});

async function main() {
  const network = await prisma.network.findFirst({
    where: { legacyChain: Chain.SOLANA },
    select: { chainKey: true, family: true, legacyChain: true },
  });
  const sweep = await prisma.depositSweep.findUnique({
    where: { id: 'cmqvk8h6g000rfelmdtlokmmd' },
    include: { depositAddress: true },
  });
  console.log(JSON.stringify({ network, sweepNetwork: sweep?.depositAddress.network, status: sweep?.status, failureReason: sweep?.failureReason }, null, 2));
}
