import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Matches } from 'class-validator';

export class WalletNonceDto {
  @ApiProperty({ example: '0x0000000000000000000000000000000000000000' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(/^0x[a-fA-F0-9]{40}$/)
  address!: string;

  @ApiProperty({ example: 42161, required: false, default: 42161 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? value : Number(value)))
  @IsInt()
  chainId?: number;
}
