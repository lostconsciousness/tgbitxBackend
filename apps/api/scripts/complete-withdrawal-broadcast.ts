import { NestFactory } from '@nestjs/core';
import { WithdrawalStatus } from '@prisma/client';
import { getAddress, parseUnits } from 'viem';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';
import { WithdrawalsService } from '../src/modules/withdrawals/withdrawals.service';

async function main() {
  const withdrawalId = process.argv[2] ?? 'cmqwpisnh0038ytrdr2u247uq';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const custody = app.get(PrivyCustodyService);
    const withdrawals = app.get(WithdrawalsService);

    const withdrawal = await prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: {
        asset: true,
        tokenContract: { include: { network: true } },
      },
    });
    if (!withdrawal?.tokenContract?.address || !withdrawal.tokenContract.network.chainId) {
      throw new Error('Withdrawal is missing token contract configuration');
    }
    if (
      withdrawal.status !== WithdrawalStatus.APPROVED &&
      withdrawal.status !== WithdrawalStatus.BROADCASTING
    ) {
      throw new Error(`Withdrawal status is ${withdrawal.status}`);
    }

    const rawAmount = parseUnits(withdrawal.amount.toString(), withdrawal.tokenContract.decimals);
    console.log('Broadcasting', {
      id: withdrawal.id,
      amount: withdrawal.amount.toString(),
      network: withdrawal.tokenContract.network.chainKey,
      to: withdrawal.toAddress,
    });

    const result = await custody.sendErc20({
      tokenAddress: getAddress(withdrawal.tokenContract.address),
      recipient: getAddress(withdrawal.toAddress),
      rawAmount,
      referenceId: `withdrawal:${withdrawal.id}`,
      chainId: withdrawal.tokenContract.network.chainId,
    });

    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: WithdrawalStatus.BROADCASTED,
        txHash: result.txHash,
        providerRequestId: result.providerRequestId ?? null,
        broadcastedAt: new Date(),
        lastBroadcastError: null,
        broadcastAttempts: { increment: 1 },
      },
    });

    console.log('Broadcasted:', result);
    await withdrawals.processApprovedWithdrawals();
    const finalState = await prisma.withdrawal.findUnique({
      where: { id: withdrawal.id },
      select: { status: true, txHash: true, confirmedAt: true },
    });
    console.log('Final state:', finalState);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
