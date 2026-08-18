import { ConfigService } from '@nestjs/config';
import { PrivyCustodyService } from './privy-custody.service';
import { generateKeyPairSync } from 'crypto';

describe('PrivyCustodyService', () => {
  it('signs and broadcasts Solana transactions without exposing a private key', async () => {
    const signAndSendTransaction = jest.fn().mockResolvedValue({
      hash: 'solana-signature',
      transaction_id: 'privy-solana-tx-1',
    });
    const service = new PrivyCustodyService({
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          NODE_ENV: 'development',
          PRIVY_CUSTODY_ENABLED: true,
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_SOLANA_WALLET_ID: 'solana-wallet-id',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:test-key',
          PRIVY_ENV_AUTHORIZATION_MAINNET_ENABLED: true,
        };
        return values[key] ?? fallback;
      }),
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_SOLANA_WALLET_ID: 'solana-wallet-id',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:test-key',
        };
        return values[key];
      }),
    } as unknown as ConfigService);
    (service as any).dynamicImport = jest.fn().mockResolvedValue({
      PrivyClient: class {
        wallets() {
          return { solana: () => ({ signAndSendTransaction }) };
        }
      },
    });

    const result = await service.sendSolanaTransaction({
      transaction: Buffer.from('unsigned-transaction').toString('base64'),
      referenceId: 'withdrawal:sol-1',
      mainnet: true,
    });

    expect(signAndSendTransaction).toHaveBeenCalledWith(
      'solana-wallet-id',
      expect.objectContaining({
        caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        idempotency_key: 'withdrawal:sol-1',
        authorization_context: {
          authorization_private_keys: ['wallet-auth:test-key'],
        },
      }),
    );
    expect(result).toEqual({
      txHash: 'solana-signature',
      providerRequestId: 'privy-solana-tx-1',
    });
  });

  it('signs BNB transactions in Privy and broadcasts raw bytes through configured RPC', async () => {
    const signTransaction = jest.fn().mockResolvedValue({
      signed_transaction: `0x${'a'.repeat(200)}`,
    });
    const service = new PrivyCustodyService({
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          NODE_ENV: 'development',
          MAINNET_ENABLED: true,
          PRIVY_CUSTODY_ENABLED: true,
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:test-key',
          PRIVY_ENV_AUTHORIZATION_MAINNET_ENABLED: true,
        };
        return values[key] ?? fallback;
      }),
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_SWEEP_GAS_WALLET_ID: 'gas-wallet-id',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:test-key',
        };
        return values[key];
      }),
    } as unknown as ConfigService);
    (service as any).dynamicImport = jest.fn().mockResolvedValue({
      PrivyClient: class {
        wallets() {
          return {
            get: jest.fn().mockResolvedValue({
              address: '0x1111111111111111111111111111111111111111',
            }),
            ethereum: () => ({ signTransaction }),
          };
        }
      },
    });
    const requestBnbRpc = jest
      .spyOn(service as any, 'requestBnbRpc')
      .mockResolvedValueOnce('0x1')
      .mockResolvedValueOnce('0x3b9aca00')
      .mockResolvedValueOnce('0x5208')
      .mockResolvedValueOnce(`0x${'b'.repeat(64)}`);

    const result = await service.sendNativeFromSweepGas({
      recipient: '0x2222222222222222222222222222222222222222',
      value: 100000000000000n,
      referenceId: 'treasury-rebalance-gas:t1',
      chainId: 56,
    });

    expect(signTransaction).toHaveBeenCalledWith(
      'gas-wallet-id',
      expect.objectContaining({
        idempotency_key: 'treasury-rebalance-gas:t1:sign',
        params: {
          transaction: expect.objectContaining({
            chain_id: 56,
            nonce: '0x1',
            gas_price: '0x3b9aca00',
            type: 0,
          }),
        },
      }),
    );
    expect(requestBnbRpc).toHaveBeenLastCalledWith('eth_sendRawTransaction', [
      `0x${'a'.repeat(200)}`,
    ]);
    expect(result.txHash).toBe(`0x${'b'.repeat(64)}`);
  });

  it('sends authorization context, idempotency key and reference ID together', async () => {
    const sendTransaction = jest.fn().mockResolvedValue({
      hash: `0x${'a'.repeat(64)}`,
      transaction_id: 'privy-tx-1',
      reference_id: 'withdrawal:w1',
    });
    const service = new PrivyCustodyService({
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          NODE_ENV: 'development',
          ONCHAIN_CHAIN_ID: 421614,
          MAINNET_ENABLED: false,
          PRIVY_CUSTODY_ENABLED: true,
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_SERVER_WALLET_ID: 'wallet-id',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'base64-pkcs8',
        };
        return values[key] ?? fallback;
      }),
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_SERVER_WALLET_ID: 'wallet-id',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'base64-pkcs8',
        };
        return values[key];
      }),
    } as unknown as ConfigService);
    (service as any).dynamicImport = jest.fn().mockResolvedValue({
      PrivyClient: class {
        wallets() {
          return { ethereum: () => ({ sendTransaction }) };
        }
      },
    });

    await service.sendErc20({
      tokenAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      recipient: '0x1111111111111111111111111111111111111111',
      rawAmount: 1_000_000n,
      referenceId: 'withdrawal:w1',
    });

    expect(sendTransaction).toHaveBeenCalledWith(
      'wallet-id',
      expect.objectContaining({
        idempotency_key: 'withdrawal:w1',
        reference_id: 'withdrawal:w1',
        authorization_context: {
          authorization_private_keys: ['base64-pkcs8'],
        },
      }),
    );
  });

  it('creates a policy-bound wallet with deterministic Privy idempotency', async () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const encodedPrivateKey = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const create = jest.fn().mockResolvedValue({
      id: 'deposit-wallet-1',
      address: '0x1111111111111111111111111111111111111111',
      external_id: 'deposit_user_1',
    });
    const service = new PrivyCustodyService({
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          NODE_ENV: 'development',
          ONCHAIN_CHAIN_ID: 421614,
          MAINNET_ENABLED: false,
          PRIVY_CUSTODY_ENABLED: true,
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: encodedPrivateKey,
          PRIVY_DEPOSIT_SWEEP_POLICY_ID: 'policy-1',
        };
        return values[key] ?? fallback;
      }),
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: encodedPrivateKey,
        };
        return values[key];
      }),
    } as unknown as ConfigService);
    (service as any).dynamicImport = jest.fn().mockResolvedValue({
      PrivyClient: class {
        wallets() {
          return {
            list: async function* () {},
            create,
          };
        }
      },
    });

    const wallet = await service.createOrGetWallet({
      externalId: 'deposit_user_1',
      displayName: 'Deposit user 1',
      policyId: 'policy-1',
    });

    expect(wallet.id).toBe('deposit-wallet-1');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        external_id: 'deposit_user_1',
        'privy-idempotency-key': 'deposit_user_1',
        policy_ids: ['policy-1'],
        owner: { public_key: expect.any(String) },
      }),
    );
  });

  it('uses Privy wallet-auth keys as-is and reads the owner public key from env', async () => {
    const { publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const encodedPublicKey = publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
    const create = jest.fn().mockResolvedValue({
      id: 'deposit-wallet-1',
      address: '0x1111111111111111111111111111111111111111',
      external_id: 'deposit_user_1',
    });
    const sendTransaction = jest.fn().mockResolvedValue({
      hash: `0x${'a'.repeat(64)}`,
      transaction_id: 'privy-tx-1',
    });
    const service = new PrivyCustodyService({
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          NODE_ENV: 'development',
          ONCHAIN_CHAIN_ID: 421614,
          MAINNET_ENABLED: false,
          PRIVY_CUSTODY_ENABLED: true,
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_SERVER_WALLET_ID: 'wallet-id',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:test-key',
          PRIVY_AUTHORIZATION_PUBLIC_KEY: encodedPublicKey,
          PRIVY_DEPOSIT_SWEEP_POLICY_ID: 'policy-1',
        };
        return values[key] ?? fallback;
      }),
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_SERVER_WALLET_ID: 'wallet-id',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:test-key',
        };
        return values[key];
      }),
    } as unknown as ConfigService);
    (service as any).dynamicImport = jest.fn().mockResolvedValue({
      PrivyClient: class {
        wallets() {
          return {
            list: async function* () {},
            create,
            ethereum: () => ({ sendTransaction }),
          };
        }
      },
    });

    await service.createOrGetWallet({
      externalId: 'deposit_user_1',
      displayName: 'Deposit user 1',
      policyId: 'policy-1',
    });
    await service.sendErc20({
      tokenAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      recipient: '0x1111111111111111111111111111111111111111',
      rawAmount: 1_000_000n,
      referenceId: 'withdrawal:w1',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { public_key: encodedPublicKey },
      }),
    );
    expect(sendTransaction).toHaveBeenCalledWith(
      'wallet-id',
      expect.objectContaining({
        authorization_context: {
          authorization_private_keys: ['wallet-auth:test-key'],
        },
      }),
    );
  });

  it('derives the owner public key from a Privy wallet-auth private key', async () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const encodedPrivateKey = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const create = jest.fn().mockResolvedValue({
      id: 'deposit-wallet-1',
      address: '0x1111111111111111111111111111111111111111',
      external_id: 'deposit_user_1',
    });
    const service = new PrivyCustodyService({
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          NODE_ENV: 'development',
          ONCHAIN_CHAIN_ID: 421614,
          MAINNET_ENABLED: false,
          PRIVY_CUSTODY_ENABLED: true,
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: `wallet-auth:${encodedPrivateKey}`,
          PRIVY_DEPOSIT_SWEEP_POLICY_ID: 'policy-1',
        };
        return values[key] ?? fallback;
      }),
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: `wallet-auth:${encodedPrivateKey}`,
        };
        return values[key];
      }),
    } as unknown as ConfigService);
    (service as any).dynamicImport = jest.fn().mockResolvedValue({
      PrivyClient: class {
        wallets() {
          return {
            list: async function* () {},
            create,
          };
        }
      },
    });

    await service.createOrGetWallet({
      externalId: 'deposit_user_1',
      displayName: 'Deposit user 1',
      policyId: 'policy-1',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { public_key: expect.stringMatching(/^MF/) },
      }),
    );
  });

  it('sends a validated structured Tron transaction through Privy', async () => {
    const rpc = jest.fn().mockResolvedValue({
      method: 'tron_sendTransaction',
      data: {
        hash: 'a'.repeat(64),
        transaction_id: 'privy-tron-1',
      },
    });
    const service = new PrivyCustodyService({
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          NODE_ENV: 'development',
          PRIVY_CUSTODY_ENABLED: true,
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_TRON_WALLET_ID: 'tron-wallet-id',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:test-key',
          PRIVY_ENV_AUTHORIZATION_MAINNET_ENABLED: true,
          TRON_RPC_PRIMARY_URL: 'https://api.trongrid.io',
        };
        return values[key] ?? fallback;
      }),
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string> = {
          PRIVY_APP_ID: 'app-id',
          PRIVY_APP_SECRET: 'app-secret',
          PRIVY_TRON_WALLET_ID: 'tron-wallet-id',
          PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64: 'wallet-auth:test-key',
        };
        return values[key];
      }),
    } as unknown as ConfigService);
    (service as any).dynamicImport = jest.fn().mockResolvedValue({
      PrivyClient: class {
        wallets() {
          return {
            get: jest.fn().mockResolvedValue({ address: 'TFrom' }),
            rpc,
          };
        }
      },
    });
    (service as any).createTronWebClient = jest.fn().mockResolvedValue({
      trx: {
        ecRecover: jest.fn().mockReturnValue('TFrom'),
      },
      address: { toHex: jest.fn().mockReturnValue('41owner') },
      transactionBuilder: {
        sendTrx: jest.fn().mockResolvedValue({
          txID: 'a'.repeat(64),
          raw_data_hex: 'aabb',
          raw_data: {
            contract: [{
              type: 'TransferContract',
              parameter: {
                value: {
                  owner_address: '41owner',
                  to_address: '41to',
                  amount: 1000,
                },
              },
            }],
          },
        }),
      },
    });

    const result = await service.sendTronNativeTransfer({
      walletId: 'tron-wallet-id',
      fromAddress: 'TFrom',
      toAddress: 'TTo',
      amountSun: 1000,
      referenceId: 'withdrawal:tron-1',
      mainnet: true,
    });

    expect(rpc).toHaveBeenCalledWith(
      'tron-wallet-id',
      expect.objectContaining({
        method: 'tron_sendTransaction',
        params: {
          raw_data: {
            contract: [{
              type: 'TransferContract',
              owner_address: '41owner',
              to_address: '41to',
              amount: 1000,
            }],
          },
          reference_id: 'withdrawal:tron-1',
        },
      }),
    );
    expect(result).toEqual({
      txHash: 'a'.repeat(64),
      providerRequestId: 'privy-tron-1',
    });
  });

  it('validates the exact Tron TRC20 transfer calldata before signing', () => {
    const service = new PrivyCustodyService({} as ConfigService);
    const recipientHex = '22'.repeat(20);
    const calldata = `a9059cbb${recipientHex.padStart(64, '0')}${'64'.padStart(64, '0')}`;
    expect(() => (service as any).assertTronTrc20Transfer({
      transaction: {
        raw_data_hex: 'aabb',
        raw_data: {
          contract: [{
            type: 'TriggerSmartContract',
            parameter: { value: {
              owner_address: `41${'11'.repeat(20)}`,
              contract_address: `41${'33'.repeat(20)}`,
              data: calldata,
            } },
          }],
        },
      },
      fromAddress: 'TFrom',
      toAddress: 'TTo',
      contractAddress: 'TContract',
      rawAmount: 100n,
      tronWeb: { address: { toHex: jest.fn((address: string) => ({
        TFrom: `41${'11'.repeat(20)}`,
        TTo: `41${recipientHex}`,
        TContract: `41${'33'.repeat(20)}`,
      })[address]) } },
    })).not.toThrow();
  });

  it('maps TronWeb TRC20 data to the structured Privy RPC schema', () => {
    const service = new PrivyCustodyService({} as ConfigService);
    expect((service as any).toPrivyTronRawData({
      raw_data_hex: 'aabb',
      raw_data: {
        contract: [{
          type: 'TriggerSmartContract',
          parameter: { value: {
            owner_address: `41${'11'.repeat(20)}`,
            contract_address: `41${'33'.repeat(20)}`,
            data: 'a9059cbb' + '00'.repeat(64),
          } },
        }],
        fee_limit: 35_000_000,
      },
    }, 'TFrom', {
      address: { toHex: jest.fn().mockReturnValue(`41${'11'.repeat(20)}`) },
    })).toEqual({
      contract: [{
        type: 'TriggerSmartContract',
        owner_address: `41${'11'.repeat(20)}`,
        contract_address: `41${'33'.repeat(20)}`,
      }],
      data: 'a9059cbb' + '00'.repeat(64),
      fee_limit: 35_000_000,
    });
  });

  it('rejects missing Tron TRC20 calldata before signing', () => {
    const service = new PrivyCustodyService({} as ConfigService);
    expect(() => (service as any).assertTronTrc20Transfer({
      transaction: {
        raw_data_hex: 'aabb',
        raw_data: {
          contract: [{
            type: 'TriggerSmartContract',
            parameter: { value: {
              owner_address: `41${'11'.repeat(20)}`,
              contract_address: `41${'33'.repeat(20)}`,
              data: '',
            } },
          }],
        },
      },
      fromAddress: 'TFrom',
      toAddress: 'TTo',
      contractAddress: 'TContract',
      rawAmount: 100n,
      tronWeb: { address: { toHex: jest.fn((address: string) => ({
        TFrom: `41${'11'.repeat(20)}`,
        TTo: `41${'22'.repeat(20)}`,
        TContract: `41${'33'.repeat(20)}`,
      })[address]) } },
    })).toThrow('calldata is missing or malformed');
  });

  it('rejects a malformed Tron smart-contract call instead of signing it', () => {
    const service = new PrivyCustodyService({} as ConfigService);
    expect(() => (service as any).assertTronTrc20Transfer({
      transaction: { raw_data_hex: 'aabb', raw_data: { contract: [] } },
      fromAddress: 'TFrom',
      toAddress: 'TTo',
      contractAddress: 'TContract',
      rawAmount: 1n,
      tronWeb: { address: { toHex: jest.fn() } },
    })).toThrow('Expected one Tron TriggerSmartContract transaction');
  });

  it('rejects non-zero Tron call_value before Privy submission', () => {
    const service = new PrivyCustodyService({} as ConfigService);
    expect(() => (service as any).assertTronTrc20Transfer({
      transaction: {
        raw_data_hex: 'aabb',
        raw_data: { contract: [{
          type: 'TriggerSmartContract',
          parameter: { value: { call_value: 1 } },
        }] },
      },
      fromAddress: 'TFrom',
      toAddress: 'TTo',
      contractAddress: 'TContract',
      rawAmount: 1n,
      tronWeb: { address: { toHex: jest.fn() } },
    })).toThrow();
  });
});
