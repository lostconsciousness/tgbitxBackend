import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class SubmitDepositIntentDto {
  @ApiProperty({ example: `0x${'a'.repeat(64)}` })
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{64}$/)
  txHash!: string;
}
