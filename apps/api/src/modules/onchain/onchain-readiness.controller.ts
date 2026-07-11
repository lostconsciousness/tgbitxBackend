import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { OnchainReadinessService } from './onchain-readiness.service';
import { NetworkAdaptersService } from './network-adapters.service';
import { PrismaService } from '../../database/prisma.service';

@ApiTags('onchain')
@Controller('admin/onchain')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class OnchainReadinessController {
  constructor(
    private readonly readiness: OnchainReadinessService,
    private readonly adapters: NetworkAdaptersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('readiness/networks')
  @ApiOperation({ summary: 'Report safe on-chain readiness for every enabled EVM network' })
  getAllReadiness() {
    return this.readiness.getAllReadiness();
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Report safe on-chain testnet readiness without exposing secrets' })
  getReadiness(@Query('network') network?: string) {
    return this.readiness.getReadiness(network);
  }

  @Get('adapters')
  @ApiOperation({ summary: 'Report deposit/withdrawal adapter implementation status for every network' })
  async getAdapterStatus() {
    const networks = await this.prisma.network.findMany({ orderBy: { chainKey: 'asc' } });
    return {
      networks: networks.map((network) => ({
        network: network.chainKey,
        displayName: network.displayName,
        family: network.family,
        mainnet: network.mainnet,
        depositEnabled: network.depositEnabled,
        withdrawalEnabled: network.withdrawalEnabled,
        adapter: this.adapters.getStatus(network.family),
      })),
    };
  }
}
