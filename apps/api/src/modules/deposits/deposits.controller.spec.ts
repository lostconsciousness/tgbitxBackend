import { AuditService } from '../audit/audit.service';
import { DepositAddressService } from './deposit-address.service';
import { DepositIndexerService } from './deposit-indexer.service';
import { DepositSweepService } from './deposit-sweep.service';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';

describe('DepositsController', () => {
  it('defaults deposit options to enabled-only assets', () => {
    const depositsService = {
      listDepositOptions: jest.fn().mockResolvedValue({ assets: [] }),
    };
    const controller = new DepositsController(
      depositsService as unknown as DepositsService,
      {} as DepositIndexerService,
      {} as AuditService,
      {} as DepositAddressService,
      {} as DepositSweepService,
    );

    void controller.depositOptions({ id: 'user-1' } as any);

    expect(depositsService.listDepositOptions).toHaveBeenCalledWith({
      userId: 'user-1',
      includeDisabled: false,
    });
  });

});
