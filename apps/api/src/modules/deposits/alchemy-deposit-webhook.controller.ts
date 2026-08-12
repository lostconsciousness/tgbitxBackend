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
import { AlchemyDepositWebhookService } from './alchemy-deposit-webhook.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class AlchemyDepositWebhookController {
  constructor(private readonly webhooks: AlchemyDepositWebhookService) {}

  @Post('alchemy/address-activity')
  @ApiOperation({ summary: 'Receive signed Alchemy address activity events for EVM deposits' })
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-alchemy-signature') signature?: string,
  ) {
    if (!request.rawBody || !signature) {
      throw new BadRequestException('Missing raw webhook body or X-Alchemy-Signature header');
    }
    return this.webhooks.handle(request.rawBody, signature);
  }
}
