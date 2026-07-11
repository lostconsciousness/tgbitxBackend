import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderSide, OrderType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateOrderDto {
  @ApiProperty({ example: 'BTC-PERP' })
  @IsString()
  @MaxLength(32)
  symbol!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  clientOrderId!: string;

  @ApiProperty({ enum: OrderSide })
  @IsEnum(OrderSide)
  side!: OrderSide;

  @ApiProperty({ enum: OrderType })
  @IsEnum(OrderType)
  type!: OrderType;

  @ApiProperty({ example: '0.001' })
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  size!: string;

  @ApiPropertyOptional({ example: '65000' })
  @IsOptional()
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  price?: string;

  @ApiPropertyOptional({ example: '62000' })
  @IsOptional()
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  triggerPrice?: string;

  @ApiPropertyOptional({ example: 5, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  leverage?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  reduceOnly?: boolean;
}
