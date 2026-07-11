import { PrismaClient, TokenStandard } from '@prisma/client';
import {
  WITHDRAWAL_FEE_POLICY,
  lookupPolicyWithdrawalFee,
} from '../src/modules/withdrawals/withdrawal-fee.policy';

const prisma = new PrismaClient();

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  let updated = 0;

  const contracts = await prisma.tokenContract.findMany({
    where: { network: { mainnet: true } },
    include: { asset: true, network: true },
  });

  for (const contract of contracts) {
    const policyFee = lookupPolicyWithdrawalFee(
      contract.asset.symbol,
      contract.network.chainKey,
    );
    if (!policyFee) {
      continue;
    }
    if (contract.withdrawalFeeAmount.toString() === policyFee) {
      continue;
    }
    console.log(
      `Update ${contract.asset.symbol}@${contract.network.chainKey}: ${contract.withdrawalFeeAmount.toString()} -> ${policyFee}`,
    );
    if (!dryRun) {
      await prisma.tokenContract.update({
        where: { id: contract.id },
        data: { withdrawalFeeAmount: policyFee },
      });
    }
    updated += 1;
  }

  console.log(
    dryRun
      ? `Dry run: ${updated} contracts would be updated`
      : `Updated ${updated} token contracts`,
  );
  console.log('Policy table:', WITHDRAWAL_FEE_POLICY);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
