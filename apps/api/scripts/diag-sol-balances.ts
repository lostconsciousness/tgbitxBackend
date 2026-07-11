import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { ConfigService } from '@nestjs/config';

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const config = new ConfigService(process.env);
  const rpcUrl = config.getOrThrow<string>('SOLANA_RPC_PRIMARY_URL');
  const connection = new Connection(rpcUrl, 'confirmed');
  const deposit = process.argv[2] ?? 'DzoNUwGqqAX4f6BsX9afB3vCddowsfo1j1wzwGTGHvUm';
  const hot = process.argv[3] ?? config.getOrThrow<string>('SOLANA_WITHDRAWAL_HOT_ADDRESS');
  const [depositLamports, hotLamports, rentExempt] = await Promise.all([
    connection.getBalance(new PublicKey(deposit), 'confirmed'),
    connection.getBalance(new PublicKey(hot), 'confirmed'),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  console.log(
    JSON.stringify(
      {
        deposit,
        hot,
        depositSol: (depositLamports / 1e9).toFixed(9),
        hotSol: (hotLamports / 1e9).toFixed(9),
        rentExemptLamports: rentExempt,
      },
      null,
      2,
    ),
  );
}
