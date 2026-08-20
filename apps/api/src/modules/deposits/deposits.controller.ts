import { Body, Controller, Get, Header, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
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
import { DepositIndexerService } from './deposit-indexer.service';
import { DepositsService } from './deposits.service';
import { ScanDepositsDto } from './dto/scan-deposits.dto';
import { CreateDepositIntentDto } from './dto/create-deposit-intent.dto';
import { SubmitDepositIntentDto } from './dto/submit-deposit-intent.dto';
import { DepositAddressDto } from './dto/deposit-address.dto';
import { DepositAddressService } from './deposit-address.service';
import { DepositSweepStatus, UserDepositAddressStatus } from '@prisma/client';
import { DepositSweepService } from './deposit-sweep.service';

@ApiTags('deposits')
@Controller()
export class DepositsController {
  constructor(
    private readonly depositsService: DepositsService,
    private readonly depositIndexerService: DepositIndexerService,
    private readonly auditService: AuditService,
    private readonly depositAddressService: DepositAddressService,
    private readonly depositSweepService: DepositSweepService,
  ) {}

  @Post('deposits/address')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create or return the personal custody deposit address' })
  depositAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DepositAddressDto,
  ) {
    return this.depositAddressService.provision(user.id, dto.assetSymbol, dto.network);
  }

  @Get('deposits/addresses')
  @Header('Cache-Control', 'private, max-age=60, stale-while-revalidate=300')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List current user personal deposit addresses by network' })
  listDepositAddresses(@CurrentUser() user: AuthenticatedUser) {
    return this.depositAddressService.listUser(user.id);
  }

  @Get('deposits/options')
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List depositable assets and networks for the selection UI' })
  depositOptions(
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.depositsService.listDepositOptions({
      userId: user.id,
      includeDisabled: false,
    });
  }

  @Get('deposits/address/:assetSymbol')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Return an existing personal custody deposit address' })
  existingDepositAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assetSymbol') assetSymbol: string,
    @Query('network') network?: string,
  ) {
    return this.depositAddressService.getExisting(user.id, assetSymbol, network);
  }

  @Get('deposits/instructions/:assetSymbol')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get deposit instructions for current user and asset' })
  instructions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assetSymbol') assetSymbol: string,
    @Query('network') network?: string,
  ) {
    return this.depositsService.getDepositInstructions({
      userId: user.id,
      assetSymbol,
      network,
    });
  }

  @Post('deposits/intents')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create a verified ERC20 deposit intent' })
  createIntent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDepositIntentDto,
  ) {
    return this.depositsService.createIntent({
      userId: user.id,
      assetSymbol: dto.assetSymbol,
      amount: dto.amount,
      walletId: dto.walletId,
      network: dto.network,
    });
  }

  @Get('deposits/intents')
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List active deposit intents for the current user' })
  listIntents(@CurrentUser() user: AuthenticatedUser) {
    return this.depositsService.listActiveIntents(user.id);
  }

  @Post('deposits/intents/:id/submit')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Submit and verify a deposit transaction hash' })
  submitIntent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SubmitDepositIntentDto,
  ) {
    return this.depositsService.submitIntent({
      userId: user.id,
      intentId: id,
      txHash: dto.txHash,
    });
  }

  @Get('deposits/intents/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get a deposit intent and confirmation state' })
  async getIntent(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    this.depositIndexerService.syncPersonalDepositsForUser(user.id, { mode: 'background' });
    return this.depositsService.getIntent(user.id, id);
  }

  @Get('deposits')
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List current user deposits' })
  async listMine(@CurrentUser() user: AuthenticatedUser) {
    this.depositIndexerService.syncPersonalDepositsForUser(user.id, { mode: 'background' });
    return this.depositsService.listUserDeposits(user.id);
  }

  @Get('admin/deposits')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin list deposits' })
  listAdmin(@Query('take') take?: string) {
    return this.depositsService.listAdminDeposits(Number(take ?? 100));
  }

  @Get('admin/deposits/addresses')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin list personal deposit address provisioning state' })
  listAddresses(
    @Query('status') status?: UserDepositAddressStatus,
    @Query('take') take?: string,
  ) {
    return this.depositAddressService.listAdmin({
      status,
      take: Number(take ?? 100),
    });
  }

  @Get('admin/deposits/sweeps')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Admin list pending, blocked and completed deposit sweeps' })
  listSweeps(
    @Query('status') status?: DepositSweepStatus,
    @Query('take') take?: string,
  ) {
    return this.depositSweepService.listAdmin(status, Number(take ?? 100));
  }

  @Post('admin/deposits/indexer/scan')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Scan EVM ERC20/native deposits on the requested network and credit matches' })
  async scan(
    @Body() dto: ScanDepositsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const result = await this.depositIndexerService.scanDeposits(dto);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'DEPOSIT_INDEXER_SCAN',
      entityType: 'Deposit',
      metadata: {
        assetSymbol: dto.assetSymbol,
        network: dto.network,
        fromBlock: dto.fromBlock,
        toBlock: dto.toBlock,
        scannedLogs: result.scannedLogs,
      },
      ...getRequestMetadata(request),
    });
    return result;
  }
}
