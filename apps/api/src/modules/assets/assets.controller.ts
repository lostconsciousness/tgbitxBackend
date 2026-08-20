import { Body, Controller, Get, Header, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { getRequestMetadata } from '../../common/utils/request-metadata';
import { AuditService } from '../audit/audit.service';
import { AssetsService } from './assets.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { UpdateAssetTransfersDto } from './dto/update-asset-transfers.dto';
import { UpsertTokenContractDto } from './dto/upsert-token-contract.dto';
import { Request } from 'express';
import { BulkEnableAssetTransfersDto, BulkVerifyAssetsDto } from './dto/bulk-assets.dto';

@ApiTags('assets')
@Controller()
export class AssetsController {
  constructor(
    private readonly assetsService: AssetsService,
    private readonly auditService: AuditService,
  ) {}

  @Get('assets')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'List configured assets' })
  list() {
    return this.assetsService.list();
  }

  @Get('assets/:symbol')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  @ApiOperation({ summary: 'Get asset by symbol' })
  get(@Param('symbol') symbol: string) {
    return this.assetsService.getPublicBySymbol(symbol);
  }

  @Post('admin/assets')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create asset configuration' })
  @ApiOkResponse({ description: 'Created asset' })
  async createAdmin(
    @Body() dto: CreateAssetDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const asset = await this.assetsService.create(dto);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'ASSET_CREATE',
      entityType: 'Asset',
      entityId: asset.id,
      metadata: { symbol: asset.symbol },
      ...getRequestMetadata(request),
    });
    return asset;
  }

  @Patch('admin/assets/:symbol')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update asset risk/configuration flags' })
  async updateAdmin(
    @Param('symbol') symbol: string,
    @Body() dto: UpdateAssetDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const asset = await this.assetsService.update(symbol, dto);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'ASSET_UPDATE',
      entityType: 'Asset',
      entityId: asset.id,
      metadata: { symbol: asset.symbol },
      ...getRequestMetadata(request),
    });
    return asset;
  }

  @Post('admin/assets/:symbol/contracts')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Add or update a network-specific token contract' })
  async upsertTokenContract(
    @Param('symbol') symbol: string,
    @Body() dto: UpsertTokenContractDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const asset = await this.assetsService.upsertTokenContract(symbol, dto);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'ASSET_TOKEN_CONTRACT_UPSERT',
      entityType: 'Asset',
      entityId: asset.id,
      metadata: {
        symbol: asset.symbol,
        network: dto.network,
        standard: dto.standard ?? 'ERC20',
        tokenAddress: dto.tokenAddress,
      },
      ...getRequestMetadata(request),
    });
    return asset;
  }

  @Post('admin/assets/:symbol/verify-contract')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Verify ERC20 bytecode and metadata on the configured chain' })
  async verifyContract(
    @Param('symbol') symbol: string,
    @Query('network') network: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const asset = await this.assetsService.verifyContract(symbol, network);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'ASSET_CONTRACT_VERIFY',
      entityType: 'Asset',
      entityId: asset.id,
      metadata: {
        symbol: asset.symbol,
        network,
        chainId: asset.verifiedChainId,
        codeHash: asset.contractCodeHash,
      },
      ...getRequestMetadata(request),
    });
    return asset;
  }

  @Post('admin/assets/bulk-verify')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Bulk verify testnet native assets and ERC20 contracts' })
  async bulkVerify(
    @Body() dto: BulkVerifyAssetsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const result = await this.assetsService.bulkVerify(dto);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'ASSET_BULK_VERIFY',
      entityType: 'Asset',
      metadata: {
        scope: result.scope,
        dryRun: result.dryRun,
        summary: result.summary,
      },
      ...getRequestMetadata(request),
    });
    return result;
  }

  @Post('admin/assets/bulk-enable-transfers')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Bulk enable testnet deposits and withdrawals for verified assets' })
  async bulkEnableTransfers(
    @Body() dto: BulkEnableAssetTransfersDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const result = await this.assetsService.bulkEnableTransfers(dto);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'ASSET_BULK_ENABLE_TRANSFERS',
      entityType: 'Asset',
      metadata: {
        scope: result.scope,
        dryRun: result.dryRun,
        deposits: result.deposits,
        withdrawals: result.withdrawals,
        summary: result.summary,
      },
      ...getRequestMetadata(request),
    });
    return result;
  }

  @Patch('admin/assets/:symbol/transfers')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Enable or disable deposits and withdrawals for a verified asset' })
  async updateTransfers(
    @Param('symbol') symbol: string,
    @Query('network') network: string | undefined,
    @Body() dto: UpdateAssetTransfersDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const asset = await this.assetsService.updateTransfers(symbol, dto, network);
    await this.auditService.record({
      actorUserId: user.id,
      action: 'ASSET_TRANSFERS_UPDATE',
      entityType: 'Asset',
      entityId: asset.id,
      metadata: {
        symbol: asset.symbol,
        network,
        depositEnabled: asset.depositEnabled,
        withdrawalEnabled: asset.withdrawalEnabled,
      },
      ...getRequestMetadata(request),
    });
    return asset;
  }
}
