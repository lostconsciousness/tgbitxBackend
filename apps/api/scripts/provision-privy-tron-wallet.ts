import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Privy Tron provisioning failed');
  process.exitCode = 1;
});

async function main() {
  const config = new ConfigService(process.env);
  const custody = new PrivyCustodyService(config);
  const wallet = await custody.createOrGetTronWallet({
    externalId: 'dream-exchange-tron-mainnet-reserve',
    displayName: 'Dream Exchange Tron Mainnet Reserve',
    policyId: config.get<string>('PRIVY_TRON_RESERVE_POLICY_ID') || undefined,
  });
  console.log(JSON.stringify({
    configured: true,
    walletId: wallet.id,
    address: wallet.address,
  }, null, 2));
}
