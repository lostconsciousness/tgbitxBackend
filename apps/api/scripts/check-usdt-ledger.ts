import { PrismaClient, LedgerEntryDirection } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (!user) {
    console.log('user not found');
    return;
  }

  for (const symbol of ['USDT', 'USDC']) {
    const asset = await prisma.asset.findUnique({ where: { symbol } });
    if (!asset) continue;

    const account = await prisma.ledgerAccount.findUnique({
      where: { key: `USER_SPOT:${asset.id}:${user.id}` },
    });
    if (!account) {
      console.log(`\n${symbol}: no USER_SPOT ledger`);
      continue;
    }

    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: account.id, transaction: { status: 'POSTED' } },
      include: { transaction: true },
      orderBy: { createdAt: 'asc' },
    });
    let total = 0;
    for (const entry of entries) {
      const signed =
        entry.direction === LedgerEntryDirection.CREDIT
          ? Number(entry.amount)
          : -Number(entry.amount);
      total += signed;
    }
    console.log(`\n${symbol} ledger total: ${total}`);
    for (const entry of entries) {
      console.log(
        `  ${entry.direction} ${entry.amount} ${entry.transaction.type} ${entry.transaction.referenceId ?? ''}`,
      );
    }
  }

  const deposits = await prisma.deposit.findMany({
    where: { userId: user.id, asset: { symbol: 'USDT' } },
    include: { asset: true, tokenContract: { include: { network: true } } },
    orderBy: { createdAt: 'desc' },
  });
  console.log('\nUSDT deposits:');
  for (const deposit of deposits) {
    console.log(
      `  ${deposit.status} ${deposit.amount} ${deposit.network} (${deposit.tokenContract?.network?.chainKey ?? '?'}) credited=${deposit.creditedAt?.toISOString() ?? 'no'}`,
    );
  }

  const onChain = await prisma.userDepositAddress.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    select: { network: true, address: true },
  });
  console.log('\nActive deposit addresses:', onChain.length);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
