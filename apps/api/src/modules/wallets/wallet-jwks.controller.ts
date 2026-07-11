import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrivyWalletProvider } from './privy-wallet-provider.service';

@ApiTags('wallets')
@Controller('.well-known')
export class WalletJwksController {
  constructor(private readonly privyWalletProvider: PrivyWalletProvider) {}

  @Get('jwks.json')
  @ApiOperation({ summary: 'Public JWKS for Privy custom authentication' })
  jwks() {
    return this.privyWalletProvider.getJwks();
  }
}
