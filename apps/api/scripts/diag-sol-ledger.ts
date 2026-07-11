import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

void main().finally(async () => {
  await prisma.$disconnect();
});

async function main() {
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (!user) {
    throw new Error('user not found');
  }
  const sol = await prisma.asset.findFirst({ where: { symbol: 'SOL' } });
  if (!sol) {
    throw new Error('SOL asset not found');
  }

  const [deposits, entries, accounts] = await Promise.all([
    prisma.deposit.findMany({
      where: { userId: user.id, assetId: sol.id },
      include: { tokenContract: { include: { network: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.ledgerEntry.findMany({
      where: { account: { userId: user.id, assetId: sol.id } },
      include: { account: true, transaction: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.ledgerAccount.findMany({
      where: { userId: user.id, assetId: sol.id },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        deposits: deposits.map((deposit) => ({
          id: deposit.id,
          status: deposit.status,
          amount: deposit.amount.toString(),
          network: deposit.network,
          toAddress: deposit.toAddress,
          txHash: deposit.txHash,
        })),
        ledgerAccounts: accounts.map((account) => ({
          id: account.id,
          type: account.type,
        })),
        ledgerEntries: entries.map((entry) => ({
          direction: entry.direction,
          amount: entry.amount.toString(),
          accountType: entry.account.type,
          txType: entry.transaction.type,
          referenceId: entry.transaction.referenceId,
        })),
      },
      null,
      2,
    ),
  );
}
