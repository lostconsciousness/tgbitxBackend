import 'dotenv/config';
import { PrismaClient, DepositSweepStatus } from '@prisma/client';

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const sweepId = process.argv[2] ?? 'cmqvk8h6g000rfelmdtlokmmd';
  const prisma = new PrismaClient();
  const updated = await prisma.depositSweep.update({
    where: { id: sweepId },
    data: {
      status: DepositSweepStatus.PENDING,
      failureReason: null,
      txHash: null,
      gasFundingTxHash: null,
      providerRequestId: null,
    },
  });
  console.log(JSON.stringify({ requeued: updated.id, status: updated.status }, null, 2));
  await prisma.$disconnect();
}
