import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ConvertService } from './convert.service';
import { ConvertOrderbookService } from './convert-orderbook.service';
import { CreateConversionQuoteDto } from './dto/create-conversion-quote.dto';
import { ExecuteConversionDto } from './dto/execute-conversion.dto';

@ApiTags('convert')
@Controller('convert')
export class ConvertController {
  constructor(
    private readonly convert: ConvertService,
    private readonly orderbooks: ConvertOrderbookService,
  ) {}

  @Get('assets')
  @ApiOperation({ summary: 'List assets currently available for conversion' })
  assets() {
    return this.convert.listAssets();
  }

  @Get('spot-assets')
  @ApiOperation({ summary: 'List only executable Spot conversion assets and pairs' })
  spotAssets() {
    return this.convert.listSpotCatalog();
  }

  @Get('spot-tickers')
  @ApiOperation({ summary: 'List current prices for executable Spot conversion pairs' })
  spotTickers() {
    return this.convert.listSpotTickers();
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Check conversion providers without exposing secrets' })
  readiness() {
    return this.convert.getReadiness();
  }

  @Get('orderbook/:pair')
  @ApiOperation({
    summary: 'Indicative Spot liquidity ladder from aggregated 1inch quotes (cached)',
  })
  orderbook(@Param('pair') pair: string) {
    return this.orderbooks.getOrderBook(pair);
  }

  @Post('quote')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create a short-lived exact-input conversion quote' })
  quote(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateConversionQuoteDto) {
    return this.convert.createQuote(user.id, dto);
  }

  @Post('execute')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Reserve balance and execute a conversion idempotently' })
  execute(@CurrentUser() user: AuthenticatedUser, @Body() dto: ExecuteConversionDto) {
    return this.convert.execute(user.id, dto);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List current user conversions' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.convert.list(user.id);
  }

  @Get(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get current user conversion' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.convert.get(user.id, id);
  }
}
