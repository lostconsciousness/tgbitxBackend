import { BadRequestException, Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, UserRole } from '@prisma/client';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { HyperliquidExecutionService } from '../hyperliquid/hyperliquid-execution.service';
import { OperationalSettingsService } from '../settings/operational-settings.service';

class PauseDto {
  @IsBoolean()
  enabled!: boolean;
}

class UpdateRiskDto {
  @IsOptional()
  @IsBoolean()
  bbookEnabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^\d+(?:\.\d+)?$/)
  maxBbookOrderNotional?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+(?:\.\d+)?$/)
  maxMarketExposure?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxLeverage?: number;
}

class UpdateFeeDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  makerFeeBps?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  takerFeeBps?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  liquidationFeeBps?: number;
}

@ApiTags('admin-risk')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/risk')
export class RiskAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: OperationalSettingsService,
    private readonly hyperliquid: HyperliquidExecutionService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  @Get('bbook/status')
  async bbookStatus() {
    const [paused, exposures] = await Promise.all([
      this.settings.getBoolean('bbook:paused', 'BBOOK_PAUSED', false),
      this.prisma.bBookExposure.findMany({ include: { market: true } }),
    ]);
    const capital = new Prisma.Decimal(this.config.get<string>('PLATFORM_CAPITAL_USDC', '0'));
    const insurance = new Prisma.Decimal(this.config.get<string>('INSURANCE_CAPITAL_USDC', '0'));
    const minimumCapital = new Prisma.Decimal(this.config.get<string>('BBOOK_MIN_PLATFORM_CAPITAL_USDC', '500'));
    const minimumInsurance = new Prisma.Decimal(this.config.get<string>('BBOOK_MIN_INSURANCE_CAPITAL_USDC', '100'));
    return {
      enabled: this.config.get<boolean>('BBOOK_ENABLED', false),
      paused,
      funded: capital.greaterThanOrEqualTo(minimumCapital) && insurance.greaterThanOrEqualTo(minimumInsurance),
      capital: capital.toString(),
      insurance: insurance.toString(),
      minimumCapital: minimumCapital.toString(),
      minimumInsurance: minimumInsurance.toString(),
      exposures,
    };
  }

  @Get('overview')
  async overview() {
    const [custody, exposures, liquidations] = await Promise.all([
      this.prisma.custodyAccount.findMany({ orderBy: { role: 'asc' } }),
      this.prisma.bBookExposure.findMany({ include: { market: true } }),
      this.prisma.liquidationEvent.findMany({
        orderBy: { triggeredAt: 'desc' },
        take: 50,
      }),
    ]);
    return {
      custody,
      exposures,
      liquidations,
      hyperliquidExecutionEnabled: this.hyperliquid.isExecutionEnabled(),
    };
  }

  @Get('settings')
  async listSettings() {
    const [riskConfigs, feeConfigs, systemSettings] = await Promise.all([
      this.prisma.riskConfig.findMany({ include: { market: true } }),
      this.prisma.feeConfig.findMany({ include: { market: true } }),
      this.prisma.systemSetting.findMany({
        where: {
          key: {
            in: [
              'trading:paused',
              'abook:reconciliation-paused',
              'withdrawals:paused',
              'bbook:paused',
            ],
          },
        },
      }),
    ]);
    return {
      riskConfigs,
      feeConfigs,
      operationalSettings: systemSettings,
    };
  }

  @Patch('markets/:symbol')
  async updateRisk(
    @CurrentUser() user: AuthenticatedUser,
    @Param('symbol') symbol: string,
    @Body() dto: UpdateRiskDto,
  ) {
    const market = await this.prisma.market.findUniqueOrThrow({
      where: { symbol: symbol.toUpperCase() },
    });
    const risk = await this.prisma.riskConfig.upsert({
      where: { marketId: market.id },
      update: dto,
      create: {
        marketId: market.id,
        maxLeverage: dto.maxLeverage ?? (market.symbol.startsWith('SOL') ? 5 : 10),
        ...dto,
      },
    });
    await this.audit.record({
      actorUserId: user.id,
      action: 'RISK_CONFIG_UPDATE',
      entityType: 'Market',
      entityId: market.id,
      metadata: { ...dto } as Prisma.InputJsonObject,
    });
    return risk;
  }

  @Patch('fees/:symbol')
  async updateFees(
    @CurrentUser() user: AuthenticatedUser,
    @Param('symbol') symbol: string,
    @Body() dto: UpdateFeeDto,
  ) {
    const market = await this.prisma.market.findUniqueOrThrow({
      where: { symbol: symbol.toUpperCase() },
    });
    const fees = await this.prisma.feeConfig.upsert({
      where: { marketId: market.id },
      update: dto,
      create: { marketId: market.id, ...dto },
    });
    await this.audit.record({
      actorUserId: user.id,
      action: 'FEE_CONFIG_UPDATE',
      entityType: 'Market',
      entityId: market.id,
      metadata: { ...dto } as Prisma.InputJsonObject,
    });
    return fees;
  }

  @Patch('pause/trading')
  pauseTrading(@CurrentUser() user: AuthenticatedUser, @Body() dto: PauseDto) {
    return this.setPause(user.id, 'trading:paused', dto.enabled);
  }

  @Patch('pause/withdrawals')
  pauseWithdrawals(@CurrentUser() user: AuthenticatedUser, @Body() dto: PauseDto) {
    return this.setPause(user.id, 'withdrawals:paused', dto.enabled);
  }

  @Patch('pause/bbook')
  async pauseBbook(@CurrentUser() user: AuthenticatedUser, @Body() dto: PauseDto) {
    if (!dto.enabled) {
      const capital = new Prisma.Decimal(this.config.get<string>('PLATFORM_CAPITAL_USDC', '0'));
      const insurance = new Prisma.Decimal(this.config.get<string>('INSURANCE_CAPITAL_USDC', '0'));
      const minimumCapital = new Prisma.Decimal(this.config.get<string>('BBOOK_MIN_PLATFORM_CAPITAL_USDC', '500'));
      const minimumInsurance = new Prisma.Decimal(this.config.get<string>('BBOOK_MIN_INSURANCE_CAPITAL_USDC', '100'));
      if (
        !this.config.get<boolean>('BBOOK_ENABLED', false) ||
        capital.lessThan(minimumCapital) ||
        insurance.lessThan(minimumInsurance)
      ) {
        throw new BadRequestException({
          code: 'BBOOK_ACTIVATION_GATES_FAILED',
          reasons: [
            ...(!this.config.get<boolean>('BBOOK_ENABLED', false) ? ['BBOOK_DISABLED'] : []),
            ...(capital.lessThan(minimumCapital) ? ['PLATFORM_CAPITAL_INSUFFICIENT'] : []),
            ...(insurance.lessThan(minimumInsurance) ? ['INSURANCE_CAPITAL_INSUFFICIENT'] : []),
          ],
        });
      }
    }
    return this.setPause(user.id, 'bbook:paused', dto.enabled);
  }

  private async setPause(userId: string, key: string, value: boolean) {
    const setting = await this.settings.setBoolean(key, value);
    await this.audit.record({
      actorUserId: userId,
      action: 'OPERATIONAL_SETTING_UPDATE',
      entityType: 'SystemSetting',
      entityId: key,
      metadata: { value },
    });
    return setting;
  }
}
