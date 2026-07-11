import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const sol = await prisma.asset.findUnique({ where: { symbol: 'SOL' } });
  if (!sol) return;

  const contracts = await prisma.tokenContract.findMany({
    where: { assetId: sol.id },
    include: { network: true },
  });
  console.log('SOL token contracts:');
  for (const c of contracts) {
    console.log({
      chainKey: c.network.chainKey,
      mainnet: c.network.mainnet,
      networkWithdrawal: c.network.withdrawalEnabled,
      assetWithdrawal: c.withdrawalEnabled,
      verified: c.contractVerifiedAt != null,
    });
  }

  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (!user) return;

  const { LedgerService } = await import('../src/modules/ledger/ledger.service');
  const ledger = new LedgerService(prisma as never);
  const full = await ledger.getUserSpotBalance({ userId: user.id, assetId: sol.id });
  const mainnet = await ledger.getUserMainnetSpotBalance({ userId: user.id, assetId: sol.id });
  console.log('\nSOL balances:', { full: full.toString(), mainnetScoped: mainnet.toString() });

  const deps = await prisma.deposit.findMany({
    where: { userId: user.id, assetId: sol.id, status: 'CREDITED' },
    include: { tokenContract: { include: { network: true } } },
  });
  console.log('\nSOL credited deposits:');
  for (const d of deps) {
    console.log({
      amount: d.amount.toString(),
      network: d.tokenContract?.network?.chainKey ?? d.network,
      mainnet: d.tokenContract?.network?.mainnet,
    });
  }
}

main().finally(() => prisma.$disconnect());
