import { PrivyWalletProvider } from './privy-wallet-provider.service';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { ConfigService } from '@nestjs/config';

const user = {
  id: 'user-1',
  email: 'trader@example.com',
} as any;

const wallet = {
  id: 'wallet-1',
  address: '0x1111111111111111111111111111111111111111',
  chain: 'ARBITRUM',
  type: 'EXTERNAL',
  provider: 'SIWE',
  status: 'ACTIVE',
  isPrimary: true,
};

describe('WalletsController mutation metadata', () => {
  it('passes request metadata into wallet mutations', async () => {
    const walletsService = {
      connectWallet: jest.fn().mockResolvedValue(wallet),
      syncEmbeddedWallet: jest.fn().mockResolvedValue({
        ...wallet,
        type: 'EMBEDDED',
        provider: 'PRIVY',
      }),
      setPrimaryWallet: jest.fn().mockResolvedValue(wallet),
      revokeWallet: jest.fn().mockResolvedValue({ ...wallet, status: 'REVOKED' }),
    };
    const privyProvider = {
      getEmbeddedWallets: jest.fn().mockResolvedValue([{
        address: wallet.address,
        chainType: 'ethereum',
        providerUserRef: 'did:privy:user-1',
        providerWalletRef: 'privy-wallet-1',
      }]),
      isEnabled: jest.fn().mockReturnValue(true),
    };
    const prisma = {
      network: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const accountService = {
      getConnectedWalletBalancesForUser: jest.fn().mockResolvedValue([]),
    };
    const controller = new WalletsController(
      walletsService as unknown as WalletsService,
      privyProvider as unknown as PrivyWalletProvider,
      {
        get: jest.fn((_key: string, fallback?: unknown) => fallback),
      } as unknown as ConfigService,
      prisma as never,
      accountService as never,
    );
    const request = {
      get: jest.fn().mockReturnValue('jest'),
      ip: '127.0.0.1',
    } as any;

    await controller.connect(
      user,
      {
        address: wallet.address,
        nonce: 'a'.repeat(16),
        signature: '0x'.padEnd(66, '1'),
      },
      request,
    );
    await controller.syncEmbedded(user, request);
    await controller.setPrimary(user, wallet.id, request);
    await controller.revoke(user, wallet.id, request);

    expect(walletsService.connectWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: { ipAddress: '127.0.0.1', userAgent: 'jest' },
      }),
    );
    expect(walletsService.syncEmbeddedWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: { ipAddress: '127.0.0.1', userAgent: 'jest' },
      }),
    );
    expect(walletsService.setPrimaryWallet).toHaveBeenCalledWith(
      'user-1',
      'wallet-1',
      { ipAddress: '127.0.0.1', userAgent: 'jest' },
    );
    expect(walletsService.revokeWallet).toHaveBeenCalledWith(
      'user-1',
      'wallet-1',
      { ipAddress: '127.0.0.1', userAgent: 'jest' },
    );
  });

  it('does not return a revoked embedded wallet from background sync', async () => {
    const walletsService = {
      syncEmbeddedWallet: jest.fn().mockResolvedValue({
        ...wallet,
        type: 'EMBEDDED',
        provider: 'PRIVY',
        status: 'REVOKED',
        isPrimary: false,
      }),
    };
    const privyProvider = {
      getEmbeddedWallets: jest.fn().mockResolvedValue([{
        address: wallet.address,
        chainType: 'ethereum',
        providerUserRef: 'did:privy:user-1',
        providerWalletRef: 'privy-wallet-1',
      }]),
    };
    const controller = new WalletsController(
      walletsService as unknown as WalletsService,
      privyProvider as unknown as PrivyWalletProvider,
      { get: jest.fn() } as unknown as ConfigService,
      { network: { findMany: jest.fn() } } as never,
      { getConnectedWalletBalancesForUser: jest.fn() } as never,
    );

    await expect(controller.syncEmbedded(user, {
      get: jest.fn(),
      ip: '127.0.0.1',
    } as any)).resolves.toEqual({ wallets: [] });
  });
});
