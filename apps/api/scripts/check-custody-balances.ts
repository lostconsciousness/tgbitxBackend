import { PrismaClient, TokenStandard } from '@prisma/client';
import { createPublicClient, formatEther, formatUnits, http } from 'viem';
import { arbitrumSepolia } from 'viem/chains';

async function main() {
  const prisma = new PrismaClient();
  const rpcUrl = process.env.ARBITRUM_RPC_PRIMARY_URL ?? 'https://sepolia-rollup.arbitrum.io/rpc';
  const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
  const usdcAddress = process.env.ARBITRUM_SEPOLIA_USDC_ADDRESS?.toLowerCase();

  const accounts = await prisma.custodyAccount.findMany({
    where: { status: 'ACTIVE', network: 'ARBITRUM_SEPOLIA' },
  });

  for (const account of accounts) {
    const eth = await client.getBalance({ address: account.address as `0x${string}` });
    let usdc = '0';
    if (usdcAddress) {
      try {
        const raw = (await client.readContract({
          address: usdcAddress as `0x${string}`,
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
          args: [account.address as `0x${string}`],
        })) as bigint;
        usdc = formatUnits(raw, 6);
      } catch {
        usdc = 'n/a';
      }
    }
    console.log(
      `${account.role} ${account.address} ETH=${formatEther(eth)} USDC=${usdc}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
