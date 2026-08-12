import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, formatEther, getAddress, http, parseEther } from 'viem';
import { arbitrum } from 'viem/chains';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/modules/audit/audit.service';
import { PrivyCustodyService } from '../src/modules/treasury/privy-custody.service';

const CHAIN_ID = 42161;

async function main(): Promise<void> {
  const targetArg = process.argv.find((value) => value.startsWith('--target='))?.split('=')[1];
  if (!targetArg || !/^0\.\d{1,18}$/.test(targetArg)) {
    throw new Error('Usage: npm run hyperliquid:fund-master-gas -- --target=0.001');
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const config = app.get(ConfigService);
    const custody = app.get(PrivyCustodyService);
    const audit = app.get(AuditService);
    if (
      !config.get<boolean>('MAINNET_ENABLED', false) ||
      config.get<boolean>('HYPERLIQUID_TESTNET', true)
    ) {
      throw new Error('Hyperliquid master gas funding requires explicit mainnet flags');
    }

    const masterWalletId = config.getOrThrow<string>('PRIVY_HYPERLIQUID_MASTER_WALLET_ID');
    const master = getAddress(config.getOrThrow<string>('HYPERLIQUID_MASTER_ADDRESS'));
    const sweepWalletId = config.getOrThrow<string>('PRIVY_SWEEP_GAS_WALLET_ID');
    const sweepGas = getAddress(config.getOrThrow<string>('SWEEP_GAS_ADDRESS'));
    const [privyMaster, privySweepGas] = await Promise.all([
      custody.getWalletAddress(masterWalletId),
      custody.getWalletAddress(sweepWalletId),
    ]);
    if (getAddress(privyMaster) !== master) {
      throw new Error('Privy Hyperliquid master wallet/address mismatch');
    }
    if (getAddress(privySweepGas) !== sweepGas) {
      throw new Error('Privy SWEEP_GAS wallet/address mismatch');
    }

    const target = parseEther(targetArg);
    const maxTopup = BigInt(config.getOrThrow<string>('SWEEP_GAS_MAX_TOPUP_WEI'));
    if (target > maxTopup) {
      throw new Error(
        `Target ${targetArg} ETH exceeds SWEEP_GAS_MAX_TOPUP_WEI (${formatEther(maxTopup)} ETH)`,
      );
    }

    const rpcUrl = config.get<string>('ARBITRUM_RPC_PRIMARY_URL') ??
      config.get<string>('ARBITRUM_RPC_URL') ??
      'https://arb1.arbitrum.io/rpc';
    const client = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) });
    const [masterBefore, sweepBefore] = await Promise.all([
      client.getBalance({ address: master }),
      client.getBalance({ address: sweepGas }),
    ]);
    if (masterBefore >= target) {
      console.log(JSON.stringify({
        alreadyFunded: true,
        master,
        masterEth: formatEther(masterBefore),
        targetEth: targetArg,
      }, null, 2));
      return;
    }

    const topup = target - masterBefore;
    if (topup > maxTopup || sweepBefore <= topup) {
      throw new Error('SWEEP_GAS balance or configured per-transfer limit is insufficient');
    }
    const referenceId = `hl-master-gas:${CHAIN_ID}:${target}`;
    const sent = await custody.sendNativeFromSweepGas({
      recipient: master,
      value: topup,
      referenceId,
      chainId: CHAIN_ID,
    });
    const receipt = await client.waitForTransactionReceipt({ hash: sent.txHash as `0x${string}` });
    if (receipt.status !== 'success') {
      throw new Error(`Hyperliquid master gas funding reverted: ${sent.txHash}`);
    }
    const masterAfter = await client.getBalance({ address: master });
    await audit.record({
      action: 'HYPERLIQUID_MASTER_GAS_FUNDED',
      entityType: 'CustodyAccount',
      entityId: masterWalletId,
      metadata: {
        chainId: CHAIN_ID,
        from: sweepGas,
        to: master,
        valueWei: topup.toString(),
        txHash: sent.txHash,
        referenceId,
      },
    });
    console.log(JSON.stringify({
      alreadyFunded: false,
      txHash: sent.txHash,
      transferredEth: formatEther(topup),
      masterEthBefore: formatEther(masterBefore),
      masterEthAfter: formatEther(masterAfter),
      sweepGasEthBefore: formatEther(sweepBefore),
    }, null, 2));
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Hyperliquid master gas funding failed');
  process.exitCode = 1;
});
