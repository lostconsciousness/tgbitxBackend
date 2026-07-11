import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PrivyCustodyService } from '../treasury/privy-custody.service';
import { WithdrawalsService } from './withdrawals.service';
import { DepositSweepService } from '../deposits/deposit-sweep.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class PrivyWebhookController {
  constructor(
    private readonly custody: PrivyCustodyService,
    private readonly withdrawals: WithdrawalsService,
    private readonly sweeps: DepositSweepService,
  ) {}

  @Post('privy')
  @ApiOperation({ summary: 'Receive signed Privy transaction lifecycle events' })
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('svix-id') id?: string,
    @Headers('svix-timestamp') timestamp?: string,
    @Headers('svix-signature') signature?: string,
  ) {
    if (!request.rawBody || !id || !timestamp || !signature) {
      throw new BadRequestException('Missing raw webhook body or Svix signature headers');
    }
    const payload = await this.custody.verifyWebhook({
      rawBody: request.rawBody.toString('utf8'),
      id,
      timestamp,
      signature,
    });
    const referenceId =
      typeof payload.reference_id === 'string' ? payload.reference_id : '';
    if (referenceId.startsWith('deposit-sweep')) {
      return this.sweeps.handlePrivyWebhook(id, payload);
    }
    return this.withdrawals.handlePrivyWebhook(id, payload);
  }
}
