import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BuildSpotSwapDto, SpotQuoteDto } from './dto/one-inch.dto';
import { OneInchSwapProviderService } from './one-inch-swap-provider.service';

@ApiTags('spot')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('spot')
export class SpotController {
  constructor(private readonly oneInch: OneInchSwapProviderService) {}

  @Get('provider-status')
  @ApiOperation({ summary: 'Get configured spot swap provider status' })
  providerStatus() {
    return this.oneInch.getStatus();
  }

  @Get('quote')
  @ApiOperation({ summary: 'Get 1inch quote for a wallet-signed spot swap' })
  quote(@Query() dto: SpotQuoteDto) {
    return this.oneInch.getQuote(dto);
  }

  @Post('swap/build')
  @ApiOperation({ summary: 'Build 1inch swap transaction payload for frontend signing' })
  buildSwap(@Body() dto: BuildSpotSwapDto) {
    return this.oneInch.buildSwap(dto);
  }
}
