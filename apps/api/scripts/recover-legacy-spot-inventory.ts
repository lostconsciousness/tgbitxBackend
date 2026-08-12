import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { LedgerAccountType, TokenStandard } from '@prisma/client';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { LedgerModule } from '../src/modules/ledger/ledger.module';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { RPC_PROVIDER, RpcModule } from '../src/modules/rpc/rpc.module';
import { RpcProvider } from '../src/modules/rpc/rpc-provider.interface';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';
import { TreasuryModule } from '../src/modules/treasury/treasury.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['apps/api/.env', '.env', '../../.env'],
      isGlobal: true,
    }),
    DatabaseModule,
    LedgerModule,
    RpcModule,
    TreasuryModule,
  ],
})
class RecoverLegacySpotInventoryModule {}

const apply = process.argv.includes('--apply');
const symbols = readSymbols();

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    RecoverLegacySpotInventoryModule,
    { logger: ['error', 'warn'] },
  );
  try {
    const config = app.get(ConfigService);
    const prisma = app.get(PrismaService);
    const ledger = app.get(LedgerService);
    const custody = app.get(PrivyCustodyService);
    const rpc = app.get<RpcProvider>(RPC_PROVIDER);
    const sourceWalletId = config.getOrThrow<string>('PRIVY_SERVER_WALLET_ID');
    const destinationWalletId = config.getOrThrow<string>('PRIVY_SPOT_LIQUIDITY_WALLET_ID');
    const [sourceAddress, destinationAddress] = await Promise.all([
      custody.getWalletAddress(sourceWalletId),
      custody.getWalletAddress(destinationWalletId),
    ]);
    if (getAddress(sourceAddress) === getAddress(destinationAddress)) {
      throw new Error('Legacy source and Spot liquidity wallets must differ');
    }

    const networkKeys = (config.get<string>('CONVERT_EVM_NETWORKS', '') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const assets = await prisma.asset.findMany({
      where: { symbol: { in: symbols } },
      include: {
        tokenContracts: {
          where: {
            standard: TokenStandard.ERC20,
            address: { not: null },
            contractVerifiedAt: { not: null },
            network: { mainnet: true, chainKey: { in: networkKeys } },
          },
          include: { network: true },
        },
      },
      orderBy: { symbol: 'asc' },
    });
    const report: Array<Record<string, unknown>> = [];

    for (const asset of assets) {
      const liability = await ledger.getTotalAccountTypeBalance({
        assetId: asset.id,
        accountType: LedgerAccountType.USER_SPOT,
      });
      if (liability.lessThanOrEqualTo(0)) {
        report.push({ symbol: asset.symbol, status: 'NO_USER_LIABILITY' });
        continue;
      }

      let recovered = false;
      for (const contract of asset.tokenContracts) {
        if (!contract.address || !contract.network.chainId) continue;
        const [source, destination] = await Promise.all([
          rpc.getBalance(sourceAddress, contract.address, contract.network.chainKey, contract.decimals),
          rpc.getBalance(destinationAddress, contract.address, contract.network.chainKey, contract.decimals),
        ]);
        const sourceRaw = parseUnits(source.value, contract.decimals);
        const destinationRaw = parseUnits(destination.value, contract.decimals);
        const liabilityRaw = parseUnits(liability.toFixed(contract.decimals), contract.decimals);
        const deficitRaw = liabilityRaw > destinationRaw ? liabilityRaw - destinationRaw : 0n;
        if (deficitRaw === 0n) {
          report.push({
            symbol: asset.symbol,
            network: contract.network.chainKey,
            status: 'ALREADY_COVERED',
            liability: liability.toString(),
            destinationBalance: destination.value,
          });
          recovered = true;
          break;
        }
        if (sourceRaw < deficitRaw) continue;

        const amount = formatUnits(deficitRaw, contract.decimals);
        if (!apply) {
          report.push({
            symbol: asset.symbol,
            network: contract.network.chainKey,
            status: 'DRY_RUN_TRANSFER_REQUIRED',
            amount,
            sourceBalance: source.value,
            destinationBalance: destination.value,
          });
          recovered = true;
          break;
        }
        const sent = await custody.sendErc20FromWallet({
          walletId: sourceWalletId,
          tokenAddress: getAddress(contract.address),
          recipient: getAddress(destinationAddress),
          rawAmount: deficitRaw,
          chainId: contract.network.chainId,
          referenceId: `spot-legacy-inventory-v1:${contract.network.chainKey}:${asset.symbol}`,
        });
        const receipt = await waitForReceipt(rpc, sent.txHash, contract.network.chainKey);
        if (!receipt.from || getAddress(receipt.from) !== getAddress(sourceAddress)) {
          throw new Error(`${asset.symbol} recovery was signed by an unexpected wallet`);
        }
        const after = await rpc.getBalance(
          destinationAddress,
          contract.address,
          contract.network.chainKey,
          contract.decimals,
        );
        if (parseUnits(after.value, contract.decimals) < liabilityRaw) {
          throw new Error(`${asset.symbol} Spot inventory remains below the user liability`);
        }
        report.push({
          symbol: asset.symbol,
          network: contract.network.chainKey,
          status: 'TRANSFERRED',
          amount,
          txHash: sent.txHash,
          destinationBalance: after.value,
        });
        recovered = true;
        break;
      }
      if (!recovered) {
        report.push({
          symbol: asset.symbol,
          status: 'LEGACY_SOURCE_INSUFFICIENT',
          liability: liability.toString(),
        });
      }
    }
    process.stdout.write(`${JSON.stringify({ apply, symbols, report }, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

async function waitForReceipt(rpc: RpcProvider, txHash: string, networkKey: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const transaction = await rpc.getTransaction(txHash, networkKey);
      if (transaction.status === 1) return transaction;
      if (transaction.status === 0) throw new Error('Legacy inventory transfer reverted');
    } catch (error) {
      if (error instanceof Error && /reverted/i.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Legacy inventory transfer is still pending');
}

function readSymbols(): string[] {
  const inline = process.argv.find((value) => value.startsWith('--symbols='));
  const raw = inline?.slice('--symbols='.length) ?? 'AAVE,ARB';
  const values = [...new Set(raw.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean))];
  if (values.length === 0) throw new Error('--symbols must contain at least one asset');
  return values;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
