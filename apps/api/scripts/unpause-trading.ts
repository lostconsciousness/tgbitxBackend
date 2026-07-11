import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const setting = await prisma.systemSetting.upsert({
    where: { key: 'trading:paused' },
    update: { value: false },
    create: { key: 'trading:paused', value: false },
  });
  console.log('trading:paused =', setting.value);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
