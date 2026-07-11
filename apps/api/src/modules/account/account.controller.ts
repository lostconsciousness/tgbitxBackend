import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { DepositIndexerService } from '../deposits/deposit-indexer.service';
import { AccountService } from './account.service';

@ApiTags('account')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('account')
export class AccountController {
  constructor(
    private readonly accountService: AccountService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get('overview')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get current user profile and currency balances for cabinet UI' })
  async overview(@CurrentUser() user: AuthenticatedUser) {
    const depositIndexer = this.moduleRef.get(DepositIndexerService, { strict: false });
    if (depositIndexer) {
      depositIndexer.syncPersonalDepositsForUser(user.id, { mode: 'background' });
    }
    return this.accountService.getOverview(user.id);
  }
}
