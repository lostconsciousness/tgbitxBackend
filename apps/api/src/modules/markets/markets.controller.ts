import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { getRequestMetadata } from '../../common/utils/request-metadata';
import { AuditService } from '../audit/audit.service';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { MarketsService } from './markets.service';
import { Request } from 'express';

@ApiTags('markets')
@Controller()
export class MarketsController {
  constructor(
    private readonly marketsService: MarketsService,
    private readonly auditService: AuditService,
  ) {}

  @Get('markets')
  @ApiOperation({ summary: 'List configured markets' })
  list() {
    return this.marketsService.list();
  }

  @Get('markets/:symbol')
  @ApiOperation({ summary: 'Get market by symbol' })
  get(@Param('symbol') symbol: string) {
    return this.marketsService.getBySymbol(symbol);
  }

  @Post('admin/markets')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create market configuration' })
  async createAdmin(
    @Body() dto: CreateMarketDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const market = await this.marketsService.create(dto);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'MARKET_CREATE',
      entityType: 'Market',
      entityId: market.id,
      metadata: { symbol: market.symbol },
      ...getRequestMetadata(request),
    });
    return market;
  }

  @Patch('admin/markets/:symbol')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update market status' })
  async updateAdmin(
    @Param('symbol') symbol: string,
    @Body() dto: UpdateMarketDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const market = await this.marketsService.update(symbol, dto);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'MARKET_UPDATE',
      entityType: 'Market',
      entityId: market.id,
      metadata: { symbol: market.symbol, status: market.status },
      ...getRequestMetadata(request),
    });
    return market;
  }
}
