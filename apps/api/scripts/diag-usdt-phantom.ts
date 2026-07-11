import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  const usdt = await prisma.asset.findUnique({ where: { symbol: 'USDT' } });
  if (!user || !usdt) return;

  const deposits = await prisma.deposit.findMany({
    where: { userId: user.id, assetId: usdt.id, status: 'CREDITED' },
    include: {
      tokenContract: { include: { network: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log('Credited USDT deposits:');
  let mainnetSum = 0;
  for (const d of deposits) {
    const amt = Number(d.amount);
    const mainnet = d.tokenContract?.network?.mainnet ?? false;
    if (mainnet) mainnetSum += amt;
    console.log({
      id: d.id,
      amount: d.amount.toString(),
      network: d.tokenContract?.network?.chainKey ?? d.network,
      mainnet,
      txHash: d.txHash,
      channel: d.channel,
      createdAt: d.createdAt,
    });
  }
  console.log('\nSum mainnet credited deposits:', mainnetSum);

  const spotKey = `USER_SPOT:${usdt.id}:${user.id}`;
  const spot = await prisma.ledgerAccount.findUnique({ where: { key: spotKey } });
  if (spot) {
    const credits = await prisma.ledgerEntry.findMany({
      where: {
        accountId: spot.id,
        direction: 'CREDIT',
        transaction: { type: 'DEPOSIT_CREDIT', status: 'POSTED' },
      },
      include: {
        transaction: {
          include: {
            creditedDeposit: {
              include: { tokenContract: { include: { network: true } } },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    console.log('\nDEPOSIT_CREDIT entries on USER_SPOT:');
    for (const e of credits) {
      const dep = e.transaction.creditedDeposit;
      console.log({
        amount: e.amount.toString(),
        network: dep?.tokenContract?.network?.chainKey ?? dep?.network,
        mainnet: dep?.tokenContract?.network?.mainnet,
        txHash: dep?.txHash,
        depositId: dep?.id,
        createdAt: e.createdAt,
      });
    }
  }

  const { LedgerService } = await import('../src/modules/ledger/ledger.service');
  const ledger = new LedgerService(prisma as never);
  const full = await ledger.getUserSpotBalance({ userId: user.id, assetId: usdt.id });
  const mainnetBal = await ledger.getUserMainnetSpotBalance({ userId: user.id, assetId: usdt.id });
  console.log('\nUSER_SPOT full:', full.toString());
  console.log('USER_SPOT mainnet-scoped:', mainnetBal.toString());
}

main()
  .finally(() => prisma.$disconnect());
