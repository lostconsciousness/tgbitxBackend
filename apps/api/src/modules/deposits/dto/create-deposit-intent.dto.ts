import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateDepositIntentDto {
  @ApiProperty({ example: 'USDC' })
  @IsString()
  @MaxLength(16)
  assetSymbol!: string;

  @ApiProperty({ example: '100.25' })
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  amount!: string;

  @ApiProperty({ example: 'arbitrum' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  network?: string;

  @ApiProperty()
  @IsString()
  walletId!: string;
}
