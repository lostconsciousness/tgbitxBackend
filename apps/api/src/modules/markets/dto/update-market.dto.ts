import { ApiPropertyOptional } from '@nestjs/swagger';
import { MarketStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateMarketDto {
  @ApiPropertyOptional({ enum: MarketStatus })
  @IsOptional()
  @IsEnum(MarketStatus)
  status?: MarketStatus;

  @ApiPropertyOptional({ example: 'HYPERLIQUID' })
  @IsOptional()
  @IsString()
  providerName?: string;

  @ApiPropertyOptional({ example: 'BTC' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  providerSymbol?: string;

  @ApiPropertyOptional({ example: 'HYPERLIQUID:BTCUSDC' })
  @IsOptional()
  @IsString()
  tradingViewSymbol?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  orderbookEnabled?: boolean;
}
