import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MarketStatus, MarketType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateMarketDto {
  @ApiProperty({ example: 'ETH-USDC' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  symbol!: string;

  @ApiProperty({ enum: MarketType })
  @IsEnum(MarketType)
  type!: MarketType;

  @ApiProperty({ example: 'ETH' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  baseAssetSymbol!: string;

  @ApiProperty({ example: 'USDC' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  quoteAssetSymbol!: string;

  @ApiPropertyOptional({ enum: MarketStatus, default: MarketStatus.ACTIVE })
  @IsOptional()
  @IsEnum(MarketStatus)
  status?: MarketStatus;

  @ApiPropertyOptional({ example: 'HYPERLIQUID' })
  @IsOptional()
  @IsString()
  providerName?: string;

  @ApiPropertyOptional({ example: 'ETH' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  providerSymbol?: string;

  @ApiPropertyOptional({ example: 'HYPERLIQUID:ETHUSDC' })
  @IsOptional()
  @IsString()
  tradingViewSymbol?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  orderbookEnabled?: boolean;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(0)
  pricePrecision!: number;

  @ApiProperty({ example: 6 })
  @IsInt()
  @Min(0)
  sizePrecision!: number;

  @ApiPropertyOptional({ example: '0.001' })
  @IsOptional()
  @IsString()
  minOrderSize?: string;
}
