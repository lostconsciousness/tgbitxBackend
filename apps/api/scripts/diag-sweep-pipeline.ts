import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const userId = process.argv[2] ?? 'cmq88gpyn0005b96wc3pinvaj';

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });
  console.log('USER', user);

  const addrs = await prisma.userDepositAddress.findMany({
    where: { userId },
    include: { _count: { select: { deposits: true, sweeps: true } } },
  });
  console.log('\nDEPOSIT_ADDRESSES');
  for (const a of addrs) {
    console.log(
      `${a.network} | ${a.provider} | ${a.status} | ${a.address} | walletRef=${a.providerWalletRef ? 'yes' : 'no'} | deps=${a._count.deposits} sweeps=${a._count.sweeps}`,
    );
  }

  const deps = await prisma.deposit.findMany({
    where: { userId },
    include: { asset: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  console.log('\nDEPOSITS');
  for (const d of deps) {
    console.log(
      `${d.status} | ${d.asset.symbol} | ${d.amount} | ${d.network} | sweep=${d.sweepId ?? 'none'} | ${d.txHash?.slice(0, 22) ?? 'no-tx'}`,
    );
  }

  const sweeps = await prisma.depositSweep.findMany({
    orderBy: { createdAt: 'desc' },
    take: 25,
    include: {
      asset: true,
      depositAddress: { select: { network: true, address: true, provider: true } },
    },
  });
  console.log('\nSWEEPS');
  for (const s of sweeps) {
    console.log(
      `${s.status} | ${s.asset.symbol} | ${s.amount} | ${s.depositAddress.network} | ${s.depositAddress.provider} | tx=${s.txHash?.slice(0, 22) ?? 'none'} | ${(s.failureReason ?? '').slice(0, 100)}`,
    );
  }

  const transfers = await prisma.treasuryTransfer.findMany({
    orderBy: { createdAt: 'desc' },
    take: 15,
    include: { asset: true, sourceAccount: true, destinationAccount: true },
  });
  console.log('\nTREASURY_TRANSFERS');
  for (const t of transfers) {
    console.log(
      `${t.status} | ${t.asset.symbol} | ${t.amount} | ${t.sourceAccount.network} ${t.sourceAccount.role} -> ${t.destinationAccount.role} | tx=${t.txHash?.slice(0, 22) ?? 'none'}`,
    );
  }

  const custody = await prisma.custodyAccount.findMany({
    where: { status: 'ACTIVE', network: 'ETHEREUM' },
    orderBy: { role: 'asc' },
  });
  console.log('\nETHEREUM_CUSTODY');
  for (const c of custody) {
    console.log(`${c.role} | ${c.address} | ref=${c.providerWalletRef ? 'yes' : 'no'}`);
  }

  const sweepCounts = await prisma.depositSweep.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  console.log('\nSWEEP_STATUS_COUNTS', sweepCounts);

  const usdtDeps = await prisma.deposit.findMany({
    where: { asset: { symbol: 'USDT' } },
    include: { asset: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log('\nUSDT_DEPOSITS');
  for (const d of usdtDeps) {
    console.log(`${d.status} | ${d.network} | ${d.amount} | user=${d.userId?.slice(0, 8) ?? 'none'} | sweep=${d.sweepId ?? 'none'}`);
  }

  for (const network of ['ETHEREUM', 'BNB', 'ARBITRUM'] as const) {
    const count = await prisma.deposit.count({ where: { network } });
    console.log(`\n${network}_MAINNET_DEPOSIT_COUNT`, count);
  }

  const sweepGas = await prisma.custodyAccount.findMany({
    where: { role: 'SWEEP_GAS', status: 'ACTIVE' },
    take: 5,
  });
  console.log('\nSWEEP_GAS_ACCOUNTS', sweepGas.length);
  for (const g of sweepGas) {
    console.log(`${g.network} | ${g.address} | ref=${g.providerWalletRef ? 'yes' : 'no'}`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
