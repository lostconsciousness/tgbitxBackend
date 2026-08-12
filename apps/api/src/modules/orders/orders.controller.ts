import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a validated spot or isolated-margin perp order' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.orders.createOrder(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List current user orders' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.listUserOrders(user.id);
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Get spot/perpetual execution readiness for the trading UI' })
  readiness() {
    return this.orders.getExecutionReadiness();
  }

  @Get('execution-readiness')
  @ApiOperation({ summary: 'Get spot/perpetual execution readiness for the trading UI' })
  executionReadiness() {
    return this.orders.getExecutionReadiness();
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel an open provider order' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.orders.cancelOrder(user.id, id);
  }
}
