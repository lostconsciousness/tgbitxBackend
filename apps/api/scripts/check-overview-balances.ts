import { PrismaClient, DepositStatus, LedgerEntryDirection, LedgerAccountType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AccountService } from '../src/modules/account/account.service';

async function main() {
  const prisma = new PrismaClient();
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (!user) {
    console.log('user not found');
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const accountService = app.get(AccountService);
  const overview = await accountService.getOverview(user.id);

  console.log('displayMode', overview.environment.displayMode);
  console.log('\nSpot balances:');
  for (const balance of overview.balances) {
    const asset = balance.asset as { symbol: string };
    const available = balance.available as string;
    const total = balance.total as string;
    const pending = balance.pendingDeposit as string;
    const locked = (Number(total) - Number(available)).toFixed(8);
    console.log(
      `${asset.symbol}: available=${available} pending=${pending} total=${total} (total-available=${locked}) status=${balance.status}`,
    );
  }

  console.log('\nPortfolio:', JSON.stringify(overview.portfolio, null, 2));

  const usdtOnChain = overview.onChainBalances.filter((row) => {
    const balances = (row as { balances?: Array<{ asset: { symbol: string }; balance?: string }> }).balances ?? [];
    return balances.some((entry) => entry.asset.symbol === 'USDT' && Number(entry.balance ?? 0) > 0);
  });
  console.log('\nUSDT on-chain deposit rows:', usdtOnChain.length);
  for (const row of usdtOnChain) {
    const typed = row as {
      network?: { chainKey?: string };
      address?: string;
      balances?: Array<{ asset: { symbol: string }; balance?: string }>;
    };
    const usdt = typed.balances?.find((entry) => entry.asset.symbol === 'USDT');
    console.log(`  ${typed.network?.chainKey} ${typed.address?.slice(0, 10)}... USDT=${usdt?.balance}`);
  }

  await app.close();
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
