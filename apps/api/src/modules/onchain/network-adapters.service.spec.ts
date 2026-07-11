import { NetworkFamily } from '@prisma/client';
import { NetworkAdaptersService } from './network-adapters.service';

describe('NetworkAdaptersService', () => {
  const service = new NetworkAdaptersService();

  it('reports EVM adapters as implemented', () => {
    expect(service.getStatus(NetworkFamily.EVM)).toEqual({
      family: NetworkFamily.EVM,
      depositImplemented: true,
      withdrawalImplemented: true,
      reason: null,
    });
  });

  it.each([NetworkFamily.SVM, NetworkFamily.UTXO, NetworkFamily.TVM])(
    'reports %s adapters as implemented',
    (family) => {
    expect(service.getStatus(family)).toEqual({
      family,
      depositImplemented: true,
      withdrawalImplemented: true,
      reason: null,
    });
    },
  );
});
