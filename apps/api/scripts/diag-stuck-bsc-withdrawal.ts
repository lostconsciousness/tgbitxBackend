import { NestFactory } from '@nestjs/core';
import { createPublicClient, formatUnits, getAddress, http, parseAbi } from 'viem';
import { arbitrum, bsc } from 'viem/chains';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { OnchainReadinessService } from '../src/modules/onchain/onchain-readiness.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const readiness = app.get(OnchainReadinessService);

  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: 'cmqwt7ugb0040evtre0kgebcs' },
    include: { asset: true, tokenContract: { include: { network: true } } },
  });
  console.log('Withdrawal:', withdrawal && {
    id: withdrawal.id,
    status: withdrawal.status,
    amount: withdrawal.amount.toString(),
    network: withdrawal.tokenContract?.network?.chainKey,
    to: withdrawal.toAddress,
    error: withdrawal.lastBroadcastError,
    attempts: withdrawal.broadcastAttempts,
    updatedAt: withdrawal.updatedAt,
  });

  const bnbReady = await readiness.getReadiness('bnb');
  console.log('BNB withdrawal readiness:', bnbReady.workers.withdrawal);

  const treasury = getAddress(process.env.DEPOSIT_TREASURY_ADDRESS!);
  const hot = getAddress(process.env.WITHDRAWAL_HOT_ADDRESS!);
  const depositAddr = '0x4393bf55240855ef78f01d103ce17ee5a1227906';
  const bscUsdt = '0x55d398326f99059fF775485246999027B3197955';
  const arbUsdt = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
  const abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

  const read = async (client: ReturnType<typeof createPublicClient>, token: string, addr: string) =>
    formatUnits(
      (await client.readContract({
        address: getAddress(token),
        abi,
        functionName: 'balanceOf',
        args: [getAddress(addr)],
      })) as bigint,
      6,
    );

  const bscClient = createPublicClient({
    chain: bsc,
    transport: http(process.env.BNB_RPC_PRIMARY_URL),
  });
  const arbClient = createPublicClient({
    chain: arbitrum,
    transport: http(process.env.ARBITRUM_RPC_PRIMARY_URL),
  });

  console.log('\nBSC USDT balances:');
  console.log('  user deposit:', await read(bscClient, bscUsdt, depositAddr));
  console.log('  treasury:', await read(bscClient, bscUsdt, treasury));
  console.log('  hot:', await read(bscClient, bscUsdt, hot));

  console.log('\nArbitrum USDT balances:');
  console.log('  treasury:', await read(arbClient, arbUsdt, treasury));
  console.log('  hot:', await read(arbClient, arbUsdt, hot));

  await app.close();
}

main().catch(console.error);
