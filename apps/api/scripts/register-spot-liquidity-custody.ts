import 'dotenv/config';
import {
  Chain,
  CustodyAccountRole,
  CustodyAccountStatus,
  CustodyProvider,
  PrismaClient,
} from '@prisma/client';

const prisma = new PrismaClient();
const networks = [
  Chain.ARBITRUM,
  Chain.BNB,
  Chain.BASE,
  Chain.OPTIMISM,
  Chain.ETHEREUM,
];

async function main(): Promise<void> {
  const address = required('SPOT_LIQUIDITY_ADDRESS').toLowerCase();
  const providerWalletRef = required('PRIVY_SPOT_LIQUIDITY_WALLET_ID');
  const policyRef = required('PRIVY_SPOT_LIQUIDITY_POLICY_ID');
  if (!/^0x[a-f0-9]{40}$/.test(address)) throw new Error('Invalid SPOT_LIQUIDITY_ADDRESS');

  for (const network of networks) {
    await prisma.custodyAccount.upsert({
      where: { role_network: { role: CustodyAccountRole.SPOT_LIQUIDITY, network } },
      update: {
        provider: CustodyProvider.PRIVY,
        address,
        providerWalletRef,
        policyRef,
        status: CustodyAccountStatus.ACTIVE,
      },
      create: {
        role: CustodyAccountRole.SPOT_LIQUIDITY,
        provider: CustodyProvider.PRIVY,
        network,
        address,
        providerWalletRef,
        policyRef,
        status: CustodyAccountStatus.ACTIVE,
      },
    });
  }
  console.log(JSON.stringify({ registered: true, accountCount: networks.length, networks }));
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
