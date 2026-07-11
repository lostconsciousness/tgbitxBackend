import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { getAddress } from 'viem';

config({ path: '.env' });

async function main() {
  const prisma = new PrismaClient();
  const deposit = getAddress('0x4393bf55240855ef78f01d103ce17ee5a1227906');
  const tc = await prisma.tokenContract.findFirst({
    where: { network: { chainKey: 'bnb' }, asset: { symbol: 'USDT' } },
  });
  if (!tc?.address) throw new Error('USDT bnb contract missing');

  const rpc = process.env.BNB_RPC_PRIMARY_URL!.trim();
  const topic = `0x${'0'.repeat(24)}${deposit.slice(2).toLowerCase()}`;
  const latest = Number.parseInt((await rpcCall(rpc, 'eth_blockNumber', [])) as string, 16);
  const span = 10;
  const maxWindows = 800;

  for (let window = 0; window < maxWindows; window += 1) {
    const toBlock = latest - window * span;
    const fromBlock = toBlock - span + 1;
    if (fromBlock < 0) break;
    const logs = (await rpcCall(rpc, 'eth_getLogs', [
      {
        address: getAddress(tc.address),
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          null,
          topic,
        ],
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
      },
    ])) as Array<{ transactionHash: string; blockNumber: string }>;
    if (logs.length > 0) {
      console.log('found', logs.length, 'logs');
      console.log('block', Number.parseInt(logs[0]!.blockNumber, 16));
      console.log('tx', logs[0]!.transactionHash);
      console.log('lookbackFromLatest', latest - fromBlock);
      break;
    }
    if (window % 100 === 0) {
      console.log('scanned windows', window, 'up to block', fromBlock);
    }
    await sleep(300);
  }

  await prisma.$disconnect();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcCall(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
