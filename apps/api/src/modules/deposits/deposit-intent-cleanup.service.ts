import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DepositIntentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class DepositIntentCleanupService {
  private readonly logger = new Logger(DepositIntentCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expirePendingIntents(): Promise<number> {
    const result = await this.prisma.depositIntent.updateMany({
      where: {
        status: DepositIntentStatus.PENDING,
        txHash: null,
        expiresAt: { lte: new Date() },
      },
      data: {
        status: DepositIntentStatus.EXPIRED,
        failureReason: 'Deposit intent expired before transaction submission',
      },
    });
    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} unsubmitted deposit intents`);
    }
    return result.count;
  }
}
