import { PrismaClient } from '@prisma/client';
import { createPublicClient, formatEther, formatUnits, getAddress, http, parseAbi } from 'viem';
import { bsc } from 'viem/chains';

const prisma = new PrismaClient();

async function main() {
  const withdrawals = await prisma.withdrawal.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      asset: true,
      tokenContract: { include: { network: true } },
      user: { select: { email: true } },
    },
  });
  console.log('Recent withdrawals:');
  for (const withdrawal of withdrawals) {
    console.log({
      id: withdrawal.id,
      user: withdrawal.user.email,
      status: withdrawal.status,
      amount: withdrawal.amount.toString(),
      fee: withdrawal.feeAmount.toString(),
      asset: withdrawal.asset.symbol,
      network: withdrawal.tokenContract?.network?.chainKey,
      lastBroadcastError: withdrawal.lastBroadcastError,
      broadcastAttempts: withdrawal.broadcastAttempts,
      txHash: withdrawal.txHash,
      approvedAt: withdrawal.approvedAt,
    });
  }

  const hot = getAddress(process.env.WITHDRAWAL_HOT_ADDRESS ?? '0xea0166f55ee7fbdbca3975c06af9abeb24c99603');
  const treasury = getAddress(process.env.DEPOSIT_TREASURY_ADDRESS ?? '0xafc991ba121e3e8a96c248b9d83de4d543c09631');
  const bnbRpc = process.env.BNB_RPC_PRIMARY_URL ?? 'https://bsc-dataseed.binance.org';
  const client = createPublicClient({ chain: bsc, transport: http(bnbRpc) });
  const usdt = await prisma.tokenContract.findFirst({
    where: { network: { chainKey: 'bnb' }, asset: { symbol: 'USDT' } },
  });
  if (usdt?.address) {
    const abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
    const read = async (addr: string) =>
      formatUnits(
        (await client.readContract({
          address: getAddress(usdt.address!),
          abi,
          functionName: 'balanceOf',
          args: [getAddress(addr)],
        })) as bigint,
        usdt.decimals,
      );
    console.log('\nOn-chain BSC USDT:');
    console.log('  treasury:', await read(treasury));
    console.log('  hot:', await read(hot));
    console.log('  hot BNB:', formatEther(await client.getBalance({ address: hot })));
  }
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
