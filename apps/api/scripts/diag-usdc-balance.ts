import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  const usdc = await prisma.asset.findUnique({ where: { symbol: 'USDC' } });
  if (!user || !usdc) {
    console.log('user or USDC not found');
    return;
  }

  const spotKey = `USER_SPOT:${usdc.id}:${user.id}`;
  const spot = await prisma.ledgerAccount.findUnique({ where: { key: spotKey } });

  console.log('=== USDC USER_SPOT ledger entries ===');
  if (spot) {
    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: spot.id },
      include: { transaction: true },
      orderBy: { createdAt: 'asc' },
    });
    let balance = 0;
    for (const e of entries) {
      const delta = e.direction === 'CREDIT' ? Number(e.amount) : -Number(e.amount);
      balance += delta;
      console.log({
        direction: e.direction,
        amount: e.amount.toString(),
        type: e.transaction.type,
        status: e.transaction.status,
        ref: e.transaction.referenceId,
        createdAt: e.createdAt,
        runningBalance: balance,
      });
    }
    console.log('Computed spot balance:', balance);
  } else {
    console.log('No USER_SPOT account for USDC');
  }

  const deposits = await prisma.deposit.findMany({
    where: { userId: user.id, assetId: usdc.id },
    include: { tokenContract: { include: { network: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log('\n=== USDC deposits (all statuses) ===');
  for (const d of deposits) {
    console.log({
      id: d.id,
      amount: d.amount.toString(),
      status: d.status,
      network: d.tokenContract?.network?.chainKey ?? d.network,
      mainnet: d.tokenContract?.network?.mainnet,
      txHash: d.txHash,
      logIndex: d.logIndex,
      channel: d.channel,
      createdAt: d.createdAt,
    });
  }

  const { LedgerService } = await import('../src/modules/ledger/ledger.service');
  const ledger = new LedgerService(prisma as never);
  const full = await ledger.getUserSpotBalance({ userId: user.id, assetId: usdc.id });
  const mainnetBal = await ledger.getUserMainnetSpotBalance({ userId: user.id, assetId: usdc.id });
  console.log('\nUSER_SPOT full:', full.toString());
  console.log('USER_SPOT mainnet-scoped:', mainnetBal.toString());

  const testnetCredits = await ledger['sumCreditedDepositCredits'](
    { userId: user.id, assetId: usdc.id, mainnet: false },
    prisma as never,
  );
  console.log('Testnet DEPOSIT_CREDIT sum (subtracted in mainnet view):', testnetCredits.toString());

  for (const id of ['cmqqw5dlf000jtcqeuhtikejy', 'cmqqwprb0001gtcqe9lzagnak', 'cmqskfhkp000tbhib7kw6c0i1']) {
    const d = await prisma.deposit.findUnique({
      where: { id },
      include: { tokenContract: { include: { network: true } } },
    });
    console.log('deposit network tag:', {
      id,
      legacyNetwork: d?.network,
      tokenContractId: d?.tokenContractId,
      chainKey: d?.tokenContract?.network?.chainKey,
      mainnet: d?.tokenContract?.network?.mainnet,
    });
  }

  for (const id of ['cmqqxgsmu000r4ob2m61t5le5', 'cmqqxu6es00164ob2skfuqu40', 'cmqqxyhd4002a4ob2ops7pdu3']) {
    const tx = await prisma.ledgerTransaction.findUnique({
      where: { id },
      select: { id: true, type: true, description: true, metadata: true, createdAt: true },
    });
    console.log('admin adjustment:', tx);
  }
}

main().finally(() => prisma.$disconnect());
