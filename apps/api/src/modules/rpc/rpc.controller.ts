import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('rpc')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/rpc')
export class RpcController {
  @Get('status')
  @ApiOperation({ summary: 'RPC provider adapter status' })
  status() {
    return {
      provider: 'viem-http-json-rpc',
      network: 'arbitrum',
      configuredByEnv: ['ARBITRUM_RPC_PRIMARY_URL', 'ARBITRUM_RPC_FALLBACK_URL'],
    };
  }
}
