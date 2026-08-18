import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { getRequestMetadata } from '../../common/utils/request-metadata';
import { ConnectWalletDto } from './dto/connect-wallet.dto';
import { WalletNonceDto } from './dto/wallet-nonce.dto';
import { PrivyWalletProvider } from './privy-wallet-provider.service';
import { WalletsService } from './wallets.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { Chain, NetworkFamily, WalletStatus } from '@prisma/client';
import { AccountService } from '../account/account.service';
import { Optional } from '@nestjs/common';
import { UserUpdatesService } from '../user-updates/user-updates.service';

@ApiTags('wallets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
    private readonly privyWalletProvider: PrivyWalletProvider,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly accountService: AccountService,
    @Optional() private readonly userUpdates?: UserUpdatesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List current user wallets' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.walletsService.listUserWallets(user.id);
  }

  @Get('balances')
  @ApiOperation({
    summary: 'List on-chain balances for all connected wallets grouped by wallet and network',
  })
  balances(@CurrentUser() user: AuthenticatedUser) {
    return this.accountService.getConnectedWalletBalancesForUser(user.id);
  }

  @Get('capabilities')
  @ApiOperation({ summary: 'Get enabled wallet connection modes' })
  async capabilities() {
    const [networks, siwe] = await Promise.all([
      this.prisma.network.findMany({
        where: { family: { in: [NetworkFamily.EVM, NetworkFamily.SVM, NetworkFamily.TVM] } },
        orderBy: { chainKey: 'asc' },
      }),
      this.walletsService.getExternalWalletCapabilities(),
    ]);
    return {
      chain: siwe.chain,
      siweChains: siwe.siweChains,
      networks: networks.map((network) => ({
        network: network.chainKey,
        displayName: network.displayName,
        caip2: network.caip2,
        chainId: network.chainId,
        family: network.family,
        depositEnabled: network.depositEnabled,
        withdrawalEnabled: network.withdrawalEnabled,
        mainnet: network.mainnet,
      })),
      external: {
        enabled: true,
        provider: 'SIWE',
        families: [NetworkFamily.EVM],
      },
      embedded: {
        enabled: this.privyWalletProvider.isEnabled(),
        provider: 'PRIVY',
        families: [NetworkFamily.EVM, NetworkFamily.SVM, NetworkFamily.TVM],
      },
    };
  }

  @Post('siwe/nonce')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create an EIP-4361 message for external wallet connection' })
  nonce(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WalletNonceDto,
    @Req() request: Request,
  ) {
    return this.walletsService.createSiweNonce({
      userId: user.id,
      address: dto.address,
      chainId: dto.chainId,
      origin: request.get('origin'),
    });
  }

  @Post('connect')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Connect an external wallet by verifying its SIWE signature' })
  async connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConnectWalletDto,
    @Req() request: Request,
  ) {
    const wallet = await this.walletsService.connectWallet({
      userId: user.id,
      address: dto.address,
      nonce: dto.nonce,
      signature: dto.signature,
      audit: getRequestMetadata(request),
    });
    this.userUpdates?.publish(user.id, ['wallets']);
    return wallet;
  }

  @Post('embedded/session')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Issue a short-lived Privy custom-auth token' })
  embeddedSession(@CurrentUser() user: AuthenticatedUser) {
    return this.privyWalletProvider.createSession({
      id: user.id,
      email: user.email,
    });
  }

  @Post('embedded/sync')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sync the current user embedded wallet from Privy' })
  async syncEmbedded(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const providerWallets = await this.privyWalletProvider.getEmbeddedWallets(user.id);
    const wallets: Array<Awaited<ReturnType<WalletsService['syncEmbeddedWallet']>>> = [];
    for (const providerWallet of providerWallets) {
      const chain = providerWallet.chainType === 'solana'
        ? Chain.SOLANA
        : providerWallet.chainType === 'tron'
          ? Chain.TRON
          : undefined;
      const wallet = await this.walletsService.syncEmbeddedWallet({
        userId: user.id,
        ...providerWallet,
        chain,
        audit: getRequestMetadata(request),
      });
      if (wallet.status === WalletStatus.ACTIVE) {
        wallets.push(wallet);
      }
    }
    const primary = wallets.find((wallet) => wallet.isPrimary) ?? wallets[0];
    this.userUpdates?.publish(user.id, ['wallets']);
    return primary ? { ...primary, wallets } : { wallets };
  }

  @Patch(':id/primary')
  @ApiOperation({ summary: 'Set an active wallet as primary' })
  async setPrimary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') walletId: string,
    @Req() request: Request,
  ) {
    const wallet = await this.walletsService.setPrimaryWallet(
      user.id,
      walletId,
      getRequestMetadata(request),
    );
    this.userUpdates?.publish(user.id, ['wallets']);
    return wallet;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke a wallet connection' })
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') walletId: string,
    @Req() request: Request,
  ) {
    const wallet = await this.walletsService.revokeWallet(
      user.id,
      walletId,
      getRequestMetadata(request),
    );
    this.userUpdates?.publish(user.id, ['wallets']);
    return wallet;
  }
}
