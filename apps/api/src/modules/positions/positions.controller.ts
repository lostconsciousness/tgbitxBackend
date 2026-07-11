import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PositionsService } from './positions.service';

@ApiTags('positions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('positions')
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @Get()
  @ApiOperation({ summary: 'List current user isolated-margin positions' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.positions.listUserPositions(user.id);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Create a reduce-only market close order' })
  close(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.positions.closePosition(user.id, id);
  }
}
