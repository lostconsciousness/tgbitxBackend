import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { DepositIndexerService } from '../src/modules/deposits/deposit-indexer.service';
import { PrismaService } from '../src/database/prisma.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const indexer = app.get(DepositIndexerService);
  const user = await prisma.user.findFirst({ where: { email: 'trader@example.com' } });
  if (!user) {
    throw new Error('trader@example.com not found');
  }
  await indexer.syncPersonalDepositsForUser(user.id);
  console.log('synced deposits for', user.email);
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
