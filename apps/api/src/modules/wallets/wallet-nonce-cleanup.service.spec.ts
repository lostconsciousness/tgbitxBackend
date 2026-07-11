import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { WalletNonceCleanupService } from './wallet-nonce-cleanup.service';

describe('WalletNonceCleanupService', () => {
  it('deletes used and expired nonce records older than retention', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    const service = new WalletNonceCleanupService(
      {
        walletSiweNonce: { deleteMany },
      } as unknown as PrismaService,
      {
        get: jest.fn().mockReturnValue(7),
      } as unknown as ConfigService,
    );

    await expect(service.cleanup()).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { expiresAt: { lt: expect.any(Date) } },
          { usedAt: { not: null, lt: expect.any(Date) } },
        ],
      },
    });
  });
});
