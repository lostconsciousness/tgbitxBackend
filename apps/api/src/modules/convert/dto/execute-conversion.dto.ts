import { IsString, MaxLength, MinLength } from 'class-validator';

export class ExecuteConversionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  quoteId!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  clientConversionId!: string;
}
