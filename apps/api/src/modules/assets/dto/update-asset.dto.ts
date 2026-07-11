import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateAssetDto {
  @ApiPropertyOptional({ example: 'https://assets.coingecko.com/coins/images/6319/large/usdc.png' })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  iconUrl?: string;

  @ApiPropertyOptional({ example: '1.5' })
  @IsOptional()
  @IsString()
  withdrawalFeeAmount?: string;

  @ApiPropertyOptional({ example: '10' })
  @IsOptional()
  @IsString()
  minWithdrawalAmount?: string;
}
