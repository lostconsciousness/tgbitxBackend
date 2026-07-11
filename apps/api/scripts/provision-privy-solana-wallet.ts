import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Privy Solana provisioning failed');
  process.exitCode = 1;
});

async function main() {
  const config = new ConfigService(process.env);
  const policyId = config.get<string>('PRIVY_SOLANA_POLICY_ID');
  if (!policyId) {
    throw new Error('PRIVY_SOLANA_POLICY_ID is required');
  }
  const custody = new PrivyCustodyService(config);
  const wallet = await custody.createOrGetSolanaWallet({
    externalId: 'dream-exchange-solana-mainnet-reserve',
    displayName: 'Dream Exchange Solana Mainnet Reserve',
    policyId,
  });
  console.log(JSON.stringify({
    configured: true,
    walletId: wallet.id,
    address: wallet.address,
  }, null, 2));
}
