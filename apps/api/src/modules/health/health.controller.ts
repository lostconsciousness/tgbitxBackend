import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { HyperliquidExecutionService } from '../hyperliquid/hyperliquid-execution.service';
import { OperationalSettingsService } from '../settings/operational-settings.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly hyperliquid: HyperliquidExecutionService,
    private readonly settings: OperationalSettingsService,
  ) {}

  @Get()
  @ApiOkResponse({ description: 'Liveness probe' })
  liveness(): { status: string; service: string } {
    return {
      status: 'ok',
      service: 'dream-exchange-api',
    };
  }

  @Get('ready')
  @ApiOkResponse({ description: 'Readiness probe' })
  async readiness() {
    const checks = {
      database: await this.checkDatabase(),
      redis: await this.checkRedis(),
      marketData: {
        status: 'ok',
        provider: this.config.get<string>('MARKET_DATA_PROVIDER', 'MOCK'),
        fallbackToMock: this.config.get<boolean>('MARKET_DATA_FALLBACK_TO_MOCK', true),
      },
      providers: {
        hyperliquidExecutionEnabled: this.hyperliquid.isExecutionEnabled(),
        oneInchEnabled: this.config.get<boolean>('ONEINCH_ENABLED', false),
      },
      operations: {
        tradingPaused: await this.settings.getBoolean('trading:paused', 'TRADING_PAUSED', false),
        withdrawalsPaused: await this.settings.getBoolean(
          'withdrawals:paused',
          'WITHDRAWALS_PAUSED',
          false,
        ),
        bbookPaused: await this.settings.getBoolean('bbook:paused', 'BBOOK_PAUSED', false),
      },
    };
    const ready = checks.database.status === 'ok' && checks.redis.status === 'ok';

    return {
      status: ready ? 'ready' : 'degraded',
      checks,
    };
  }

  @Get('provider-status')
  @ApiOkResponse({ description: 'External provider and execution status' })
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

  private async checkDatabase() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : 'database unavailable',
      };
    }
  }

  private async checkRedis() {
    try {
      await this.redis.connect();
      await this.redis.getClient().ping();
      return { status: 'ok' };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : 'redis unavailable',
      };
    }
  }
}
