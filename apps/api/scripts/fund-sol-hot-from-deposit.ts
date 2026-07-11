import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'SOL deposit→hot transfer failed');
  process.exitCode = 1;
});

async function main() {
  const email = process.argv[2] ?? 'trader@example.com';
  const solAmount = process.argv[3] ?? '0.005';
  const lamports = BigInt(Math.round(Number(solAmount) * 1e9));
  if (lamports <= 0n) {
    throw new Error('Transfer amount must be positive');
  }

  const prisma = new PrismaClient();
  const config = new ConfigService(process.env);
  const custody = new PrivyCustodyService(config);

  if (!custody.isSolanaEnabled()) {
    throw new Error('Privy Solana is not enabled');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(`User not found: ${email}`);
  }

  const deposit = await prisma.userDepositAddress.findUnique({
    where: { userId_network: { userId: user.id, network: 'SOLANA' } },
  });
  if (!deposit?.providerWalletRef) {
    throw new Error('Active Privy SOL deposit wallet not found');
  }

  const hotAddress = config.getOrThrow<string>('SOLANA_WITHDRAWAL_HOT_ADDRESS');
  const rpcUrl = config.getOrThrow<string>('SOLANA_RPC_PRIMARY_URL');
  const connection = new Connection(rpcUrl, 'confirmed');

  const source = new PublicKey(deposit.address);
  const destination = new PublicKey(hotAddress);
  const balance = BigInt(await connection.getBalance(source, 'confirmed'));
  const rentExempt = BigInt(await connection.getMinimumBalanceForRentExemption(0));
  const feeBuffer = 5_000n;

  if (balance < lamports + rentExempt + feeBuffer) {
    throw new Error(
      `Insufficient deposit balance: have ${balance} lamports, need ${lamports + rentExempt + feeBuffer}`,
    );
  }

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: source,
      toPubkey: destination,
      lamports: Number(lamports),
    }),
  );
  transaction.feePayer = source;
  transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

  const referenceId = `dep-hot:${Date.now().toString(36)}`;
  const sent = await custody.sendSolanaTransaction({
    walletId: deposit.providerWalletRef,
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    referenceId,
    mainnet: true,
  });

  await assertSolanaTxSucceeded(connection, sent.txHash);

  const [depositAfter, hotAfter] = await Promise.all([
    connection.getBalance(source, 'confirmed'),
    connection.getBalance(destination, 'confirmed'),
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        from: deposit.address,
        to: hotAddress,
        depositWalletId: deposit.providerWalletRef,
        sentSol: solAmount,
        txHash: sent.txHash,
        depositBalanceAfterSol: (depositAfter / 1e9).toFixed(9),
        hotBalanceAfterSol: (hotAfter / 1e9).toFixed(9),
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

async function assertSolanaTxSucceeded(connection: Connection, signature: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = response.value[0];
    if (status?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized' ||
      (status?.confirmations ?? 0) > 0
    ) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Transaction not confirmed yet: ${signature}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
