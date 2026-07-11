import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';
import { createPublicClient, formatEther, getAddress, http } from 'viem';
import { arbitrum } from 'viem/chains';

async function main() {
  const sweepGas = getAddress('0x06a06b19eb5f498c3082429848b079ab1a4f2f15');
  const deposit = getAddress('0xdbcd28841368cab19522ead7192766b987273472');
  const rpc = 'https://arb1.arbitrum.io/rpc';
  const client = createPublicClient({ chain: arbitrum, transport: http(rpc) });

  console.log('Arbitrum native gas token = ETH (not ARB token)');
  console.log('SWEEP_GAS ETH:', formatEther(await client.getBalance({ address: sweepGas })));
  console.log('Deposit ETH:', formatEther(await client.getBalance({ address: deposit })));

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const custody = app.get(PrivyCustodyService);
    console.log('\nTesting gas top-up 0.0001 ETH from SWEEP_GAS...');
    const result = await custody.sendNativeFromSweepGas({
      recipient: deposit,
      value: 100000000000000n,
      referenceId: `manual-arb-gas-test:${Date.now()}`,
      chainId: 42161,
    });
    console.log('Top-up OK', result);
  } catch (error) {
    console.error('Top-up FAILED', error instanceof Error ? error.message : error);
  } finally {
    await app.close();
  }
}

main();
