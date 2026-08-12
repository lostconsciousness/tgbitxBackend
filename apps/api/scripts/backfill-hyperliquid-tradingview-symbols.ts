import 'dotenv/config';
import { MarketType, PrismaClient } from '@prisma/client';
import { hyperliquidTradingViewSymbolFor } from '../src/modules/markets/hyperliquid-perp-market.sync';

async function main() {
  const prisma = new PrismaClient();
  try {
    const markets = await prisma.market.findMany({
      where: {
        type: MarketType.PERP,
        providerName: 'HYPERLIQUID',
        providerSymbol: { not: null },
      },
      select: {
        id: true,
        providerSymbol: true,
        tradingViewSymbol: true,
      },
    });

    const changes = markets.flatMap((market) => {
      if (!market.providerSymbol) {
        return [];
      }
      const tradingViewSymbol = hyperliquidTradingViewSymbolFor(market.providerSymbol);
      return market.tradingViewSymbol === tradingViewSymbol
        ? []
        : [{ id: market.id, tradingViewSymbol }];
    });

    if (changes.length > 0) {
      await prisma.$transaction(
        changes.map((market) =>
          prisma.market.update({
            where: { id: market.id },
            data: { tradingViewSymbol: market.tradingViewSymbol },
          }),
        ),
      );
    }

    console.log(JSON.stringify({ scanned: markets.length, updated: changes.length }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
