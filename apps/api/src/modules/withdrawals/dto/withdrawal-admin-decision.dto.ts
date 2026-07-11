import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class WithdrawalAdminDecisionDto {
  @ApiPropertyOptional({ example: 'Manual risk review passed' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
