import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';
import { getAddress } from 'viem';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const custody = app.get(PrivyCustodyService);
    const deposit = getAddress('0x4393bf55240855ef78f01d103ce17ee5a1227906');
    const value = 100000000000000n;
    console.log('Sending BSC gas topup test...');
    const result = await custody.sendNativeFromSweepGas({
      recipient: deposit,
      value,
      referenceId: `manual-gas-test:${Date.now()}`,
      chainId: 56,
    });
    console.log('Success', result);
  } catch (error) {
    console.error('Failed', error instanceof Error ? error.message : error);
  } finally {
    await app.close();
  }
}

main();
