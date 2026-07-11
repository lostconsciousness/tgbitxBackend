import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ReconciliationService } from './reconciliation.service';
import { OrdersService } from '../orders/orders.service';

@ApiTags('reconciliation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/reconciliation')
export class ReconciliationController {
  constructor(
    private readonly reconciliationService: ReconciliationService,
    private readonly ordersService: OrdersService,
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
