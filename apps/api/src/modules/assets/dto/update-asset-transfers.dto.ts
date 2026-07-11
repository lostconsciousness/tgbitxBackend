import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateAssetTransfersDto {
  @ApiProperty()
  @IsBoolean()
  depositEnabled!: boolean;

  @ApiProperty()
  @IsBoolean()
  withdrawalEnabled!: boolean;
}
