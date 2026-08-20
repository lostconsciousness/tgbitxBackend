import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma, UserRole } from '@prisma/client';
import { IsString, Matches } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ReconciliationService } from './reconciliation.service';
import { OrdersService } from '../orders/orders.service';
import { AuditService } from '../audit/audit.service';

class ProviderPositionOffsetDto {
  @IsString()
  @Matches(/^-?\d+(?:\.\d+)?$/)
  size!: string;
}

@ApiTags('reconciliation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/reconciliation')
export class ReconciliationController {
  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly ordersService: OrdersService,
    private readonly audit: AuditService,
  ) {}

  @Post('ledger')
  @ApiOperation({ summary: 'Run ledger balance reconciliation immediately' })
  runLedger() {
    return this.reconciliationService.runLedgerBalanceCheck();
  }

  @Post('treasury')
  runTreasury() {
    return this.reconciliationService.runTreasuryBalanceCheck();
  }

  @Post('provider')
  runProvider() {
    return this.reconciliationService.runProviderBalanceCheck();
  }

  @Post('provider-orders')
  runProviderOrders() {
    return this.reconciliationService.runProviderOrdersCheck();
  }

  @Post('provider-orders/:orderId')
  @ApiOperation({ summary: 'Safely reconcile one Hyperliquid order by cloid' })
  reconcileProviderOrder(@Param('orderId') orderId: string) {
    return this.ordersService.reconcileProviderOrder(orderId);
  }

  @Post('provider-positions')
  runProviderPositions() {
    return this.reconciliationService.runProviderPositionsCheck();
  }

  @Patch('provider-position-offsets/:symbol')
  @ApiOperation({
    summary: 'Set an audited legacy/provider inventory residual for A-book reconciliation',
  })
  async setProviderPositionOffset(
    @CurrentUser() user: AuthenticatedUser,
    @Param('symbol') symbol: string,
    @Body() dto: ProviderPositionOffsetDto,
  ) {
    const providerSymbol = symbol.trim().toUpperCase();
    const setting = await this.reconciliationService.setProviderPositionOffset(
      providerSymbol,
      dto.size,
    );
    await this.audit.record({
      actorUserId: user.id,
      action: 'ABOOK_PROVIDER_POSITION_OFFSET_UPDATE',
      entityType: 'SystemSetting',
      entityId: setting.key,
      metadata: { providerSymbol, size: dto.size } as Prisma.InputJsonObject,
    });
    return setting;
  }

  @Post('bbook')
  runBbook() {
    return this.reconciliationService.runBbookExposureCheck();
  }

  @Get('runs')
  @ApiOperation({ summary: 'List reconciliation runs' })
  listRuns(@Query('take') take?: string) {
    return this.reconciliationService.listRuns(Number(take ?? 50));
  }
}
