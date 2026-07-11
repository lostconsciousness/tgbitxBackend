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
  const rpc =
    process.env.BNB_RPC_PRIMARY_URL?.trim() ||
    process.env.BNB_RPC_FALLBACK_URL?.trim() ||
    'https://bsc-dataseed.binance.org';
  console.log('rpc host', new URL(rpc).hostname);
  const topic = `0x${'0'.repeat(24)}${deposit.slice(2).toLowerCase()}`;
  const latestHex = (await rpcCall(rpc, 'eth_blockNumber', [])) as string;
  const latest = Number.parseInt(latestHex, 16);
  const spans = [500, 100, 50, 20, 5, 1];
  for (const span of spans) {
    const from = latest - span;
    try {
      const logs = (await rpcCall(rpc, 'eth_getLogs', [
        {
          address: getAddress(tc.address),
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            null,
            topic,
          ],
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${latest.toString(16)}`,
        },
      ])) as unknown[];
      console.log(`span=${span} logs=${logs.length}`);
      if (logs.length > 0) break;
    } catch (error) {
      console.log(`span=${span} failed`, error instanceof Error ? error.message : error);
    }
  }
  await prisma.$disconnect();
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
