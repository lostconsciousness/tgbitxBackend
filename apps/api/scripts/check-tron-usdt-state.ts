import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (!user) {
    console.log('user not found');
    return;
  }
  const assets = await prisma.asset.findMany({
    where: { symbol: { in: ['TRX', 'USDT', 'SOL'] } },
  });
  for (const asset of assets) {
    const account = await prisma.ledgerAccount.findUnique({
      where: { key: `USER_SPOT:${asset.id}:${user.id}` },
    });
    if (!account) {
      console.log(`\n${asset.symbol}: no USER_SPOT account`);
      continue;
    }
    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: account.id },
      include: { transaction: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    console.log(`\n${asset.symbol} ledger (account ${account.id}), latest entries:`);
    for (const e of entries) {
      console.log(
        `  ${e.direction} ${e.amount.toString()} status=${e.transaction.status} ${e.createdAt.toISOString()}`,
      );
    }
  }

  const deposits = await prisma.deposit.findMany({
    where: { userId: user.id },
    include: { asset: true },
    orderBy: { createdAt: 'desc' },
    take: 15,
  });
  console.log('\nRecent deposits:');
  for (const d of deposits) {
    console.log(
      `${d.status} ${d.asset.symbol} ${d.amount.toString()} network=${d.network} tx=${d.txHash?.slice(0, 12)}`,
    );
  }

  const usdtTron = await prisma.tokenContract.findFirst({
    where: {
      asset: { symbol: 'USDT' },
      network: { chainKey: 'tron-nile' },
      standard: 'TRC20',
    },
    include: { network: true, asset: true },
  });
  console.log('\nUSDT tron-nile contract:', usdtTron
    ? {
        depositEnabled: usdtTron.depositEnabled,
        address: usdtTron.address,
        verified: Boolean(usdtTron.contractVerifiedAt),
      }
    : 'missing');

  await prisma.$disconnect();
}

main();
