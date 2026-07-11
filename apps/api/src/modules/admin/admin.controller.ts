import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../database/prisma.service';
import { HyperliquidExecutionService } from '../hyperliquid/hyperliquid-execution.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly hyperliquid: HyperliquidExecutionService,
  ) {}

  @Get('users')
  @ApiOperation({ summary: 'List users for admin operations' })
  @ApiOkResponse({ description: 'Users list' })
  listUsers(@Query('take') take?: string) {
    return this.prisma.user.findMany({
      take: Math.min(Number(take ?? 50), 100),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'List audit logs' })
  @ApiOkResponse({ description: 'Audit log list' })
  listAuditLogs(@Query('take') take?: string) {
    return this.prisma.auditLog.findMany({
      take: Math.min(Number(take ?? 100), 200),
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get('orders')
  @ApiOperation({ summary: 'List orders with admin filters' })
  listOrders(
    @Query('take') take?: string,
    @Query('userId') userId?: string,
    @Query('symbol') symbol?: string,
    @Query('status') status?: string,
    @Query('route') route?: string,
  ) {
    const where: Prisma.OrderWhereInput = {
      userId,
      status: status ? (status as Prisma.EnumOrderStatusFilter['equals']) : undefined,
      route: route ? (route as Prisma.EnumExecutionRouteNullableFilter['equals']) : undefined,
      market: symbol ? { symbol: symbol.toUpperCase() } : undefined,
    };
    return this.prisma.order.findMany({
      where,
      take: Math.min(Number(take ?? 100), 500),
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, email: true } }, market: true, providerOrder: true },
    });
  }

  @Get('trades')
  @ApiOperation({ summary: 'List trades with admin filters' })
  listTrades(
    @Query('take') take?: string,
    @Query('userId') userId?: string,
    @Query('symbol') symbol?: string,
    @Query('route') route?: string,
  ) {
    const where: Prisma.TradeWhereInput = {
      userId,
      route: route ? (route as Prisma.EnumExecutionRouteFilter['equals']) : undefined,
      market: symbol ? { symbol: symbol.toUpperCase() } : undefined,
    };
    return this.prisma.trade.findMany({
      where,
      take: Math.min(Number(take ?? 100), 500),
      orderBy: { executedAt: 'desc' },
      include: { user: { select: { id: true, email: true } }, market: true },
    });
  }

  @Get('positions')
  @ApiOperation({ summary: 'List positions with admin filters' })
  listPositions(
    @Query('take') take?: string,
    @Query('userId') userId?: string,
    @Query('symbol') symbol?: string,
    @Query('status') status?: string,
    @Query('route') route?: string,
  ) {
    const where: Prisma.PositionWhereInput = {
      userId,
      status: status ? (status as Prisma.EnumPositionStatusFilter['equals']) : undefined,
      route: route ? (route as Prisma.EnumExecutionRouteFilter['equals']) : undefined,
      market: symbol ? { symbol: symbol.toUpperCase() } : undefined,
    };
    return this.prisma.position.findMany({
      where,
      take: Math.min(Number(take ?? 100), 500),
      orderBy: { openedAt: 'desc' },
      include: { user: { select: { id: true, email: true } }, market: true },
    });
  }

  @Get('provider/status')
  @ApiOperation({ summary: 'Get external provider status for admin dashboard' })
  providerStatus() {
    return {
      marketDataProvider: this.config.get<string>('MARKET_DATA_PROVIDER', 'MOCK'),
      marketDataFallbackToMock: this.config.get<boolean>('MARKET_DATA_FALLBACK_TO_MOCK', true),
      hyperliquidExecutionEnabled: this.hyperliquid.isExecutionEnabled(),
      hyperliquidTestnet: this.config.get<boolean>('HYPERLIQUID_TESTNET', true),
      oneInchEnabled: this.config.get<boolean>('ONEINCH_ENABLED', false),
      oneInchChainId: this.config.get<number>('ONEINCH_CHAIN_ID', 42161),
    };
  }
}
