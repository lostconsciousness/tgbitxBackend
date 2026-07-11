import { ConfigService } from '@nestjs/config';
import { Chain, CustodyAccountRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { OnchainReadinessService } from './onchain-readiness.service';

describe('OnchainReadinessService', () => {
  it('blocks workers when RPC chain or custody configuration is unsafe', async () => {
    const service = new OnchainReadinessService(
      {
        network: {
          findFirst: jest.fn().mockResolvedValue({
            chainId: 421614,
            legacyChain: Chain.ARBITRUM_SEPOLIA,
            mainnet: false,
          }),
        },
        custodyAccount: {
          findMany: jest.fn().mockResolvedValue([
            {
              role: CustodyAccountRole.DEPOSIT_TREASURY,
              address: '0x0000000000000000000000000000000000000000',
              providerWalletRef: null,
              status: 'ACTIVE',
            },
          ]),
        },
        tokenContract: { findMany: jest.fn().mockResolvedValue([]) },
      } as unknown as PrismaService,
      {
        get: jest.fn((key: string, fallback?: unknown) => {
          const values: Record<string, unknown> = {
            ONCHAIN_CHAIN_ID: 421614,
            MAINNET_ENABLED: false,
            WITHDRAWAL_HOT_ADDRESS: '',
            PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'not-a-private-key',
          };
          return values[key] ?? fallback;
        }),
      } as unknown as ConfigService,
      { getChainId: jest.fn().mockResolvedValue(42161) } as unknown as RpcProvider,
    );

    const result = await service.getReadiness();

    expect(result.ready).toBe(false);
    expect(result.network).toBe(Chain.ARBITRUM_SEPOLIA);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'RPC_CHAIN_MISMATCH:42161',
        'MISSING_CUSTODY_DEPOSIT_TREASURY',
        'MISSING_CUSTODY_WITHDRAWAL_HOT',
        'PRIVY_AUTHORIZATION_PRIVATE_KEY_INVALID',
      ]),
    );
  });
});
