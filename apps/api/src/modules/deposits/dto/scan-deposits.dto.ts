import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ScanDepositsDto {
  @ApiProperty({ example: 'USDC' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  assetSymbol!: string;

  @ApiPropertyOptional({ example: 'arbitrum' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  network?: string;

  @ApiProperty({ example: 123456789 })
  @IsInt()
  @Min(0)
  fromBlock!: number;

  @ApiPropertyOptional({ example: 123456999 })
  @IsOptional()
  @IsInt()
  @Min(0)
  toBlock?: number;
}
