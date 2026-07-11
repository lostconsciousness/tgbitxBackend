import { PrismaClient, WithdrawalStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const approved = await prisma.withdrawal.findMany({
    where: { status: { in: [WithdrawalStatus.APPROVED, WithdrawalStatus.BROADCASTING, WithdrawalStatus.REQUESTED, WithdrawalStatus.PENDING_APPROVAL] } },
    include: { asset: true, tokenContract: { include: { network: true } }, user: { select: { email: true } } },
    orderBy: { createdAt: 'desc' },
  });
  console.log('Pending pipeline:', approved.length);
  for (const w of approved) {
    console.log({
      id: w.id,
      user: w.user.email,
      status: w.status,
      amount: w.amount.toString(),
      fee: w.feeAmount.toString(),
      asset: w.asset.symbol,
      network: w.tokenContract?.network?.chainKey,
      to: w.toAddress,
      error: w.lastBroadcastError,
      attempts: w.broadcastAttempts,
    });
  }

  const failed = await prisma.withdrawal.findFirst({
    where: { id: 'cmqwpisnh0038ytrdr2u247uq' },
  });
  console.log('\nFailed USDT withdrawal:', failed);

  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (user) {
    const usdt = await prisma.asset.findUnique({ where: { symbol: 'USDT' } });
    if (usdt) {
      const account = await prisma.ledgerAccount.findUnique({
        where: { key: `USER_SPOT:${usdt.id}:${user.id}` },
      });
      if (account) {
        const entries = await prisma.ledgerEntry.findMany({
          where: { accountId: account.id, transaction: { status: 'POSTED' } },
          include: { transaction: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        });
        console.log('\nRecent ledger entries for USDT spot:');
        for (const e of entries) {
          console.log(e.direction, e.amount.toString(), e.transaction.type, e.transaction.description);
        }
      }
    }
  }
}

main()
  .finally(() => prisma.$disconnect());
