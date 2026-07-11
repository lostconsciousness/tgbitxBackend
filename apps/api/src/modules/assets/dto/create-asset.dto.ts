import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetType, Chain } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUrl, Matches, Min } from 'class-validator';

export class CreateAssetDto {
  @ApiProperty({ example: 'USDC' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  symbol!: string;

  @ApiProperty({ example: 'USD Coin' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: 'https://assets.coingecko.com/coins/images/6319/large/usdc.png' })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  iconUrl?: string;

  @ApiProperty({ enum: AssetType })
  @IsEnum(AssetType)
  type!: AssetType;

  @ApiPropertyOptional({ enum: Chain, default: Chain.ARBITRUM })
  @IsOptional()
  @IsEnum(Chain)
  chain?: Chain;

  @ApiPropertyOptional({ example: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' })
  @IsOptional()
  @Matches(/^0x[a-fA-F0-9]{40}$/)
  tokenAddress?: string;

  @ApiProperty({ example: 6 })
  @IsInt()
  @Min(0)
  decimals!: number;

  @ApiPropertyOptional({ default: false, deprecated: true })
  @IsOptional()
  @IsBoolean()
  depositEnabled?: boolean;

  @ApiPropertyOptional({ default: false, deprecated: true })
  @IsOptional()
  @IsBoolean()
  withdrawalEnabled?: boolean;

  @ApiPropertyOptional({ example: '1.5' })
  @IsOptional()
  @IsString()
  withdrawalFeeAmount?: string;

  @ApiPropertyOptional({ example: '10' })
  @IsOptional()
  @IsString()
  minWithdrawalAmount?: string;
}
