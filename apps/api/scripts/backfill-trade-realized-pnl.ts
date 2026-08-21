import { Prisma, PrismaClient } from '@prisma/client';

type RealizedPnlCandidate = {
  id: string;
  orderId: string;
  providerFillId: string | null;
  calculatedPnl: Prisma.Decimal;
};

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function findCandidates(client: PrismaClient | Prisma.TransactionClient) {
  return client.$queryRaw<RealizedPnlCandidate[]>(Prisma.sql`
    SELECT
      t.id,
      t."orderId",
      t."providerFillId",
      SUM(
        CASE
          WHEN le.direction = 'DEBIT' THEN le.amount
          ELSE -le.amount
        END
      ) AS "calculatedPnl"
    FROM trades t
    JOIN orders o ON o.id = t."orderId"
    JOIN ledger_transactions lt
      ON lt."idempotencyKey" = CONCAT(
        'position-close:',
        COALESCE(t."providerFillId", t."orderId")
      )
    JOIN ledger_entries le ON le."transactionId" = lt.id
    JOIN ledger_accounts la ON la.id = le."accountId"
    WHERE o."reduceOnly" = true
      AND t."realizedPnl" = 0
      AND la.type IN ('PROVIDER_CLEARING', 'PLATFORM_BBOOK')
    GROUP BY t.id, t."orderId", t."providerFillId"
    HAVING SUM(
      CASE
        WHEN le.direction = 'DEBIT' THEN le.amount
        ELSE -le.amount
      END
    ) <> 0
    ORDER BY t.id
  `);
}

async function main() {
  const candidates = await findCandidates(prisma);
  const totalPnl = candidates.reduce(
    (sum, candidate) => sum.plus(candidate.calculatedPnl),
    new Prisma.Decimal(0),
  );

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    candidates: candidates.length,
    totalPnl: totalPnl.toString(),
  }));

  if (!apply || candidates.length === 0) return;

  const updated = await prisma.$transaction(async (tx) => {
    let count = 0;
    for (const candidate of candidates) {
      const result = await tx.trade.updateMany({
        where: { id: candidate.id, realizedPnl: 0 },
        data: { realizedPnl: candidate.calculatedPnl },
      });
      count += result.count;
    }
    return count;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  const remaining = await findCandidates(prisma);
  console.log(JSON.stringify({ updated, remaining: remaining.length }));
  if (updated !== candidates.length || remaining.length !== 0) {
    throw new Error('Trade realized PnL backfill did not reconcile completely');
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
