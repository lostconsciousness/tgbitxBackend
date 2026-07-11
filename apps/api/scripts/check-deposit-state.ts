import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (!user) {
    console.log('user not found');
    return;
  }

  console.log('User:', user.id, user.email);

  const addresses = await prisma.userDepositAddress.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    orderBy: { network: 'asc' },
  });
  console.log('\nDeposit addresses:');
  for (const a of addresses) {
    console.log(`  ${a.network} ${a.address} id=${a.id}`);
  }

  const assets = await prisma.asset.findMany({
    where: { symbol: { in: ['SOL', 'TRX', 'USDT'] } },
  });

  console.log('\nLedger balances:');
  for (const asset of assets) {
    const account = await prisma.ledgerAccount.findUnique({
      where: { key: `USER_SPOT:${asset.id}:${user.id}` },
    });
    if (!account) {
      console.log(`  ${asset.symbol}: (no account)`);
      continue;
    }
    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: account.id, transaction: { status: 'POSTED' } },
      select: { direction: true, amount: true },
    });
    let bal = 0;
    for (const e of entries) {
      bal += e.direction === 'CREDIT' ? Number(e.amount) : -Number(e.amount);
    }
    console.log(`  ${asset.symbol}: ${bal}`);
  }

  const deposits = await prisma.deposit.findMany({
    where: { userId: user.id },
    include: { asset: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  console.log('\nRecent deposits:');
  for (const d of deposits) {
    console.log(
      `  ${d.createdAt.toISOString()} ${d.status} ${d.asset.symbol} ${d.amount} ${d.network} tx=${d.txHash?.slice(0, 20)} conf=${d.confirmations}`,
    );
  }

  const pending = await prisma.deposit.findMany({
    where: { status: { in: ['PENDING_CONFIRMATION', 'DETECTED'] } },
    include: { asset: true },
  });
  console.log('\nPending deposits:', pending.length);
  for (const d of pending) {
    console.log(`  ${d.asset.symbol} ${d.amount} ${d.network} tx=${d.txHash} conf=${d.confirmations}`);
  }

  const cursors = await prisma.depositIndexerCursor.findMany({
    where: {
      network: { chainKey: { in: ['solana-devnet', 'tron-nile'] } },
    },
    include: { tokenContract: { include: { asset: true } }, network: true },
  });
  console.log('\nIndexer cursors:');
  for (const c of cursors) {
    console.log(`  ${c.network.chainKey} ${c.tokenContract.asset.symbol} lastBlock=${c.lastBlock}`);
  }

  const intents = await prisma.depositIntent.findMany({
    where: { userId: user.id, status: { not: 'COMPLETED' } },
    include: { asset: true, tokenContract: { include: { network: true } } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log('\nOpen deposit intents:');
  for (const i of intents) {
    console.log(
      `  ${i.status} ${i.asset.symbol} ${i.amount} network=${i.tokenContract?.network?.chainKey} tx=${i.txHash?.slice(0, 20)}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
