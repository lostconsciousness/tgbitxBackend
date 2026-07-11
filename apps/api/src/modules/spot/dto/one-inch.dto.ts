import { IsOptional, IsString, Matches } from 'class-validator';

const ADDRESS_PATTERN = /^(0x[a-fA-F0-9]{40}|native)$/;

export class SpotQuoteDto {
  @IsString()
  @Matches(ADDRESS_PATTERN)
  fromTokenAddress!: string;

  @IsString()
  @Matches(ADDRESS_PATTERN)
  toTokenAddress!: string;

  @IsString()
  @Matches(/^\d+$/)
  amount!: string;
}

export class BuildSpotSwapDto extends SpotQuoteDto {
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{40}$/)
  walletAddress!: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  slippage?: string;
}
