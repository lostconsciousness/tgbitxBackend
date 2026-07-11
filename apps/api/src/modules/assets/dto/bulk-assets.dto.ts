import { ApiPropertyOptional } from '@nestjs/swagger';
import { TokenStandard } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';

export class BulkAssetBaseDto {
  @ApiPropertyOptional({ example: 'testnet' })
  @IsOptional()
  @IsString()
  scope?: string;

  @ApiPropertyOptional({ example: ['base-sepolia', 'polygon-amoy'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  networks?: string[];

  @ApiPropertyOptional({ example: ['ETH', 'USDC'] })
  @IsOptional()
  @IsArray()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim().toUpperCase() : item))
      : value,
  )
  @IsString({ each: true })
  assetSymbols?: string[];

  @ApiPropertyOptional({ enum: TokenStandard, isArray: true, example: ['NATIVE', 'ERC20'] })
  @IsOptional()
  @IsArray()
  @IsEnum(TokenStandard, { each: true })
  standards?: TokenStandard[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class BulkVerifyAssetsDto extends BulkAssetBaseDto {}

export class BulkEnableAssetTransfersDto extends BulkAssetBaseDto {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  deposits?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  withdrawals?: boolean;
}
