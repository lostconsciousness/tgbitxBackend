import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createECDH, createPrivateKey } from 'crypto';
import {
  Chain,
  CustodyAccountRole,
  CustodyAccountStatus,
  NetworkFamily,
  TokenStandard,
} from '@prisma/client';
import { getAddress, keccak256 } from 'viem';
import { PrismaService } from '../../database/prisma.service';
import { RPC_PROVIDER } from '../rpc/rpc.module';
import { RpcProvider } from '../rpc/rpc-provider.interface';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ARBITRUM_MAINNET_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';

type ReadinessSnapshot = Awaited<ReturnType<OnchainReadinessService['computeReadiness']>>;

@Injectable()
export class OnchainReadinessService {
  private readonly readinessCache = new Map<
    string,
    { expiresAt: number; value: ReadinessSnapshot }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(RPC_PROVIDER) private readonly rpcProvider: RpcProvider,
  ) {}

  async getReadiness(networkKey?: string) {
    const cacheKey = networkKey?.trim().toLowerCase() || '__default__';
    const ttl = this.config.get<number>('ONCHAIN_READINESS_CACHE_MS', 60_000);
    if (ttl > 0) {
      const cached = this.readinessCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
    }

    const value = await this.computeReadiness(networkKey);
    if (ttl > 0) {
      this.readinessCache.set(cacheKey, { expiresAt: Date.now() + ttl, value });
    }
    return value;
  }

  private async computeReadiness(networkKey?: string) {
    const networkConfig = await this.resolveNetworkConfig(networkKey);
    const configuredChainId =
      networkConfig?.chainId ?? this.config.get<number>('ONCHAIN_CHAIN_ID', 421614);
    const expectedNetwork =
      networkConfig?.legacyChain ??
      (configuredChainId === 421614 ? Chain.ARBITRUM_SEPOLIA : Chain.ARBITRUM);
    const issues: string[] = [];
    let rpcChainId: number | null = null;
    const authorizationPrivateKeyConfigured = Boolean(
      this.config.get<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64'),
    );
    const authorizationPrivateKey =
      this.config.get<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64') ?? '';
    const authorizationPublicKeyConfigured = Boolean(
      this.config.get<string>('PRIVY_AUTHORIZATION_PUBLIC_KEY'),
    );
    const authorizationPrivateKeyValid =
      !authorizationPrivateKeyConfigured || this.hasValidAuthorizationPrivateKey();
    const authorizationPublicKeyReady =
      authorizationPrivateKeyValid || authorizationPublicKeyConfigured;

    try {
      rpcChainId = await this.rpcProvider.getChainId(networkConfig?.chainKey);
      if (rpcChainId !== configuredChainId) {
        issues.push(`RPC_CHAIN_MISMATCH:${rpcChainId}`);
      }
    } catch (_error) {
      issues.push('RPC_UNAVAILABLE');
    }

    if (
      networkConfig?.mainnet &&
      !this.config.get<boolean>('MAINNET_ENABLED', false)
    ) {
      issues.push('MAINNET_ENABLED_REQUIRED');
    }
    if (!networkConfig && configuredChainId !== 421614) {
      issues.push('TESTNET_CHAIN_REQUIRED');
    }
    if (networkConfig && networkConfig.family !== NetworkFamily.EVM) {
      issues.push(`UNSUPPORTED_NETWORK_FAMILY:${networkConfig.family}`);
    }
    if (networkConfig && !networkConfig.legacyChain) {
      issues.push('NETWORK_LEGACY_CHAIN_MISSING');
    }
    if (networkConfig && !networkConfig.chainId) {
      issues.push('NETWORK_CHAIN_ID_MISSING');
    }

    const custodyAccounts = await this.prisma.custodyAccount.findMany({
      where: {
        network: expectedNetwork,
        status: CustodyAccountStatus.ACTIVE,
        role: {
          in: [
            CustodyAccountRole.DEPOSIT_TREASURY,
            CustodyAccountRole.WITHDRAWAL_HOT,
            CustodyAccountRole.SWEEP_GAS,
          ],
        },
      },
      select: {
        role: true,
        address: true,
        providerWalletRef: true,
        policyRef: true,
        status: true,
      },
    });
    const custody = custodyAccounts.map((account) => ({
      ...account,
      address: getAddress(account.address),
      configured: account.address.toLowerCase() !== ZERO_ADDRESS,
    }));
    for (const role of [
      CustodyAccountRole.DEPOSIT_TREASURY,
      CustodyAccountRole.WITHDRAWAL_HOT,
    ]) {
      if (!custody.find((account) => account.role === role && account.configured)) {
        issues.push(`MISSING_CUSTODY_${role}`);
      }
    }

    const contracts = await this.prisma.tokenContract.findMany({
      where: {
        OR: [{ depositEnabled: true }, { withdrawalEnabled: true }],
        standard: { in: [TokenStandard.NATIVE, TokenStandard.ERC20] },
        ...(networkConfig
          ? { networkId: networkConfig.id }
          : {
              network: {
                family: NetworkFamily.EVM,
                legacyChain: expectedNetwork,
              },
            }),
      },
      include: { asset: true, network: true },
      orderBy: { asset: { symbol: 'asc' } },
    });
    const assets = contracts.map((contract) => ({
      symbol: contract.asset.symbol,
      standard: contract.standard,
      chain: contract.network.legacyChain,
      tokenAddress: contract.address,
      depositEnabled: contract.depositEnabled,
      withdrawalEnabled: contract.withdrawalEnabled,
      contractVerifiedAt: contract.contractVerifiedAt ?? contract.asset.contractVerifiedAt,
      contractCodeHash: contract.contractCodeHash ?? contract.asset.contractCodeHash,
      verifiedChainId: contract.verifiedChainId ?? contract.asset.verifiedChainId,
      networkKey: contract.network.chainKey,
    }));
    for (const asset of assets) {
      const isNative = asset.standard === TokenStandard.NATIVE;
      if (
        (!isNative && !asset.tokenAddress) ||
        !asset.contractVerifiedAt ||
        (!isNative && !asset.contractCodeHash) ||
        asset.verifiedChainId !== configuredChainId ||
        asset.chain !== expectedNetwork
      ) {
        issues.push(`UNVERIFIED_ASSET:${asset.symbol}`);
      }
      if (asset.tokenAddress?.toLowerCase() === ARBITRUM_MAINNET_USDC && configuredChainId !== 42161) {
        issues.push(`MAINNET_TOKEN_ADDRESS:${asset.symbol}`);
      }
      if (!isNative && asset.tokenAddress && asset.contractCodeHash) {
        try {
          const code = await this.rpcProvider.getCode(asset.tokenAddress, asset.networkKey);
          if (
            code === '0x' ||
            code === '0x0' ||
            keccak256(code as `0x${string}`) !== asset.contractCodeHash
          ) {
            issues.push(`CONTRACT_CODE_MISMATCH:${asset.symbol}`);
          }
        } catch (_error) {
          issues.push(`CONTRACT_CODE_UNAVAILABLE:${asset.symbol}`);
        }
      }
    }
    const depositReady =
      !issues.some((issue) =>
        ['RPC_', 'TESTNET_', 'MAINNET_', 'MISSING_CUSTODY_DEPOSIT', 'UNVERIFIED_ASSET'].some(
          (prefix) => issue.startsWith(prefix),
        ),
      );
    const hot = custody.find((account) => account.role === CustodyAccountRole.WITHDRAWAL_HOT);
    const withdrawalReady =
      !issues.some((issue) => issue.startsWith('RPC_')) &&
      Boolean(hot?.providerWalletRef) &&
      this.config.get<string>('WITHDRAWAL_HOT_ADDRESS', '').toLowerCase() ===
        hot?.address.toLowerCase() &&
      Boolean(this.config.get<boolean>('PRIVY_CUSTODY_ENABLED', false)) &&
      Boolean(this.config.get<string>('PRIVY_APP_ID')) &&
      Boolean(this.config.get<string>('PRIVY_APP_SECRET')) &&
      Boolean(this.config.get<string>('PRIVY_SERVER_WALLET_ID')) &&
      authorizationPrivateKeyConfigured &&
      authorizationPrivateKeyValid &&
      Boolean(this.config.get<string>('PRIVY_WEBHOOK_SIGNING_SECRET'));
    const personalDepositProvisioningReady =
      depositReady &&
      Boolean(this.config.get<boolean>('PRIVY_CUSTODY_ENABLED', false)) &&
      Boolean(this.config.get<string>('PRIVY_APP_ID')) &&
      Boolean(this.config.get<string>('PRIVY_APP_SECRET')) &&
      authorizationPrivateKeyConfigured &&
      authorizationPrivateKeyValid &&
      authorizationPublicKeyReady &&
      Boolean(this.config.get<string>('PRIVY_DEPOSIT_SWEEP_POLICY_ID'));
    const sweepGas = custody.find(
      (account) => account.role === CustodyAccountRole.SWEEP_GAS,
    );
    const sweepReady =
      personalDepositProvisioningReady &&
      Boolean(sweepGas?.providerWalletRef) &&
      Boolean(this.config.get<string>('PRIVY_SWEEP_GAS_WALLET_ID')) &&
      this.config.get<string>('PRIVY_SWEEP_GAS_WALLET_ID') ===
        sweepGas?.providerWalletRef &&
      this.config.get<string>('SWEEP_GAS_ADDRESS', '').toLowerCase() ===
        sweepGas?.address.toLowerCase() &&
      Boolean(this.config.get<string>('PRIVY_SWEEP_GAS_POLICY_ID')) &&
      this.config.get<string>('PRIVY_SWEEP_GAS_POLICY_ID') ===
        sweepGas?.policyRef &&
      BigInt(this.config.get<string>('SWEEP_GAS_TOPUP_WEI', '0')) > 0n &&
      BigInt(this.config.get<string>('SWEEP_GAS_MAX_TOPUP_WEI', '0')) > 0n;

    return {
      ready:
        depositReady &&
        withdrawalReady &&
        personalDepositProvisioningReady &&
        (!this.config.get<boolean>('DEPOSIT_SWEEP_ENABLED', false) || sweepReady),
      configuredChainId,
      rpcChainId,
      networkKey: networkConfig?.chainKey,
      network: expectedNetwork,
      custody,
      assets,
      workers: {
        depositIndexer: {
          enabled: this.config.get<boolean>('DEPOSIT_INDEXER_ENABLED', false),
          ready: depositReady,
        },
        withdrawal: {
          enabled: this.config.get<boolean>('WITHDRAWAL_WORKER_ENABLED', false),
          ready: withdrawalReady,
        },
        depositSweep: {
          enabled: this.config.get<boolean>('DEPOSIT_SWEEP_ENABLED', false),
          ready: sweepReady,
        },
      },
      personalDepositProvisioning: {
        ready: personalDepositProvisioningReady,
      },
      issues: [
        ...issues,
        ...(hot && !hot.providerWalletRef ? ['WITHDRAWAL_HOT_PROVIDER_REF_MISSING'] : []),
        ...(hot &&
        this.config.get<string>('WITHDRAWAL_HOT_ADDRESS', '').toLowerCase() !==
          hot.address.toLowerCase()
          ? ['WITHDRAWAL_HOT_ADDRESS_MISMATCH']
          : []),
        ...(!this.config.get<boolean>('PRIVY_CUSTODY_ENABLED', false)
          ? ['PRIVY_CUSTODY_DISABLED']
          : []),
        ...(!this.config.get<string>('PRIVY_WEBHOOK_SIGNING_SECRET')
          ? ['PRIVY_WEBHOOK_SECRET_MISSING']
          : []),
        ...(!this.config.get<string>('PRIVY_DEPOSIT_SWEEP_POLICY_ID')
          ? ['PRIVY_DEPOSIT_SWEEP_POLICY_MISSING']
          : []),
        ...(authorizationPrivateKeyConfigured && !authorizationPrivateKeyValid
          ? ['PRIVY_AUTHORIZATION_PRIVATE_KEY_INVALID']
          : []),
        ...(authorizationPrivateKeyConfigured &&
        authorizationPrivateKeyValid &&
        !authorizationPublicKeyReady
          ? ['PRIVY_AUTHORIZATION_PUBLIC_KEY_MISSING']
          : []),
        ...(this.config.get<boolean>('DEPOSIT_SWEEP_ENABLED', false) && !sweepReady
          ? ['DEPOSIT_SWEEP_NOT_READY']
          : []),
      ],
    };
  }

  async getAllReadiness() {
    const networks = await this.prisma.network.findMany({
      where: {
        family: NetworkFamily.EVM,
        OR: [{ depositEnabled: true }, { withdrawalEnabled: true }],
      },
      orderBy: { chainKey: 'asc' },
    });
    return Promise.all(networks.map((network) => this.getReadiness(network.chainKey)));
  }

  async assertWorkerReady(
    worker: 'deposit' | 'withdrawal' | 'sweep',
    networkKey?: string,
  ): Promise<void> {
    const readiness = await this.getReadiness(networkKey);
    const ready = worker === 'deposit'
      ? readiness.workers.depositIndexer.ready
      : worker === 'withdrawal'
        ? readiness.workers.withdrawal.ready
        : readiness.workers.depositSweep.ready;
    if (!ready) {
      throw new ServiceUnavailableException(
        `${worker} worker is not ready${
          readiness.networkKey ? ` for ${readiness.networkKey}` : ''
        }: ${readiness.issues.join(', ')}`,
      );
    }
  }

  private async resolveNetworkConfig(networkKey?: string) {
    const key = networkKey?.trim().toLowerCase();
    if (key) {
      const network = await this.prisma.network.findUnique({ where: { chainKey: key } });
      if (!network) {
        throw new BadRequestException(`Unsupported network: ${key}`);
      }
      return network;
    }
    return this.prisma.network.findFirst({
      where: { chainId: this.config.get<number>('ONCHAIN_CHAIN_ID', 421614) },
    });
  }

  private hasValidAuthorizationPrivateKey(): boolean {
    const encoded = this.config.get<string>('PRIVY_AUTHORIZATION_PRIVATE_KEY_BASE64');
    if (!encoded) {
      return false;
    }

    const privateKeyMaterial = encoded.startsWith('wallet-auth:')
      ? encoded.slice('wallet-auth:'.length)
      : encoded;
    const decoded = Buffer.from(privateKeyMaterial, 'base64');

    try {
      const text = decoded.toString('utf8');
      createPrivateKey(
        text.includes('BEGIN PRIVATE KEY')
          ? text
          : { key: decoded, format: 'der', type: 'pkcs8' },
      );
      return true;
    } catch (_error) {
      return this.hasExtractableP256PrivateScalar(decoded);
    }
  }

  private hasExtractableP256PrivateScalar(pkcs8Bytes: Buffer): boolean {
    try {
      const privateKeyStart = pkcs8Bytes.indexOf(Buffer.from([0x04, 0x20]));
      if (privateKeyStart === -1) {
        return false;
      }
      const privateKeyBytes = pkcs8Bytes.subarray(privateKeyStart + 2, privateKeyStart + 34);
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(privateKeyBytes);
      return true;
    } catch (_error) {
      return false;
    }
  }
}
