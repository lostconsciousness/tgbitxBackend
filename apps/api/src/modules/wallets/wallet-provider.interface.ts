export type EmbeddedWallet = {
  address: string;
  chainType: 'ethereum' | 'solana' | 'tron';
  providerUserRef: string;
  providerWalletRef: string;
};

export type WalletJwk = JsonWebKey & {
  alg: 'RS256';
  kid: string;
  use: 'sig';
};

export interface WalletProvider {
  isEnabled(): boolean;
  createSession(user: { id: string; email: string }): Promise<{
    token: string;
    appId: string;
    clientId?: string;
    expiresAt: string;
  }>;
  getEmbeddedWallet(userId: string): Promise<EmbeddedWallet>;
  getEmbeddedWallets(userId: string): Promise<EmbeddedWallet[]>;
  getJwks(): { keys: WalletJwk[] };
}
