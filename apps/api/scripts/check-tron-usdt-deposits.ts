import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (!user) {
    console.log('user not found');
    return;
  }

  const tronAddresses = await prisma.userDepositAddress.findMany({
    where: { userId: user.id, network: 'TRON_NILE', status: 'ACTIVE' },
  });
  console.log('TRON deposit addresses:', tronAddresses);

  const usdtContract = await prisma.tokenContract.findFirst({
    where: {
      asset: { symbol: 'USDT' },
      network: { chainKey: 'tron-nile' },
      standard: 'TRC20',
    },
    include: { network: true, asset: true },
  });
  console.log('USDT contract:', usdtContract?.id, usdtContract?.address);

  const cursors = await prisma.depositIndexerCursor.findMany({
    where: { network: { chainKey: 'tron-nile' } },
    include: { tokenContract: { include: { asset: true } } },
  });
  console.log('\nIndexer cursors tron-nile:');
  for (const c of cursors) {
    console.log(
      `  ${c.tokenContract.asset.symbol} lastBlock=${c.lastBlock.toString()} key=${c.key}`,
    );
  }

  const usdtDeposits = await prisma.deposit.findMany({
    where: { asset: { symbol: 'USDT' } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  console.log('\nAll USDT deposits:', usdtDeposits.length);
  for (const d of usdtDeposits) {
    console.log(`  ${d.status} ${d.amount} ${d.network} ${d.txHash}`);
  }

  const contractAddr = usdtContract?.address;
  const rpc = process.env.TRON_NILE_RPC_PRIMARY_URL ?? 'https://nile.trongrid.io';

  for (const addr of tronAddresses) {
    console.log(`\n--- TronGrid for ${addr.address} ---`);
    const nativeUrl = `${rpc}/v1/accounts/${addr.address}/transactions?only_to=true&limit=5`;
    const nativeRes = await fetch(nativeUrl);
    console.log('native tx status:', nativeRes.status);
    const nativeData = (await nativeRes.json()) as any;
    console.log('native tx count:', nativeData.data?.length ?? 0);

    if (contractAddr) {
      const trc20Url = `${rpc}/v1/accounts/${addr.address}/transactions/trc20?only_to=true&contract_address=${contractAddr}&limit=20`;
      const trc20Res = await fetch(trc20Url);
      console.log('trc20 tx status:', trc20Res.status);
      const trc20Data = (await trc20Res.json()) as any;
      const txs = trc20Data.data ?? [];
      console.log('trc20 tx count:', txs.length);
      for (const tx of txs.slice(0, 5)) {
        console.log(
          `  tx=${tx.transaction_id?.slice(0, 16)} block=${tx.block_number ?? tx.blockNumber} value=${tx.value} from=${tx.from} to=${tx.to}`,
        );
      }
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
