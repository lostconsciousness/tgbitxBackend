import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MinLength } from 'class-validator';

export class ConnectWalletDto {
  @ApiProperty({ example: '0x0000000000000000000000000000000000000000' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(/^0x[a-fA-F0-9]{40}$/)
  address!: string;

  @ApiProperty()
  @IsString()
  @MinLength(16)
  nonce!: string;

  @ApiProperty()
  @IsString()
  @MinLength(32)
  signature!: string;
}
