import { UserUpdatesService } from './user-updates.service';

describe('UserUpdatesService', () => {
  it('publishes committed user data changes synchronously', () => {
    const service = new UserUpdatesService();
    const listener = jest.fn();
    const unsubscribe = service.subscribe(listener);

    service.publish('user-1', ['balances', 'orders', 'positions']);

    expect(listener).toHaveBeenCalledWith({
      userId: 'user-1',
      kinds: new Set(['balances', 'orders', 'positions']),
    });
    unsubscribe();
    service.publish('user-1', ['balances']);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
