import { Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PositionsService } from './positions.service';
import { ListPositionsQueryDto, PositionHistoryQueryDto } from './dto/list-positions-query.dto';

@ApiTags('positions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('positions')
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List current user positions, optionally filtered by status' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPositionsQueryDto,
  ) {
    return this.positions.listUserPositions(user.id, { status: query.status });
  }

  @Get('history')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Cursor-paginated closed and liquidated position history' })
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PositionHistoryQueryDto,
  ) {
    return this.positions.listUserPositionHistory({
      userId: user.id,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(':id/liquidations')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List liquidation events for one owned position' })
  liquidations(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.positions.listPositionLiquidations(user.id, id);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Create a reduce-only market close order' })
  close(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.positions.closePosition(user.id, id);
  }
}
