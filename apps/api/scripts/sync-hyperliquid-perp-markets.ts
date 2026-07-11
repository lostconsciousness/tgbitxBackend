import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { syncHyperliquidPerpMarkets } from '../src/modules/markets/hyperliquid-perp-market.sync';

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await syncHyperliquidPerpMarkets(prisma);
    console.log(JSON.stringify(result, null, 2));
    const perpCount = await prisma.market.count({ where: { type: 'PERP', orderbookEnabled: true } });
    console.log('Active HL PERP markets with orderbook:', perpCount);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
