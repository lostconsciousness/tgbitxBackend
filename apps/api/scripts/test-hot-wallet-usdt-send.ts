import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';
import { PrismaService } from '../src/database/prisma.service';
import { getAddress, parseUnits } from 'viem';

async function main() {
  const toAddress = process.argv[2];
  const network = (process.argv[3] ?? 'bnb').toLowerCase();
  if (!toAddress) {
    console.error('Usage: npx ts-node scripts/test-hot-wallet-usdt-send.ts <toAddress> [bnb|arbitrum]');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const custody = app.get(PrivyCustodyService);

    const chainId = network === 'arbitrum' ? 42161 : 56;
    const chainKey = network === 'arbitrum' ? 'arbitrum' : 'bnb';
    const contract = await prisma.tokenContract.findFirst({
      where: { network: { chainKey }, asset: { symbol: 'USDT' } },
    });
    if (!contract?.address) {
      throw new Error(`USDT contract not found on ${chainKey}`);
    }

    const amount = parseUnits('0.01', contract.decimals);
    console.log(`Sending 0.01 USDT on ${chainKey} to ${toAddress}...`);
    const result = await custody.sendErc20({
      tokenAddress: getAddress(contract.address),
      recipient: getAddress(toAddress),
      rawAmount: amount,
      referenceId: `manual-hot-usdt-test:${Date.now()}`,
      chainId,
    });
    console.log('Success:', result);
  } catch (error) {
    console.error('Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main();
