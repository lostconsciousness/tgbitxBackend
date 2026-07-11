import { DepositSweepService } from '../src/modules/deposits/deposit-sweep.service';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const sweep = app.get(DepositSweepService);
    await sweep.runOnce();
    console.log('Deposit sweep cycle completed');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
