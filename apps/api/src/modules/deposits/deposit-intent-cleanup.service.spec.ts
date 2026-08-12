import { DepositIntentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { DepositIntentCleanupService } from './deposit-intent-cleanup.service';

describe('DepositIntentCleanupService', () => {
  it('expires only pending intents that were never submitted', async () => {
    const prisma = {
      depositIntent: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const service = new DepositIntentCleanupService(prisma as unknown as PrismaService);

    await expect(service.expirePendingIntents()).resolves.toBe(2);
    expect(prisma.depositIntent.updateMany).toHaveBeenCalledWith({
      where: {
        status: DepositIntentStatus.PENDING,
        txHash: null,
        expiresAt: { lte: expect.any(Date) },
      },
      data: {
        status: DepositIntentStatus.EXPIRED,
        failureReason: 'Deposit intent expired before transaction submission',
      },
    });
  });
});
