import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class WalletNonceCleanupService {
  private readonly logger = new Logger(WalletNonceCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanup(): Promise<number> {
    const retentionDays = this.config.get<number>('SIWE_NONCE_RETENTION_DAYS', 7);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.walletSiweNonce.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: cutoff } },
          { usedAt: { not: null, lt: cutoff } },
        ],
      },
    });

    if (result.count > 0) {
      this.logger.log(`Deleted ${result.count} expired SIWE nonce records`);
    }
    return result.count;
  }
}
