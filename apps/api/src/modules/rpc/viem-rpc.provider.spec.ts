import { ConfigService } from '@nestjs/config';
import { privateKeyToAccount } from 'viem/accounts';
import { ViemRpcProvider } from './viem-rpc.provider';

describe('ViemRpcProvider wallet signature verification', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('verifies an EOA signature without an RPC provider', async () => {
    const account = privateKeyToAccount(
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    const message = 'Dream Crypto Exchange SIWE test';
    const signature = await account.signMessage({ message });
    const provider = new ViemRpcProvider(createConfig());

    await expect(
      provider.verifyMessage({
        address: account.address,
        message,
        signature,
      }),
    ).resolves.toBe(true);
  });

  it('accepts the ERC-1271 magic value returned by a contract wallet', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: `0x1626ba7e${'0'.repeat(56)}`,
        }),
        { status: 200 },
      ),
    );
    const provider = new ViemRpcProvider(
      createConfig({ ARBITRUM_RPC_PRIMARY_URL: 'https://rpc.example.test' }),
    );

    await expect(
      provider.verifyMessage({
        address: '0x1111111111111111111111111111111111111111',
        message: 'contract wallet test',
        signature: '0x1234',
      }),
    ).resolves.toBe(true);
  });

  it('aborts an RPC attempt after the configured timeout', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as typeof fetch;
    const provider = new ViemRpcProvider(
      createConfig({
        ARBITRUM_RPC_PRIMARY_URL: 'https://rpc.example.test',
        RPC_REQUEST_TIMEOUT_MS: 500,
        RPC_RETRY_ATTEMPTS: 1,
      }),
    );

    const request = provider.getLatestBlockNumber();
    const rejection = expect(request).rejects.toMatchObject({
      name: 'ServiceUnavailableException',
    });
    await jest.advanceTimersByTimeAsync(500);

    await rejection;
    jest.useRealTimers();
  });

  it('coalesces latest block reads inside the short cache window', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }),
        { status: 200 },
      ),
    );
    const provider = new ViemRpcProvider(
      createConfig({ ARBITRUM_RPC_PRIMARY_URL: 'https://rpc.example.test' }),
    );

    await expect(
      Promise.all([
        provider.getLatestBlockNumber('arbitrum'),
        provider.getLatestBlockNumber('arbitrum'),
      ]),
    ).resolves.toEqual([16, 16]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  function createConfig(overrides: Record<string, unknown> = {}): ConfigService {
    const values: Record<string, unknown> = {
      ARBITRUM_RPC_PRIMARY_URL: '',
      ARBITRUM_RPC_FALLBACK_URL: '',
      ...overrides,
    };
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  }
});
