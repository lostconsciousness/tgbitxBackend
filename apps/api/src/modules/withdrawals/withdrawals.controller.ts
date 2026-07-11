import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { getRequestMetadata } from '../../common/utils/request-metadata';
import { AuditService } from '../audit/audit.service';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { WithdrawalAdminDecisionDto } from './dto/withdrawal-admin-decision.dto';
import { WithdrawalsService } from './withdrawals.service';

@ApiTags('withdrawals')
@Controller()
export class WithdrawalsController {
  constructor(
    private readonly withdrawalsService: WithdrawalsService,
    private readonly auditService: AuditService,
  ) {}

  @Post('withdrawals')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Request a withdrawal and reserve ledger balance' })
  async request(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWithdrawalDto,
    @Req() request: Request,
  ) {
    const withdrawal = await this.withdrawalsService.requestWithdrawal(user.id, dto);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'WITHDRAWAL_REQUEST',
      entityType: 'Withdrawal',
      entityId: withdrawal.id,
      metadata: { assetSymbol: withdrawal.asset.symbol, amount: withdrawal.amount.toString() },
      ...getRequestMetadata(request),
    });
    return withdrawal;
  }

  @Get('withdrawals/options')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List all withdrawable assets and networks with ledger balances' })
  listOptions(@CurrentUser() user: AuthenticatedUser) {
    return this.withdrawalsService.listWithdrawalOptions(user.id);
  }

  @Get('withdrawals/networks')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'List withdrawal networks for an asset with unified exchange balance',
  })
  listNetworks(
    @CurrentUser() user: AuthenticatedUser,
    @Query('assetSymbol') assetSymbol: string,
  ) {
    return this.withdrawalsService.getWithdrawalNetworks(
      user.id,
      assetSymbol?.trim().toUpperCase() || 'USDC',
    );
  }

  @Get('withdrawals')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List current user withdrawals' })
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.withdrawalsService.listUserWithdrawals(user.id);
  }

  @Post('withdrawals/:id/cancel')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Cancel a withdrawal before approval/broadcast' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.withdrawalsService.cancelWithdrawal(user.id, id);
  }

  @Get('admin/withdrawals')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin list withdrawals' })
  listAdmin(@Query('take') take?: string) {
    return this.withdrawalsService.listAdminWithdrawals(Number(take ?? 100));
  }

  @Post('admin/withdrawals/:id/approve')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Approve a pending withdrawal' })
  async approve(
    @Param('id') id: string,
    @Body() dto: WithdrawalAdminDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const withdrawal = await this.withdrawalsService.approveWithdrawal({
      withdrawalId: id,
      adminUserId: user.id,
      reason: dto.reason,
    });
    await this.auditService.record({
      actorUserId: user.id,
      action: 'WITHDRAWAL_APPROVE',
      entityType: 'Withdrawal',
      entityId: withdrawal.id,
      reason: dto.reason,
      metadata: { assetSymbol: withdrawal.asset.symbol, amount: withdrawal.amount.toString() },
      ...getRequestMetadata(request),
    });
    return withdrawal;
  }

  @Post('admin/withdrawals/:id/reject')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Reject a pending withdrawal and release reserved balance' })
  async reject(
    @Param('id') id: string,
    @Body() dto: WithdrawalAdminDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const withdrawal = await this.withdrawalsService.rejectWithdrawal({
      withdrawalId: id,
      adminUserId: user.id,
      reason: dto.reason,
    });
    await this.auditService.record({
      actorUserId: user.id,
      action: 'WITHDRAWAL_REJECT',
      entityType: 'Withdrawal',
      entityId: withdrawal.id,
      reason: dto.reason,
      metadata: { assetSymbol: withdrawal.asset.symbol, amount: withdrawal.amount.toString() },
      ...getRequestMetadata(request),
    });
    return withdrawal;
  }
}
