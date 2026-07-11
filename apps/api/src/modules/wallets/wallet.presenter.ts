import { Wallet } from '@prisma/client';

export function toWalletResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    type: wallet.type,
    provider: wallet.provider,
    address: wallet.address,
    chain: wallet.chain,
    label: wallet.label,
    status: wallet.status,
    isPrimary: wallet.isPrimary,
    verifiedAt: wallet.verifiedAt,
    createdAt: wallet.createdAt,
  };
}
