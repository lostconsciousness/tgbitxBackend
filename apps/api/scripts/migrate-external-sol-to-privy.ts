import 'dotenv/config';
import { PrismaClient, CustodyProvider, DepositSweepStatus, UserDepositAddressStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';

const FEE_BUFFER_LAMPORTS = 5_000n;

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Solana migration failed');
  process.exitCode = 1;
});

async function main() {
  const args = process.argv.slice(2);
  const finalize = args.includes('--finalize');
  const email = args.find((arg) => !arg.startsWith('--')) ?? 'trader@example.com';
  const txHashArg = finalize
    ? args.filter((arg) => !arg.startsWith('--'))[1]
    : undefined;

  const prisma = new PrismaClient();
  const config = new ConfigService(process.env);
  const custody = new PrivyCustodyService(config);

  if (!custody.isSolanaEnabled()) {
    throw new Error('Privy Solana is not enabled (check PRIVY_SOLANA_* env)');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(`User not found: ${email}`);
  }

  const row = await prisma.userDepositAddress.findUnique({
    where: { userId_network: { userId: user.id, network: 'SOLANA' } },
  });
  if (!row || row.status !== UserDepositAddressStatus.ACTIVE) {
    throw new Error('Active SOLANA deposit address not found');
  }

  const rpcUrl = config.get<string>('SOLANA_RPC_PRIMARY_URL');
  if (!rpcUrl) {
    throw new Error('SOLANA_RPC_PRIMARY_URL is not configured');
  }

  const policyId = config.getOrThrow<string>('PRIVY_SOLANA_POLICY_ID');
  const privyWallet = await custody.createOrGetSolanaWallet({
    externalId: row.externalId,
    displayName: `Deposit solana ${user.id.slice(-8)}`,
    policyId,
  });

  let signature: string;
  let fromAddress = row.address;
  let sentLamports: bigint | null = null;

  if (finalize) {
    signature = txHashArg ?? '';
    if (!signature) {
      throw new Error('Usage: migrate-external-sol-to-privy.ts <email> --finalize <txSignature>');
    }
    await assertSolanaTxSucceeded(new Connection(rpcUrl, 'confirmed'), signature);
  } else {
    if (row.provider !== CustodyProvider.EXTERNAL) {
      throw new Error(`Deposit address provider is ${row.provider}, expected EXTERNAL`);
    }
    if (!row.providerWalletRef?.startsWith('testnet-secret:v1:')) {
      throw new Error('Deposit wallet secret ref is missing');
    }

    const sourceKeypair = decodeDepositKeypair(row.providerWalletRef);
    if (sourceKeypair.publicKey.toBase58() !== row.address) {
      throw new Error('Deposit address does not match stored secret');
    }

    const connection = new Connection(rpcUrl, 'confirmed');
    const balance = BigInt(await connection.getBalance(sourceKeypair.publicKey, 'confirmed'));
    const rentExempt = BigInt(await connection.getMinimumBalanceForRentExemption(0));
    if (balance <= rentExempt + FEE_BUFFER_LAMPORTS) {
      throw new Error(`Insufficient SOL on ${row.address}: ${balance} lamports`);
    }
    sentLamports = balance - rentExempt - FEE_BUFFER_LAMPORTS;

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sourceKeypair.publicKey,
        toPubkey: new PublicKey(privyWallet.address),
        lamports: Number(sentLamports),
      }),
    );
    transaction.feePayer = sourceKeypair.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    transaction.sign(sourceKeypair);
    signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
    });
    await assertSolanaTxSucceeded(connection, signature);
  }

  await prisma.userDepositAddress.update({
    where: { id: row.id },
    data: {
      address: privyWallet.address,
      provider: CustodyProvider.PRIVY,
      providerWalletRef: privyWallet.id,
      policyRef: policyId,
      failureReason: null,
    },
  });

  const blockedSweep = await prisma.depositSweep.findFirst({
    where: {
      depositAddressId: row.id,
      status: DepositSweepStatus.BLOCKED,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (blockedSweep) {
    await prisma.depositSweep.update({
      where: { id: blockedSweep.id },
      data: {
        status: DepositSweepStatus.PENDING,
        failureReason: null,
        txHash: null,
        gasFundingTxHash: null,
        providerRequestId: null,
      },
    });
  }

  console.log(
    JSON.stringify(
      {
        migrated: true,
        finalizedExistingTx: finalize,
        fromAddress,
        toPrivyDepositAddress: privyWallet.address,
        privyWalletId: privyWallet.id,
        txHash: signature,
        sentSol: sentLamports ? (Number(sentLamports) / 1e9).toFixed(9) : null,
        sweepRequeued: blockedSweep?.id ?? null,
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

function decodeDepositKeypair(providerWalletRef: string): Keypair {
  const encoded = providerWalletRef.replace(/^testnet-secret:v1:/, '');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
    kind: string;
    secret: string;
  };
  if (payload.kind !== 'solana') {
    throw new Error(`Unsupported deposit secret kind: ${payload.kind}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(payload.secret, 'base64')));
}
