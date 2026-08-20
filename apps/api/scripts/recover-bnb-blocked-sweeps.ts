import 'dotenv/config';
import {
  Chain,
  CustodyProvider,
  DepositStatus,
  DepositSweepStatus,
  NetworkFamily,
  Prisma,
  PrismaClient,
  TokenStandard,
} from '@prisma/client';
import { createPublicClient, erc20Abi, formatUnits, getAddress, http } from 'viem';
import { bsc } from 'viem/chains';

const ALLOWED_ASSETS = new Set(['BNB', 'USDC', 'USDT']);

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const prisma = new PrismaClient();
  try {
    const network = await prisma.network.findUniqueOrThrow({ where: { chainKey: 'bnb' } });
    if (
      !network.mainnet ||
      !network.depositEnabled ||
      network.family !== NetworkFamily.EVM ||
      network.chainId !== 56 ||
      network.legacyChain !== Chain.BNB
    ) {
      throw new Error('BNB mainnet deposit configuration guard failed');
    }
    const rpcUrl = process.env.BNB_RPC_PRIMARY_URL ?? 'https://bsc-dataseed.binance.org';
    const client = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
    const sweeps = await prisma.depositSweep.findMany({
      where: {
        status: DepositSweepStatus.BLOCKED,
        txHash: null,
        providerRequestId: null,
        depositAddress: {
          network: Chain.BNB,
          provider: CustodyProvider.PRIVY,
          providerWalletRef: { not: null },
        },
      },
      include: {
        asset: true,
        depositAddress: true,
        deposits: { select: { id: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const remainingByWalletAsset = new Map<string, bigint>();
    const candidates: Array<{
      sweep: typeof sweeps[number];
      rawAmount: bigint;
      decimals: number;
      onchainRaw: bigint;
    }> = [];
    for (const sweep of sweeps) {
      if (!ALLOWED_ASSETS.has(sweep.asset.symbol)) continue;
      if (!isRecoverableReason(sweep.failureReason)) continue;
      if (
        sweep.deposits.length === 0 ||
        sweep.deposits.some((deposit) => deposit.status !== DepositStatus.CREDITED)
      ) {
        continue;
      }
      const token = await prisma.tokenContract.findUnique({
        where: {
          assetId_networkId_standard: {
            assetId: sweep.assetId,
            networkId: network.id,
            standard: sweep.asset.symbol === 'BNB' ? TokenStandard.NATIVE : TokenStandard.ERC20,
          },
        },
      });
      if (
        !token?.depositEnabled ||
        !token.contractVerifiedAt ||
        token.verifiedChainId !== 56 ||
        (token.standard === TokenStandard.ERC20 && (!token.address || !token.contractCodeHash))
      ) {
        continue;
      }
      if (sweep.gasFundingTxHash) {
        const receipt = await client
          .getTransactionReceipt({ hash: sweep.gasFundingTxHash as `0x${string}` })
          .catch(() => null);
        if (receipt && receipt.status !== 'success') continue;
      }
      const key = `${sweep.depositAddress.address.toLowerCase()}:${sweep.assetId}`;
      let remaining = remainingByWalletAsset.get(key);
      if (remaining === undefined) {
        remaining = token.standard === TokenStandard.NATIVE
          ? await client.getBalance({ address: getAddress(sweep.depositAddress.address) })
          : await client.readContract({
              address: getAddress(token.address!),
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [getAddress(sweep.depositAddress.address)],
            } as never) as bigint;
      }
      const requested = BigInt(sweep.rawAmount);
      const rawAmount = requested < remaining ? requested : remaining;
      if (rawAmount <= 0n) continue;
      remainingByWalletAsset.set(key, remaining - rawAmount);
      candidates.push({ sweep, rawAmount, decimals: token.decimals, onchainRaw: remaining });
    }

    console.log(JSON.stringify({
      execute,
      candidates: candidates.map(({ sweep, rawAmount, decimals, onchainRaw }) => ({
        id: sweep.id,
        userId: sweep.depositAddress.userId,
        address: sweep.depositAddress.address,
        asset: sweep.asset.symbol,
        sweepAmount: sweep.amount.toString(),
        recoverAmount: formatUnits(rawAmount, decimals),
        onchainAmount: formatUnits(onchainRaw, decimals),
        attempts: sweep.attempts,
        reason: sweep.failureReason,
      })),
    }, null, 2));
    if (!execute) return;

    for (const { sweep, rawAmount, decimals, onchainRaw } of candidates) {
      await prisma.$transaction(async (tx) => {
        const current = await tx.depositSweep.findUniqueOrThrow({ where: { id: sweep.id } });
        if (
          current.status !== DepositSweepStatus.BLOCKED ||
          current.txHash ||
          current.providerRequestId ||
          !isRecoverableReason(current.failureReason)
        ) {
          throw new Error(`Sweep ${sweep.id} changed after verification`);
        }
        await tx.depositSweep.update({
          where: { id: sweep.id },
          data: {
            status: DepositSweepStatus.PENDING,
            attempts: 0,
            failureReason: null,
            startedAt: null,
            rawAmount: rawAmount.toString(),
            amount: new Prisma.Decimal(formatUnits(rawAmount, decimals)),
          },
        });
        await tx.auditLog.create({
          data: {
            action: 'DEPOSIT_SWEEP_RECOVERED_AFTER_POLICY_FIX',
            entityType: 'DepositSweep',
            entityId: sweep.id,
            reason: sweep.failureReason,
            metadata: {
              network: 'bnb',
              asset: sweep.asset.symbol,
              address: sweep.depositAddress.address,
              rawAmount: rawAmount.toString(),
              onchainRaw: onchainRaw.toString(),
              previousAttempts: sweep.attempts,
            },
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }
    console.log(JSON.stringify({ requeued: candidates.map(({ sweep }) => sweep.id) }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

function isRecoverableReason(reason: string | null): boolean {
  return Boolean(
    reason &&
    (/policy_violation|policy violation/i.test(reason) ||
      reason.startsWith('Sweep retry limit reached')),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'BNB sweep recovery failed');
  process.exitCode = 1;
});
