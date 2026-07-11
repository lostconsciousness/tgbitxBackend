import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { OnchainReadinessService } from '../src/modules/onchain/onchain-readiness.service';
import { createPublicClient, formatEther, formatUnits, getAddress, http, parseAbi } from 'viem';
import { arbitrum, bsc } from 'viem/chains';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const readiness = app.get(OnchainReadinessService);
    for (const network of ['arbitrum', 'bnb']) {
      const state = await readiness.getReadiness(network);
      console.log(`\n${network} readiness:`, {
        withdrawalReady: state.workers.withdrawal.ready,
        issues: state.issues,
      });
    }

    const treasury = getAddress(process.env.DEPOSIT_TREASURY_ADDRESS!);
    const hot = getAddress(process.env.WITHDRAWAL_HOT_ADDRESS!);
    const abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

    const arbClient = createPublicClient({
      chain: arbitrum,
      transport: http(process.env.ARBITRUM_RPC_PRIMARY_URL ?? 'https://arb1.arbitrum.io/rpc'),
    });
    const arbUsdt = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
    const readUsdt = async (client: typeof arbClient, token: string, addr: string) =>
      formatUnits(
        (await client.readContract({
          address: getAddress(token),
          abi,
          functionName: 'balanceOf',
          args: [getAddress(addr)],
        })) as bigint,
        6,
      );

    console.log('\nArbitrum USDT');
    console.log('  treasury:', await readUsdt(arbClient, arbUsdt, treasury));
    console.log('  hot:', await readUsdt(arbClient, arbUsdt, hot));
    console.log('  hot ETH:', formatEther(await arbClient.getBalance({ address: hot })));
  } finally {
    await app.close();
  }
}

main().catch(console.error);
