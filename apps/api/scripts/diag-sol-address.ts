import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const addr = process.argv[2] ?? '41L4BZdSYrtjXMMWGUXDhuV2EXW49XYkjG4MH6rSQD9H';

async function main() {
  const p = new PrismaClient();
  const depositAddr = await p.userDepositAddress.findFirst({
    where: { address: addr },
    include: { user: { select: { email: true } } },
  });
  const sweeps = await p.depositSweep.findMany({
    where: { depositAddress: { address: addr } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { asset: true },
  });
  const credits = await p.deposit.findMany({
    where: { toAddress: addr },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { asset: true },
  });
  const allSol = await p.userDepositAddress.findMany({
    where: { network: 'SOLANA' },
    select: {
      address: true,
      provider: true,
      status: true,
      user: { select: { email: true } },
    },
  });
  const reserveSweeps = await p.depositSweep.findMany({
    where: { depositAddress: { network: 'SOLANA', provider: 'PRIVY' } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { depositAddress: true, asset: true },
  });

  console.log(JSON.stringify({
    queriedAddress: addr,
    isReserveInEnv: process.env.SOLANA_WITHDRAWAL_HOT_ADDRESS === addr,
    privySolanaWalletId: process.env.PRIVY_SOLANA_WALLET_ID ?? null,
    depositAddr,
    sweeps: sweeps.map((s) => ({
      id: s.id,
      status: s.status,
      rawAmount: s.rawAmount,
      failureReason: s.failureReason,
      txHash: s.txHash,
      asset: s.asset.symbol,
    })),
    credits: credits.map((c) => ({
      status: c.status,
      rawAmount: c.rawAmount,
      asset: c.asset.symbol,
    })),
    allSolMainnetAddresses: allSol,
    recentSolSweeps: reserveSweeps.map((s) => ({
      id: s.id,
      status: s.status,
      depositAddress: s.depositAddress.address,
      provider: s.depositAddress.provider,
      failureReason: s.failureReason,
      rawAmount: s.rawAmount,
    })),
  }, null, 2));
  await p.$disconnect();
}

void main();
