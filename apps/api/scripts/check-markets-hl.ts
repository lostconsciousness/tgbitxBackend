import 'dotenv/config';
import { PrismaClient, MarketType } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const perps = await prisma.market.findMany({
    where: { type: MarketType.PERP },
    orderBy: { symbol: 'asc' },
    select: {
      symbol: true,
      status: true,
      providerName: true,
      providerSymbol: true,
      orderbookEnabled: true,
    },
  });
  console.log('PERP markets in DB:', perps.length);
  for (const market of perps) {
    console.log(market);
  }

  const url = process.env.HYPERLIQUID_INFO_URL ?? 'https://api.hyperliquid.xyz/info';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  const meta = (await response.json()) as {
    universe: Array<{ name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }>;
  };
  const hlNames = new Set(
    meta.universe.filter((item) => !item.isDelisted).map((item) => item.name),
  );
  console.log('\nHyperliquid active perps:', hlNames.size);
  console.log('FIL on HL:', hlNames.has('FIL'));
  console.log('Sample HL coins:', [...hlNames].slice(0, 20).join(', '));

  const missingProvider = perps.filter((m) => !m.providerSymbol || !m.orderbookEnabled);
  console.log('\nPERP without HL orderbook config:', missingProvider.length);

  const assets = await prisma.asset.findMany({ select: { symbol: true } });
  const assetSymbols = new Set(assets.map((a) => a.symbol));
  const hlList = [...hlNames];
  let matchExact = 0;
  let matchK = 0;
  let noMatch = 0;
  for (const name of hlList) {
    if (assetSymbols.has(name)) {
      matchExact += 1;
    } else if (name.startsWith('k') && assetSymbols.has(name.slice(1))) {
      matchK += 1;
    } else {
      noMatch += 1;
    }
  }
  console.log('\nHL perps matchable to assets:', {
    exact: matchExact,
    kPrefix: matchK,
    noAsset: noMatch,
    total: hlList.length,
  });
  console.log('FIL asset in DB:', assetSymbols.has('FIL'));
  console.log('Would create FIL-PERP:', hlNames.has('FIL') && assetSymbols.has('FIL'));

  await prisma.$disconnect();
}

main().catch(console.error);
