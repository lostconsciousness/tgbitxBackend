import { PrismaClient } from '@prisma/client';
import { createPublicClient, formatUnits, getAddress, http, parseAbi } from 'viem';
import { bsc } from 'viem/chains';

async function main() {
  const prisma = new PrismaClient();
  const depositAddress = getAddress('0x4393bf55240855ef78f01d103ce17ee5a1227906');
  const tokenContract = await prisma.tokenContract.findFirst({
    where: {
      network: { chainKey: 'bnb' },
      asset: { symbol: 'USDT' },
    },
    include: { asset: true },
  });
  if (!tokenContract?.address) {
    console.log('USDT token contract on bnb not found');
    return;
  }

  const rpc =
    process.env.BNB_RPC_FALLBACK_URL?.trim() ||
    process.env.BNB_RPC_PRIMARY_URL?.trim() ||
    'https://bsc-dataseed.binance.org';
  const client = createPublicClient({ chain: bsc, transport: http(rpc) });
  const balance = (await client.readContract({
    address: getAddress(tokenContract.address),
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [depositAddress],
  })) as bigint;

  const pending = await prisma.deposit.count({
    where: {
      toAddress: depositAddress.toLowerCase(),
      network: 'BNB',
      status: { in: ['DETECTED', 'PENDING_CONFIRMATION'] },
    },
  });
  const credited = await prisma.deposit.count({
    where: {
      toAddress: depositAddress.toLowerCase(),
      network: 'BNB',
      status: 'CREDITED',
    },
  });

  console.log('rpc', rpc.replace(/\/[^/]{20,}$/, '/<redacted>'));
  console.log('depositAddress', depositAddress);
  console.log('usdtOnChain', formatUnits(balance, tokenContract.decimals));
  console.log('dbPendingDeposits', pending);
  console.log('dbCreditedDeposits', credited);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
