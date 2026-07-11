import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CustodyAccountRole, UserRole } from '@prisma/client';
import { IsEnum, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { TreasuryService } from './treasury.service';

class ProposeTreasuryTransferDto {
  @IsEnum(CustodyAccountRole)
  sourceRole!: CustodyAccountRole;

  @IsEnum(CustodyAccountRole)
  destinationRole!: CustodyAccountRole;

  @IsString()
  @MaxLength(16)
  assetSymbol!: string;

  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  amount!: string;

  @IsString()
  @MaxLength(500)
  reason!: string;
}

@ApiTags('treasury')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/treasury')
export class TreasuryController {
  constructor(private readonly treasuryService: TreasuryService) {}

  @Get('accounts')
  @ApiOperation({ summary: 'List public custody account metadata' })
  accounts() {
    return this.treasuryService.listAccounts();
  }

  @Post('snapshots')
  @ApiOperation({ summary: 'Capture current ERC20 custody balances' })
  snapshots() {
    return this.treasuryService.captureBalances();
  }

  @Get('operational-status')
  @ApiOperation({ summary: 'Show deposit provisioning, sweep and gas-wallet status' })
  operationalStatus() {
    return this.treasuryService.getOperationalStatus();
  }

  @Post('transfers')
  @ApiOperation({ summary: 'Propose a treasury rebalance requiring approval' })
  propose(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ProposeTreasuryTransferDto,
  ) {
    return this.treasuryService.proposeTransfer({
      ...dto,
      proposedByUserId: user.id,
    });
  }

  @Post('transfers/:id/approve')
  @ApiOperation({ summary: 'Approve a proposed treasury transfer' })
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.treasuryService.approveTransfer(id, user.id);
  }
}
