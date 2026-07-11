import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DepositAddressDto {
  @ApiProperty({ example: 'USDC' })
  @IsString()
  @MaxLength(16)
  assetSymbol!: string;

  @ApiProperty({ example: 'arbitrum', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  network?: string;
}
