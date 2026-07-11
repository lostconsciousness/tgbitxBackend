import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TokenStandard } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

export class UpsertTokenContractDto {
  @ApiProperty({ example: 'base-sepolia' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @MaxLength(64)
  network!: string;

  @ApiPropertyOptional({ enum: TokenStandard, default: TokenStandard.ERC20 })
  @IsOptional()
  @IsEnum(TokenStandard)
  standard?: TokenStandard;

  @ApiPropertyOptional({ example: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' })
  @IsOptional()
  @Matches(/^0x[a-fA-F0-9]{40}$/)
  tokenAddress?: string;

  @ApiProperty({ example: 6 })
  @IsInt()
  @Min(0)
  decimals!: number;

  @ApiPropertyOptional({ example: '0' })
  @IsOptional()
  @IsString()
  withdrawalFeeAmount?: string;

  @ApiPropertyOptional({ example: '0.000001' })
  @IsOptional()
  @IsString()
  minWithdrawalAmount?: string;
}
