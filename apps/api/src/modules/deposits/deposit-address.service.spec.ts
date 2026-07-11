import { ConfigService } from '@nestjs/config';
import { Chain, NetworkFamily, TokenStandard, UserDepositAddressStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { AuditService } from '../audit/audit.service';
import { PrivyCustodyService } from '../treasury/privy-custody.service';
import { DepositAddressService } from './deposit-address.service';

describe('DepositAddressService', () => {
  const asset = {
    id: 'asset-usdc',
    symbol: 'USDC',
    chain: Chain.ARBITRUM_SEPOLIA,
    tokenAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    decimals: 6,
    depositEnabled: true,
    contractVerifiedAt: new Date(),
    contractCodeHash: '0xverified',
  };
  const network = {
    id: 'network-arbitrum-sepolia',
    chainKey: 'arbitrum-sepolia',
    caip2: 'eip155:421614',
    chainId: 421614,
    family: NetworkFamily.EVM,
    legacyChain: Chain.ARBITRUM_SEPOLIA,
    confirmations: 12,
    depositEnabled: true,
  };
  const tokenContract = {
    id: 'contract-usdc-sepolia',
    address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    standard: TokenStandard.ERC20,
    decimals: 6,
    depositEnabled: true,
    contractVerifiedAt: new Date(),
    contractCodeHash: '0xverified',
  };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        ONCHAIN_CHAIN_ID: 421614,
        DEPOSIT_CONFIRMATIONS: 12,
        PRIVY_DEPOSIT_SWEEP_POLICY_ID: 'policy-1',
      };
      return values[key] ?? fallback;
    }),
  } as unknown as ConfigService;

  it('returns an active address without creating another Privy wallet', async () => {
    const custody = { createOrGetWallet: jest.fn() };
    const service = new DepositAddressService(
      {
        network: {
          findUnique: jest.fn().mockResolvedValue(network),
        },
        tokenContract: {
          findUnique: jest.fn().mockResolvedValue(tokenContract),
        },
        userDepositAddress: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'address-1',
            address: '0x1111111111111111111111111111111111111111',
            status: UserDepositAddressStatus.ACTIVE,
          }),
        },
      } as unknown as PrismaService,
      { getBySymbol: jest.fn().mockResolvedValue(asset) } as unknown as AssetsService,
      custody as unknown as PrivyCustodyService,
      {} as AuditService,
      config,
      {} as never,
    );

    const result = await service.provision('user-1', 'USDC');

    expect(result.address).toBe('0x1111111111111111111111111111111111111111');
    expect(custody.createOrGetWallet).not.toHaveBeenCalled();
  });

  it('persists the Privy wallet returned for a deterministic external id', async () => {
    const update = jest.fn().mockImplementation(({ data }) => ({
      id: 'address-1',
      ...data,
    }));
    const service = new DepositAddressService(
      {
        network: {
          findUnique: jest.fn().mockResolvedValue(network),
        },
        tokenContract: {
          findUnique: jest.fn().mockResolvedValue(tokenContract),
        },
        userDepositAddress: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: 'address-1',
            status: UserDepositAddressStatus.PROVISIONING,
          }),
          update,
        },
      } as unknown as PrismaService,
      { getBySymbol: jest.fn().mockResolvedValue(asset) } as unknown as AssetsService,
      {
        createOrGetWallet: jest.fn().mockResolvedValue({
          id: 'privy-wallet-1',
          address: '0x2222222222222222222222222222222222222222',
        }),
      } as unknown as PrivyCustodyService,
      { record: jest.fn() } as unknown as AuditService,
      config,
      {} as never,
    );

    const result = await service.provision('user-1', 'USDC');

    expect(result.status).toBe(UserDepositAddressStatus.ACTIVE);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'address-1' },
      data: expect.objectContaining({
        providerWalletRef: 'privy-wallet-1',
        policyRef: 'policy-1',
        status: UserDepositAddressStatus.ACTIVE,
      }),
    });
  });

  it('retries a failed provisioning row', async () => {
    const update = jest.fn()
      .mockResolvedValueOnce({
        id: 'address-1',
        status: UserDepositAddressStatus.PROVISIONING,
      })
      .mockImplementationOnce(({ data }) => ({
        id: 'address-1',
        ...data,
      }));
    const service = new DepositAddressService(
      {
        network: {
          findUnique: jest.fn().mockResolvedValue(network),
        },
        tokenContract: {
          findUnique: jest.fn().mockResolvedValue(tokenContract),
        },
        userDepositAddress: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'address-1',
            address: 'pending:ARBITRUM_SEPOLIA:user-1',
            status: UserDepositAddressStatus.FAILED,
            failureReason: 'old failure',
          }),
          update,
        },
      } as unknown as PrismaService,
      { getBySymbol: jest.fn().mockResolvedValue(asset) } as unknown as AssetsService,
      {
        createOrGetWallet: jest.fn().mockResolvedValue({
          id: 'privy-wallet-1',
          address: '0x2222222222222222222222222222222222222222',
        }),
      } as unknown as PrivyCustodyService,
      { record: jest.fn() } as unknown as AuditService,
      config,
      {} as never,
    );

    const result = await service.provision('user-1', 'USDC');

    expect(result.status).toBe(UserDepositAddressStatus.ACTIVE);
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: 'address-1' },
      data: {
        status: UserDepositAddressStatus.PROVISIONING,
        failureReason: null,
      },
    });
  });
});
