import { PrismaClient, LedgerTransactionType, WithdrawalStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const withdrawalId = 'cmqwpisnh0038ytrdr2u247uq';
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  const usdt = await prisma.asset.findUnique({ where: { symbol: 'USDT' } });
  if (!user || !usdt) {
    console.log('user or usdt missing');
    return;
  }

  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
    include: { tokenContract: { include: { network: true } } },
  });
  console.log('Withdrawal:', {
    status: withdrawal?.status,
    amount: withdrawal?.amount.toString(),
    fee: withdrawal?.feeAmount.toString(),
    txHash: withdrawal?.txHash,
    network: withdrawal?.tokenContract?.network?.chainKey,
  });

  const spotKey = `USER_SPOT:${usdt.id}:${user.id}`;
  const spot = await prisma.ledgerAccount.findUnique({ where: { key: spotKey } });
  if (spot) {
    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: spot.id, transaction: { status: 'POSTED' } },
      include: { transaction: true },
      orderBy: { createdAt: 'asc' },
    });
    let balance = 0;
    console.log('\nUSER_SPOT ledger (all posted):');
    for (const e of entries) {
      const sign = e.direction === 'CREDIT' ? 1 : -1;
      balance += sign * Number(e.amount);
      console.log(
        `${e.direction} ${e.amount.toString().padStart(8)} ${e.transaction.type.padEnd(22)} ${e.transaction.description ?? ''}`,
      );
    }
    console.log('Computed USER_SPOT balance:', balance);
  }

  const pendingKey = `PENDING_WITHDRAWAL:${usdt.id}:platform`;
  const pending = await prisma.ledgerAccount.findUnique({ where: { key: pendingKey } });
  if (pending) {
    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: pending.id, transaction: { status: 'POSTED' } },
      include: { transaction: true },
    });
    let balance = 0;
    console.log('\nPENDING_WITHDRAWAL ledger:');
    for (const e of entries) {
      const sign = e.direction === 'CREDIT' ? 1 : -1;
      balance += sign * Number(e.amount);
      console.log(`${e.direction} ${e.amount.toString()} ${e.transaction.type} ref=${e.transaction.referenceId}`);
    }
    console.log('Computed PENDING_WITHDRAWAL balance:', balance);
  }

  const feesKey = `GAS_FEES:${usdt.id}:platform`;
  const fees = await prisma.ledgerAccount.findUnique({ where: { key: feesKey } });
  if (fees) {
    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: fees.id, transaction: { status: 'POSTED' } },
      include: { transaction: true },
    });
    let balance = 0;
    console.log('\nGAS_FEES ledger:');
    for (const e of entries) {
      const sign = e.direction === 'CREDIT' ? 1 : -1;
      balance += sign * Number(e.amount);
      console.log(`${e.direction} ${e.amount.toString()} ${e.transaction.type} ref=${e.transaction.referenceId}`);
    }
    console.log('Computed GAS_FEES balance:', balance);
  }

  const clearingKey = `PROVIDER_CLEARING:${usdt.id}:platform`;
  const clearing = await prisma.ledgerAccount.findUnique({ where: { key: clearingKey } });
  if (clearing) {
    const entries = await prisma.ledgerEntry.findMany({
      where: {
        accountId: clearing.id,
        transaction: { referenceId: withdrawalId },
      },
      include: { transaction: true },
    });
    console.log('\nPROVIDER_CLEARING entries for withdrawal:', entries.map((e) => ({
      direction: e.direction,
      amount: e.amount.toString(),
      type: e.transaction.type,
    })));
  }

  const mainnetCredits = await prisma.ledgerEntry.findMany({
    where: {
      accountId: spot!.id,
      direction: 'CREDIT',
      transaction: {
        status: 'POSTED',
        type: LedgerTransactionType.DEPOSIT_CREDIT,
        creditedDeposit: {
          userId: user.id,
          status: 'CREDITED',
          tokenContract: { network: { mainnet: true } },
        },
      },
    },
    select: { amount: true },
  });
  const mainnetSum = mainnetCredits.reduce((s, e) => s + Number(e.amount), 0);
  console.log('\nMainnet-only DEPOSIT_CREDIT sum (UI available logic):', mainnetSum);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
