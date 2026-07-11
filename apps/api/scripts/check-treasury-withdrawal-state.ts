import { PrismaClient } from '@prisma/client';
import { createPublicClient, formatEther, formatUnits, getAddress, http, parseAbi } from 'viem';
import { arbitrum, bsc } from 'viem/chains';

async function main() {
  const prisma = new PrismaClient();
  const treasury = getAddress('0xafc991ba121e3e8a96c248b9d83de4d543c09631');
  const hot = getAddress('0xea0166f55ee7fbdbca3975c06af9abeb24c99603');
  const sweepGas = getAddress('0x06a06b19eb5f498c3082429848b079ab1a4f2f15');
  const arbDeposit = getAddress('0xdbcd28841368cab19522ead7192766b987273472');

  const bnbRpc = process.env.BNB_RPC_PRIMARY_URL ?? 'https://bsc-dataseed.binance.org';
  const arbRpc = process.env.ARBITRUM_RPC_PRIMARY_URL ?? 'https://arb1.arbitrum.io/rpc';
  const bscClient = createPublicClient({ chain: bsc, transport: http(bnbRpc) });
  const arbClient = createPublicClient({ chain: arbitrum, transport: http(arbRpc) });

  const bnbUsdt = await prisma.tokenContract.findFirst({
    where: { network: { chainKey: 'bnb' }, asset: { symbol: 'USDT' } },
  });
  const arbUsdt = await prisma.tokenContract.findFirst({
    where: { network: { chainKey: 'arbitrum' }, asset: { symbol: 'USDT' } },
  });

  async function usdt(client: typeof bscClient, token: string, addr: string, dec: number) {
    const raw = (await client.readContract({
      address: getAddress(token),
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [addr],
    })) as bigint;
    return formatUnits(raw, dec);
  }

  console.log('SWEEP_GAS');
  console.log('  BSC BNB:', formatEther(await bscClient.getBalance({ address: sweepGas })));
  console.log('  Arb ETH:', formatEther(await arbClient.getBalance({ address: sweepGas })));

  console.log('\nTREASURY (2nd screen)', treasury);
  if (bnbUsdt?.address) {
    console.log('  BSC USDT:', await usdt(bscClient, bnbUsdt.address, treasury, bnbUsdt.decimals));
  }
  console.log('  ETH mainnet ETH: (not shown - treasury is same address, 0 on L1)');

  console.log('\nHOT WALLET', hot);
  if (bnbUsdt?.address) {
    console.log('  BSC USDT:', await usdt(bscClient, bnbUsdt.address, hot, bnbUsdt.decimals));
  }

  console.log('\nARBITRUM DEPOSIT (4.9 USDT stuck)', arbDeposit);
  console.log('  ETH:', formatEther(await arbClient.getBalance({ address: arbDeposit })));
  if (arbUsdt?.address) {
    console.log('  USDT:', await usdt(arbClient, arbUsdt.address, arbDeposit, arbUsdt.decimals));
  }

  const tc = await prisma.tokenContract.findFirst({
    where: { network: { chainKey: 'bnb' }, asset: { symbol: 'USDT' } },
  });
  console.log('\nBNB USDT withdrawal limits:', {
    min: tc?.minWithdrawalAmount?.toString(),
    fee: tc?.withdrawalFeeAmount?.toString(),
  });

  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (user && bnbUsdt) {
    const account = await prisma.ledgerAccount.findUnique({
      where: { key: `USER_SPOT:${bnbUsdt.assetId}:${user.id}` },
    });
    console.log('\nUser ledger USDT spot account exists:', Boolean(account));
  }

  await prisma.$disconnect();
}

main().catch(console.error);
