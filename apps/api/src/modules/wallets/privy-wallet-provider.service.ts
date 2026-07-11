import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createPublicKey, randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import {
  PrivyDisabledException,
  PrivyUnavailableException,
  PrivyWalletNotReadyException,
} from './wallet.errors';
import { EmbeddedWallet, WalletJwk, WalletProvider } from './wallet-provider.interface';

type PrivyLinkedAccount = {
  id?: string;
  wallet_id?: string;
  type?: string;
  address?: string;
  chain_type?: string;
  wallet_client_type?: string;
  connector_type?: string;
};

type PrivyUser = {
  id: string;
  linked_accounts: PrivyLinkedAccount[];
};

@Injectable()
export class PrivyWalletProvider implements WalletProvider, OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<boolean>('PRIVY_ENABLED', false)) {
      this.assertEnabled();
      this.getPrivateKey();
    }
  }

  isEnabled(): boolean {
    return (
      this.config.get<boolean>('PRIVY_ENABLED', false) &&
      Boolean(this.config.get<string>('PRIVY_APP_ID')) &&
      Boolean(this.config.get<string>('PRIVY_APP_SECRET')) &&
      Boolean(this.config.get<string>('PRIVY_JWT_PRIVATE_KEY_BASE64'))
    );
  }

  async createSession(user: { id: string; email: string }) {
    this.assertEnabled();
    const expiresIn = this.config.get<number>('PRIVY_JWT_TTL_SECONDS', 300);
    const privateKey = this.getPrivateKey();
    const token = await this.jwtService.signAsync(
      { email: user.email },
      {
        privateKey,
        algorithm: 'RS256',
        subject: user.id,
        issuer: this.config.get<string>('PRIVY_JWT_ISSUER', 'dream-crypto-exchange'),
        audience: this.config.get<string>('PRIVY_JWT_AUDIENCE', 'privy'),
        expiresIn,
        jwtid: randomUUID(),
        keyid: this.config.get<string>('PRIVY_JWT_KEY_ID', 'dream-exchange-privy-1'),
      },
    );

    return {
      token,
      appId: this.config.getOrThrow<string>('PRIVY_APP_ID'),
      clientId: this.config.get<string>('PRIVY_CLIENT_ID') || undefined,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  async getEmbeddedWallet(userId: string): Promise<EmbeddedWallet> {
    const wallets = await this.getEmbeddedWallets(userId);
    const wallet = wallets.find((candidate) => candidate.chainType === 'ethereum');
    if (!wallet) {
      throw new PrivyWalletNotReadyException();
    }
    return wallet;
  }

  async getEmbeddedWallets(userId: string): Promise<EmbeddedWallet[]> {
    this.assertEnabled();
    const user = await this.fetchUserByCustomAuthId(userId);
    const chainTypes = ['ethereum', 'solana', 'tron'] as const;
    const wallets = chainTypes.flatMap((chainType) => {
      const account = user.linked_accounts.find((candidate) =>
        this.isEmbeddedWallet(candidate, chainType),
      );
      if (!account?.address) {
        return [];
      }
      const address = chainType === 'ethereum' ? getAddress(account.address) : account.address.trim();
      return [{
        address,
        chainType,
        providerUserRef: user.id,
        providerWalletRef: account.id ?? account.wallet_id ?? `${user.id}:${chainType}:${address}`,
      }];
    });
    if (wallets.length === 0) {
      throw new PrivyWalletNotReadyException();
    }
    return wallets;
  }

  getJwks(): { keys: WalletJwk[] } {
    if (!this.isEnabled()) {
      return { keys: [] };
    }

    const jwk = createPublicKey(this.getPrivateKey()).export({ format: 'jwk' });
    return {
      keys: [
        {
          ...jwk,
          alg: 'RS256',
          kid: this.config.get<string>('PRIVY_JWT_KEY_ID', 'dream-exchange-privy-1'),
          use: 'sig',
        },
      ],
    };
  }

  private async fetchUserByCustomAuthId(userId: string): Promise<PrivyUser> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const appId = this.config.getOrThrow<string>('PRIVY_APP_ID');
    const appSecret = this.config.getOrThrow<string>('PRIVY_APP_SECRET');
    const apiUrl = this.config.get<string>('PRIVY_API_URL', 'https://api.privy.io/v1');

    try {
      const response = await fetch(`${apiUrl}/users/custom_auth/id`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
          'content-type': 'application/json',
          'privy-app-id': appId,
        },
        body: JSON.stringify({ custom_user_id: userId }),
        signal: controller.signal,
      });

      if (response.status === 404) {
        throw new PrivyWalletNotReadyException('Privy user has not been created yet');
      }
      if (!response.ok) {
        throw new PrivyUnavailableException();
      }

      return (await response.json()) as PrivyUser;
    } catch (error) {
      if (
        error instanceof PrivyWalletNotReadyException ||
        error instanceof PrivyUnavailableException
      ) {
        throw error;
      }
      throw new PrivyUnavailableException();
    } finally {
      clearTimeout(timeout);
    }
  }

  private isEmbeddedWallet(
    account: PrivyLinkedAccount,
    chainType: 'ethereum' | 'solana' | 'tron',
  ): boolean {
    if (!account.address || account.chain_type !== chainType) {
      return false;
    }

    return (
      account.type === 'wallet' &&
      account.wallet_client_type === 'privy' &&
      account.connector_type === 'embedded'
    );
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new PrivyDisabledException();
    }
  }

  private getPrivateKey(): string {
    const encoded = this.config.getOrThrow<string>('PRIVY_JWT_PRIVATE_KEY_BASE64');
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    if (!decoded.includes('BEGIN PRIVATE KEY') && !decoded.includes('BEGIN RSA PRIVATE KEY')) {
      throw new PrivyDisabledException();
    }
    try {
      createPublicKey(decoded);
    } catch (_error) {
      throw new PrivyDisabledException();
    }
    return decoded;
  }
}
