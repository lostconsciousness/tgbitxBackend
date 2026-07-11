import { PrismaClient, TokenStandard } from '@prisma/client';
import { createPublicClient, formatEther, formatUnits, getAddress, http } from 'viem';
import { mainnet } from 'viem/chains';

async function main() {
  const prisma = new PrismaClient();
  const rpcUrl =
    process.env.ETHEREUM_RPC_FALLBACK_URL?.trim() ||
    process.env.ETHEREUM_RPC_PRIMARY_URL?.trim() ||
    'https://ethereum-rpc.publicnode.com';
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  const usdc = await prisma.tokenContract.findFirst({
    where: {
      standard: TokenStandard.ERC20,
      network: { chainKey: 'ethereum' },
      asset: { symbol: 'USDC' },
    },
  });

  const accounts = await prisma.custodyAccount.findMany({
    where: { status: 'ACTIVE', network: 'ETHEREUM' },
    orderBy: { role: 'asc' },
  });

  console.log('RPC', rpcUrl.replace(/\/v2\/[^/]+$/, '/v2/<redacted>'));
  console.log('USDC contract', usdc?.address ?? 'missing');

  for (const account of accounts) {
    const address = getAddress(account.address);
    const eth = await client.getBalance({ address });
    let usdcBal = 'n/a';
    if (usdc?.address) {
      try {
        const raw = (await client.readContract({
          address: getAddress(usdc.address),
          abi: [
            {
              name: 'balanceOf',
              type: 'function',
              stateMutability: 'view',
              inputs: [{ name: 'account', type: 'address' }],
              outputs: [{ name: 'balance', type: 'uint256' }],
            },
          ],
          functionName: 'balanceOf',
          args: [address],
        })) as bigint;
        usdcBal = formatUnits(raw, usdc.decimals);
      } catch {
        usdcBal = 'error';
      }
    }
    console.log(`${account.role} ${address} ETH=${formatEther(eth)} USDC=${usdcBal}`);
  }

  const privyDeposits = await prisma.userDepositAddress.findMany({
    where: { provider: 'PRIVY', status: 'ACTIVE', network: 'ETHEREUM' },
    take: 5,
  });
  console.log('\nETHEREUM PRIVY DEPOSIT ADDRESSES', privyDeposits.length);
  for (const row of privyDeposits) {
    const address = getAddress(row.address);
    const eth = await client.getBalance({ address });
    console.log(`${row.userId.slice(0, 8)} ${address} ETH=${formatEther(eth)}`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
