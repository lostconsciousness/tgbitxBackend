import { Type } from 'class-transformer';
import { PositionStatus } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListPositionsQueryDto {
  @IsOptional()
  @IsEnum(PositionStatus)
  status?: PositionStatus;
}

export class PositionHistoryQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}
