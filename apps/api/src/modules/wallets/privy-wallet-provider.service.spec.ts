import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'node:crypto';
import {
  PrivyDisabledException,
  PrivyWalletNotReadyException,
} from './wallet.errors';
import { PrivyWalletProvider } from './privy-wallet-provider.service';

describe('PrivyWalletProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns disabled capabilities and rejects sessions without credentials', async () => {
    const provider = new PrivyWalletProvider(
      createConfig({ PRIVY_ENABLED: false }),
      new JwtService(),
    );

    expect(provider.isEnabled()).toBe(false);
    expect(provider.getJwks()).toEqual({ keys: [] });
    await expect(
      provider.createSession({ id: 'user-1', email: 'trader@example.com' }),
    ).rejects.toBeInstanceOf(PrivyDisabledException);
  });

  it('issues an RS256 token and exposes the matching public JWK', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    });
    const jwtService = new JwtService();
    const provider = new PrivyWalletProvider(
      createConfig({
        PRIVY_ENABLED: true,
        PRIVY_APP_ID: 'privy-app',
        PRIVY_APP_SECRET: 'privy-secret',
        PRIVY_CLIENT_ID: 'privy-client',
        PRIVY_JWT_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
      }),
      jwtService,
    );

    const session = await provider.createSession({
      id: 'user-1',
      email: 'trader@example.com',
    });
    const payload = await jwtService.verifyAsync(session.token, {
      publicKey,
      algorithms: ['RS256'],
      issuer: 'dream-crypto-exchange',
      audience: 'privy',
    });

    expect(payload).toMatchObject({
      sub: 'user-1',
      email: 'trader@example.com',
    });
    expect(session).toMatchObject({
      appId: 'privy-app',
      clientId: 'privy-client',
    });
    expect(provider.getJwks().keys[0]).toMatchObject({
      alg: 'RS256',
      kid: 'dream-exchange-privy-1',
      kty: 'RSA',
      use: 'sig',
    });
  });

  it('returns the embedded Ethereum wallet verified by Privy', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'did:privy:user-1',
          linked_accounts: [
            {
              id: 'privy-wallet-1',
              type: 'wallet',
              address: '0x1111111111111111111111111111111111111111',
              chain_type: 'ethereum',
              wallet_client_type: 'privy',
              connector_type: 'embedded',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = createEnabledProvider();

    await expect(provider.getEmbeddedWallet('user-1')).resolves.toEqual({
      address: '0x1111111111111111111111111111111111111111',
      chainType: 'ethereum',
      providerUserRef: 'did:privy:user-1',
      providerWalletRef: 'privy-wallet-1',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.privy.io/v1/users/custom_auth/id',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ custom_user_id: 'user-1' }),
      }),
    );
  });

  it('returns embedded Ethereum, Solana and Tron wallets from the Privy user', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: 'did:privy:user-1',
        linked_accounts: [
          {
            id: 'evm-1', type: 'wallet', chain_type: 'ethereum',
            address: '0x1111111111111111111111111111111111111111',
            wallet_client_type: 'privy', connector_type: 'embedded',
          },
          {
            id: 'sol-1', type: 'wallet', chain_type: 'solana',
            address: '11111111111111111111111111111111',
            wallet_client_type: 'privy', connector_type: 'embedded',
          },
          {
            id: 'tron-1', type: 'wallet', chain_type: 'tron',
            address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
            wallet_client_type: 'privy', connector_type: 'embedded',
          },
        ],
      }), { status: 200 }),
    );

    await expect(createEnabledProvider().getEmbeddedWallets('user-1')).resolves.toEqual([
      expect.objectContaining({ chainType: 'ethereum', providerWalletRef: 'evm-1' }),
      expect.objectContaining({ chainType: 'solana', providerWalletRef: 'sol-1' }),
      expect.objectContaining({ chainType: 'tron', providerWalletRef: 'tron-1' }),
    ]);
  });

  it('does not accept a Privy user without an embedded Ethereum wallet', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'did:privy:user-1',
          linked_accounts: [
            {
              type: 'wallet',
              address: '0x1111111111111111111111111111111111111111',
              chain_type: 'ethereum',
              wallet_client_type: 'metamask',
              connector_type: 'injected',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(createEnabledProvider().getEmbeddedWallet('user-1')).rejects.toBeInstanceOf(
      PrivyWalletNotReadyException,
    );
  });

  it('fails startup validation when Privy is enabled with an invalid RSA key', () => {
    const provider = new PrivyWalletProvider(
      createConfig({
        PRIVY_ENABLED: true,
        PRIVY_APP_ID: 'privy-app',
        PRIVY_APP_SECRET: 'privy-secret',
        PRIVY_JWT_PRIVATE_KEY_BASE64: Buffer.from(
          '-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----',
        ).toString('base64'),
      }),
      new JwtService(),
    );

    expect(() => provider.onModuleInit()).toThrow(PrivyDisabledException);
  });

  function createEnabledProvider(): PrivyWalletProvider {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
      publicKeyEncoding: { format: 'pem', type: 'spki' },
    });
    return new PrivyWalletProvider(
      createConfig({
        PRIVY_ENABLED: true,
        PRIVY_APP_ID: 'privy-app',
        PRIVY_APP_SECRET: 'privy-secret',
        PRIVY_JWT_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
      }),
      new JwtService(),
    );
  }

  function createConfig(overrides: Record<string, unknown>): ConfigService {
    const values: Record<string, unknown> = {
      PRIVY_ENABLED: false,
      PRIVY_APP_ID: '',
      PRIVY_APP_SECRET: '',
      PRIVY_CLIENT_ID: '',
      PRIVY_API_URL: 'https://api.privy.io/v1',
      PRIVY_JWT_PRIVATE_KEY_BASE64: '',
      PRIVY_JWT_KEY_ID: 'dream-exchange-privy-1',
      PRIVY_JWT_ISSUER: 'dream-crypto-exchange',
      PRIVY_JWT_AUDIENCE: 'privy',
      PRIVY_JWT_TTL_SECONDS: 300,
      ...overrides,
    };
    return {
      get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
      getOrThrow: jest.fn((key: string) => {
        const value = values[key];
        if (value === undefined || value === '') throw new Error(`Missing ${key}`);
        return value;
      }),
    } as unknown as ConfigService;
  }
});
