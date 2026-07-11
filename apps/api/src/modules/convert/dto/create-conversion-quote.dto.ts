import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreateConversionQuoteDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString()
  @MaxLength(16)
  fromAsset!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString()
  @MaxLength(16)
  toAsset!: string;

  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  amount!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  slippageBps?: number;
}
