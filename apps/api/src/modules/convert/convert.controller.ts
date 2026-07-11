import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ConvertService } from './convert.service';
import { CreateConversionQuoteDto } from './dto/create-conversion-quote.dto';
import { ExecuteConversionDto } from './dto/execute-conversion.dto';

@ApiTags('convert')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('convert')
export class ConvertController {
  constructor(private readonly convert: ConvertService) {}

  @Get('assets')
  @ApiOperation({ summary: 'List assets currently available for conversion' })
  assets() {
    return this.convert.listAssets();
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Check conversion providers without exposing secrets' })
  readiness() {
    return this.convert.getReadiness();
  }

  @Post('quote')
  @ApiOperation({ summary: 'Create a short-lived exact-input conversion quote' })
  quote(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateConversionQuoteDto) {
    return this.convert.createQuote(user.id, dto);
  }

  @Post('execute')
  @ApiOperation({ summary: 'Reserve balance and execute a conversion idempotently' })
  execute(@CurrentUser() user: AuthenticatedUser, @Body() dto: ExecuteConversionDto) {
    return this.convert.execute(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List current user conversions' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.convert.list(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get current user conversion' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.convert.get(user.id, id);
  }
}
