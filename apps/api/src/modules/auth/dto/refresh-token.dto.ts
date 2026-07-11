import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ example: 'clxsessionid.random-refresh-secret' })
  @IsString()
  @MinLength(16)
  refreshToken!: string;
}
