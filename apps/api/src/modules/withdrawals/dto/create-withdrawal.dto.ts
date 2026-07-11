import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateWithdrawalDto {
  @ApiProperty({ example: 'USDC' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  assetSymbol!: string;

  @ApiProperty({ example: 'solana-devnet', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  network?: string;

  @ApiProperty({
    example: '8EQ3FXEbDgMDaq3eTRAN18ojVZczWzhPKVtzLv1aHtWV',
    description: 'Destination address in the selected network format (EVM, Solana, TRON, etc.)',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  toAddress!: string;

  @ApiProperty({ example: '100.25' })
  @IsString()
  amount!: string;
}
