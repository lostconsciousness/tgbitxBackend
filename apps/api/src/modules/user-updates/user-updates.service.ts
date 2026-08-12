import { Injectable } from '@nestjs/common';

export type UserUpdateKind =
  | 'balances'
  | 'orders'
  | 'positions'
  | 'trades'
  | 'wallets'
  | 'deposits';

export type UserUpdate = {
  userId: string;
  kinds: ReadonlySet<UserUpdateKind>;
};

type UserUpdateListener = (update: UserUpdate) => void;

@Injectable()
export class UserUpdatesService {
  private readonly listeners = new Set<UserUpdateListener>();

  publish(userId: string, kinds: UserUpdateKind[]): void {
    if (!userId || kinds.length === 0) return;
    const update: UserUpdate = { userId, kinds: new Set(kinds) };
    for (const listener of this.listeners) listener(update);
  }

  subscribe(listener: UserUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
