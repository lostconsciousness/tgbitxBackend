import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { LedgerService } from './ledger.service';

@ApiTags('ledger')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ledger')
export class LedgerController {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly config: ConfigService,
  ) {}

  @Get('balances')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List current user spot balances without duplicated network/token metadata',
  })
  balances(@CurrentUser() user: AuthenticatedUser) {
    return this.ledgerService.listUserSpotBalances(user.id, {
      mainnetOnly:
        this.config.get<boolean>('DISPLAY_MAINNET_ONLY', false) ||
        this.config.get<boolean>('MAINNET_ENABLED', false),
    });
  }
}
