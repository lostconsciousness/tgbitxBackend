import { PrismaClient } from '@prisma/client';
import { createPublicClient, formatEther, formatUnits, getAddress, http, parseAbi } from 'viem';
import { bsc, arbitrum } from 'viem/chains';

async function nativeBalance(rpc: string, address: string) {
  const client = createPublicClient({ chain: bsc, transport: http(rpc) });
  const wei = await client.getBalance({ address: getAddress(address) });
  return formatEther(wei);
}

async function erc20Balance(rpc: string, token: string, address: string, decimals: number) {
  const client = createPublicClient({ chain: bsc, transport: http(rpc) });
  const raw = (await client.readContract({
    address: getAddress(token),
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [getAddress(address)],
  })) as bigint;
  return formatUnits(raw, decimals);
}

async function main() {
  const prisma = new PrismaClient();
  const sweepGas = process.env.SWEEP_GAS_ADDRESS ?? '0x06a06b19eb5f498c3082429848b079ab1a4f2f15';
  const deposit = '0x4393bf55240855ef78f01d103ce17ee5a1227906';
  const bnbRpc = process.env.BNB_RPC_PRIMARY_URL ?? 'https://bsc-dataseed.binance.org';
  const arbRpc = process.env.ARBITRUM_RPC_PRIMARY_URL ?? 'https://arb1.arbitrum.io/rpc';

  const bnbSweepGas = await prisma.custodyAccount.findUnique({
    where: { role_network: { role: 'SWEEP_GAS', network: 'BNB' } },
  });
  console.log('SWEEP_GAS BNB custody row:', bnbSweepGas?.address ?? 'MISSING');

  const sweeps = await prisma.depositSweep.findMany({
    where: { status: { in: ['PENDING', 'FUNDING_GAS', 'BROADCASTING'] } },
    include: { depositAddress: true, asset: true },
  });
  console.log('\nActive sweeps:');
  for (const s of sweeps) {
    console.log(`${s.id} | ${s.status} | ${s.asset.symbol} ${s.amount} | ${s.depositAddress.network} | gasTx=${s.gasFundingTxHash ?? 'none'} | fail=${s.failureReason ?? 'none'}`);
  }

  console.log('\nBSC balances:');
  console.log('SWEEP_GAS BNB:', await nativeBalance(bnbRpc, sweepGas));
  console.log('Deposit BNB:', await nativeBalance(bnbRpc, deposit));
  const usdt = await prisma.tokenContract.findFirst({
    where: { network: { chainKey: 'bnb' }, asset: { symbol: 'USDT' } },
  });
  if (usdt?.address) {
    console.log('Deposit USDT:', await erc20Balance(bnbRpc, usdt.address, deposit, usdt.decimals));
  }

  const arbClient = createPublicClient({ chain: arbitrum, transport: http(arbRpc) });
  const arbEth = await arbClient.getBalance({ address: getAddress(sweepGas) });
  console.log('\nArbitrum SWEEP_GAS ETH:', formatEther(arbEth));

  await prisma.$disconnect();
}

main().catch(console.error);
