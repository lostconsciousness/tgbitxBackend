import { Injectable } from '@nestjs/common';
import { NetworkFamily } from '@prisma/client';

type AdapterStatus = {
  family: NetworkFamily;
  depositImplemented: boolean;
  withdrawalImplemented: boolean;
  reason: string | null;
};

@Injectable()
export class NetworkAdaptersService {
  getStatus(family: NetworkFamily): AdapterStatus {
    if (
      family === NetworkFamily.EVM ||
      family === NetworkFamily.SVM ||
      family === NetworkFamily.UTXO ||
      family === NetworkFamily.TVM
    ) {
      return {
        family,
        depositImplemented: true,
        withdrawalImplemented: true,
        reason: null,
      };
    }

    return {
      family,
      depositImplemented: false,
      withdrawalImplemented: false,
      reason: `${family} adapter is not enabled yet`,
    };
  }

  assertDepositImplemented(family: NetworkFamily): void {
    const status = this.getStatus(family);
    if (!status.depositImplemented) {
      throw new Error(status.reason ?? `${family} deposit adapter is not enabled yet`);
    }
  }

  assertWithdrawalImplemented(family: NetworkFamily): void {
    const status = this.getStatus(family);
    if (!status.withdrawalImplemented) {
      throw new Error(status.reason ?? `${family} withdrawal adapter is not enabled yet`);
    }
  }
}
