import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MarketDataService } from './market-data.service';

@ApiTags('market-data')
@Controller('market-data')
export class MarketDataController {
  constructor(private readonly marketDataService: MarketDataService) {}

  @Get('orderbook/:symbol')
  @ApiOperation({ summary: 'Get configured provider order book snapshot' })
  getOrderBook(@Param('symbol') symbol: string) {
    return this.marketDataService.getOrderBook(symbol);
  }

  @Get('ticker/:symbol')
  @ApiOperation({ summary: 'Get ticker built from order book and internal trades' })
  getTicker(@Param('symbol') symbol: string) {
    return this.marketDataService.getTicker(symbol);
  }

  @Get('tickers')
  @ApiOperation({ summary: 'Get provider tickers for all configured perpetual markets' })
  getTickers() {
    return this.marketDataService.getTickers();
  }

  @Get('trades/:symbol')
  @ApiOperation({ summary: 'Get recent internal trades for a market' })
  getTrades(@Param('symbol') symbol: string, @Query('take') take?: string) {
    return this.marketDataService.getRecentTrades(symbol, Number(take ?? 50));
  }

  @Get('candles/:symbol')
  @ApiOperation({ summary: 'Get candles built from internal trades' })
  getCandles(
    @Param('symbol') symbol: string,
    @Query('interval') interval?: string,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.marketDataService.getCandles(
      symbol,
      interval ?? '1m',
      Number(limit ?? 2_000),
      from ? Number(from) : undefined,
      to ? Number(to) : undefined,
    );
  }
}
