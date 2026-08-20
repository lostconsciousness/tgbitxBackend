import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  Chain,
  DepositStatus,
  LedgerAccountType,
  LedgerEntryDirection,
  Market,
  MarketStatus,
  MarketType,
  Network,
  NetworkFamily,
  PositionStatus,
  Prisma,
  TokenStandard,
  UserDepositAddress,
  UserDepositAddressStatus,
  Wallet,
} from '@prisma/client';
import { formatUnits } from 'viem';
import { PrismaService } from '../../database/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { MarketDataService } from '../market-data/market-data.service';
import { AssetValuationService } from './asset-valuation.service';
import { RPC_PROVIDER } from '../rpc/rpc.module';
import { RpcProvider } from '../rpc/rpc-provider.interface';
import { toWalletResponse } from '../wallets/wallet.presenter';
import {
  legacyChainDisplayName,
  legacyChainToNetworkKey,
  nativeGasSymbol,
} from '../../common/utils/network-metadata';
import { NonEvmTestnetAdapterService } from '../onchain/non-evm-testnet-adapter.service';
import { buildWithdrawalFeeBreakdown } from '../withdrawals/withdrawal-fee.policy';
import { PositionsService } from '../positions/positions.service';
import { UserUpdatesService } from '../user-updates/user-updates.service';

type OnChainBalanceSource = 'CONNECTED_WALLET' | 'PERSONAL_DEPOSIT_ADDRESS';

type OnChainBalanceTarget = {
  source: OnChainBalanceSource;
  walletId?: string;
  depositAddressId?: string;
  address: string;
  chain: Chain;
  networkKey: string;
  label: string | null;
};

type OnChainTokenContract = {
  asset: Pick<Asset, 'id' | 'symbol' | 'name' | 'iconUrl' | 'type' | 'decimals'>;
  address: string | null;
  standard: string;
  networkKey: string;
  decimals: number;
};

type OverviewDepositAddress = {
  id: string;
  network: Record<string, unknown>;
  address: string;
  status: UserDepositAddressStatus;
  createdAt: Date;
};

type OverviewResult = {
  environment: {
    displayMode: 'MAINNET' | 'TESTNET';
    mainnetOnly: boolean;
    hyperliquidTestnet: boolean;
  };
  user: {
    id: string;
    email: string;
    role: string;
    status: string;
    createdAt: Date;
  };
  wallets: ReturnType<typeof toWalletResponse>[];
  depositAddresses: OverviewDepositAddress[];
  balances: Array<Record<string, unknown>>;
  portfolio: Record<string, unknown>;
  onChainBalances: Array<Record<string, unknown>>;
  connectedWalletBalances: unknown[];
  openOrders: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  depositIntents: Array<Record<string, unknown>>;
};

@Injectable()
export class AccountService implements OnModuleDestroy {
  private readonly logger = new Logger(AccountService.name);
  private readonly overviewCache = new Map<string, { expiresAt: number; value: OverviewResult }>();
  private readonly depositOnChainCache = new Map<
    string,
    {
      expiresAt: number;
      balances: Awaited<ReturnType<AccountService['getOnChainBalances']>>;
      totalsByAssetId: Map<string, Prisma.Decimal>;
    }
  >();
  private readonly connectedWalletBalancesCache = new Map<
    string,
    { expiresAt: number; value: Awaited<ReturnType<AccountService['loadConnectedWalletBalancesForUser']>> }
  >();
  private readonly unsubscribeUserUpdates?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly marketDataService: MarketDataService,
    private readonly assetValuation: AssetValuationService,
    @Inject(RPC_PROVIDER) private readonly rpcProvider: RpcProvider,
    private readonly nonEvm: NonEvmTestnetAdapterService,
    private readonly config: ConfigService,
    private readonly positions: PositionsService,
    @Optional() private readonly userUpdates?: UserUpdatesService,
  ) {
    this.unsubscribeUserUpdates = this.userUpdates?.subscribe((update) => {
      if (
        update.kinds.has('balances') ||
        update.kinds.has('orders') ||
        update.kinds.has('positions')
      ) {
        this.invalidateOverviewCache(update.userId);
      }
      if (update.kinds.has('wallets')) {
        this.connectedWalletBalancesCache.delete(update.userId);
      }
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeUserUpdates?.();
  }

  invalidateOverviewCache(userId: string): void {
    this.overviewCache.delete(userId);
  }

  async getOverview(userId: string): Promise<OverviewResult> {
    const cachedOverview = this.readOverviewCache(userId);
    if (cachedOverview) {
      return {
        ...cachedOverview,
        positions: await this.positions.listUserPositions(userId, {
          status: PositionStatus.OPEN,
        }),
      };
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    const assets = await this.prisma.asset.findMany({
      include: { tokenContracts: { include: { network: true } } },
      orderBy: { symbol: 'asc' },
    });
    const [networks, wallets, depositAddresses, openOrders, depositIntents, positions] = await Promise.all([
      this.prisma.network.findMany({
        orderBy: { chainKey: 'asc' },
      }),
      this.prisma.wallet.findMany({
        where: { userId },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.userDepositAddress.findMany({
        where: {
          userId,
          status: UserDepositAddressStatus.ACTIVE,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.order.findMany({
        where: {
          userId,
          status: { in: ['ROUTED', 'OPEN', 'PARTIALLY_FILLED', 'PROVIDER_PENDING'] },
        },
        include: { market: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.depositIntent.findMany({
        where: {
          userId,
          status: { in: ['PENDING', 'SUBMITTED', 'DETECTED', 'CONFIRMED'] },
        },
        include: { asset: true, tokenContract: { include: { network: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.positions.listUserPositions(userId, { status: PositionStatus.OPEN }),
    ]);
    const networkByLegacyChain = this.mapNetworksByLegacyChain(networks);
    const visibleNetworks = this.filterDisplayNetworks(networks);
    const visibleNetworkKeys = new Set(visibleNetworks.map((network) => network.chainKey));
    const displayAssets = this.filterDisplayAssets(assets);
    const tokenContracts = this.buildOnChainTokenContracts(displayAssets, visibleNetworkKeys);
    const depositNetworkKeys = new Set(
      depositAddresses
        .map((address) => networkByLegacyChain.get(address.network)?.chainKey)
        .filter((networkKey): networkKey is string => Boolean(networkKey)),
    );
    const depositTokenContracts = tokenContracts.filter((contract) =>
      depositNetworkKeys.has(contract.networkKey),
    );
    const nativePricesUsd = await this.assetValuation.loadNativePricesUsd();
    const [
      pendingDepositsByAssetId,
      ledgerByAssetId,
      depositOnChainSnapshot,
    ] = await Promise.all([
      this.getPendingDepositTotalsByAsset(userId, this.isMainnetDisplayMode()),
      this.getOverviewSpotBalancesByAssetId(
        userId,
        displayAssets.map((asset) => asset.id),
      ),
      this.getPersonalDepositOnChainSnapshot({
        userId,
        depositAddresses,
        tokenContracts: depositTokenContracts,
        networks: visibleNetworks,
        displayAssets,
      }),
    ]);
    const onChainPersonalTotalsByAssetId = depositOnChainSnapshot.totalsByAssetId;
    const balances = displayAssets
      .map((asset) => {
        const ledgerAmount = ledgerByAssetId.get(asset.id) ?? new Prisma.Decimal(0);
        const pendingFromIndexer =
          pendingDepositsByAssetId.get(asset.id) ?? new Prisma.Decimal(0);
        const onChainTotal =
          onChainPersonalTotalsByAssetId.get(asset.id) ?? new Prisma.Decimal(0);
        const indexedTotal = ledgerAmount.plus(pendingFromIndexer);
        const pendingFromOnChain = onChainTotal.greaterThan(indexedTotal)
          ? onChainTotal.minus(indexedTotal)
          : new Prisma.Decimal(0);
        const pendingDeposit = pendingFromIndexer.plus(pendingFromOnChain);
        const totalBalance = ledgerAmount.plus(pendingDeposit);
        const status = this.resolveBalanceStatus(ledgerAmount, pendingDeposit);

        return {
          asset: {
            id: asset.id,
            symbol: asset.symbol,
            name: asset.name,
            iconUrl: asset.iconUrl,
            type: asset.type,
            decimals: asset.decimals,
            networks: asset.tokenContracts
              .filter((contract) => visibleNetworkKeys.has(contract.network.chainKey))
              .map((contract) => this.toAssetNetworkResponse(contract, asset.symbol, nativePricesUsd))
              .filter((network) => network.depositEnabled || network.withdrawalEnabled),
          },
          balance: totalBalance.toString(),
          available: ledgerAmount.toString(),
          total: totalBalance.toString(),
          pendingDeposit: pendingDeposit.greaterThan(0) ? pendingDeposit.toString() : '0',
          status,
        };
      })
      .filter(
        (balance) =>
          new Prisma.Decimal(balance.total).greaterThan(0) &&
          !this.isOperationalGasDustBalance(balance),
      );
    const [portfolio] = await Promise.all([
      this.buildPortfolio(balances),
    ]);
    const balancesWithUsdcValue = portfolio.assets.map((asset) => ({
      ...asset,
      balanceUsdc: asset.valueUsdc,
      balanceValueUsdc: asset.valueUsdc,
      availableValueUsdc: asset.valueUsdc,
      totalValueUsdc: asset.valueUsdc,
    }));
    const onChainBalances = depositOnChainSnapshot.balances;

    const overview: OverviewResult = {
      environment: {
        displayMode: this.isMainnetDisplayMode() ? 'MAINNET' : 'TESTNET',
        mainnetOnly: this.isMainnetDisplayMode(),
        hyperliquidTestnet: this.config.get<boolean>('HYPERLIQUID_TESTNET', true),
      },
      user,
      wallets: wallets.map(toWalletResponse),
      depositAddresses: depositAddresses
        .filter((depositAddress) =>
          this.shouldShowLegacyChain(depositAddress.network, networkByLegacyChain),
        )
        .map((depositAddress) => ({
          id: depositAddress.id,
          network: this.toNetworkResponse(depositAddress.network, networkByLegacyChain),
          address: depositAddress.address,
          status: depositAddress.status,
          createdAt: depositAddress.createdAt,
        })),
      balances: balancesWithUsdcValue,
      portfolio: {
        ...this.toPortfolioSummary(portfolio),
        assets: balancesWithUsdcValue,
        total_usdc: portfolio.totalUsdc,
      },
      onChainBalances: onChainBalances
        .map((balance) => this.toOnChainBalanceResponse(balance, networkByLegacyChain))
        .map((balance) => ({
          ...balance,
          balances: balance.balances.filter(
            (entry) =>
              !this.isOperationalGasDustOnDepositAddress(String(balance.source), entry),
          ),
        }))
        .filter((balance) => balance.balances.length > 0),
      connectedWalletBalances: [],
      openOrders: openOrders.map((order) => this.toOpenOrderResponse(order)),
      positions,
      depositIntents: depositIntents
        .filter((intent) => this.shouldShowDepositIntent(intent))
        .map((intent) => this.toDepositIntentResponse(intent, networkByLegacyChain)),
    };

    this.writeOverviewCache(userId, overview);
    return overview;
  }

  async getConnectedWalletBalancesForUser(userId: string) {
    const cached = this.connectedWalletBalancesCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const value = await this.loadConnectedWalletBalancesForUser(userId);
    this.connectedWalletBalancesCache.set(userId, {
      expiresAt:
        Date.now() +
        this.config.get<number>('CONNECTED_WALLET_BALANCE_CACHE_MS', 120_000),
      value,
    });
    return value;
  }

  async getConnectedWalletBalancesCompactForUser(userId: string) {
    const entries = await this.getConnectedWalletBalancesForUser(userId);
    return entries.map((entry) => ({
      wallet: entry.wallet,
      networks: entry.networks.map((networkEntry) => ({
        network: networkEntry.network.network,
        status: networkEntry.status,
        assets: networkEntry.assets.map((asset) => ({
          symbol: asset.symbol,
          balance: asset.balance,
          priceUsdc: asset.priceUsdc,
          balanceUsdc: asset.balanceUsdc,
          priceStatus: asset.priceStatus,
          status: asset.status,
        })),
      })),
      totalBalanceUsdc: entry.totalBalanceUsdc,
      priceStatus: entry.priceStatus,
    }));
  }

  async getPersonalDepositOnChainBalancesForUser(userId: string) {
    const [networks, depositAddresses, assets] = await Promise.all([
      this.prisma.network.findMany({ orderBy: { chainKey: 'asc' } }),
      this.prisma.userDepositAddress.findMany({
        where: { userId, status: UserDepositAddressStatus.ACTIVE },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.asset.findMany({
        include: { tokenContracts: { include: { network: true } } },
        orderBy: { symbol: 'asc' },
      }),
    ]);
    const visibleNetworks = this.filterDisplayNetworks(networks);
    const visibleNetworkKeys = new Set(visibleNetworks.map((network) => network.chainKey));
    const displayAssets = this.filterDisplayAssets(assets);
    const contracts = this.buildOnChainTokenContracts(displayAssets, visibleNetworkKeys);
    const networkByLegacyChain = this.mapNetworksByLegacyChain(visibleNetworks);
    const snapshot = await this.getPersonalDepositOnChainSnapshot({
      userId,
      depositAddresses,
      tokenContracts: contracts,
      networks: visibleNetworks,
      displayAssets,
    });

    return snapshot.balances
      .filter((target) => target.source === 'PERSONAL_DEPOSIT_ADDRESS')
      .map((target) => ({
        source: target.source,
        depositAddressId: target.depositAddressId,
        address: target.address,
        network:
          networkByLegacyChain.get(target.chain)?.chainKey ??
          legacyChainToNetworkKey(target.chain),
        status: target.status,
        balances: target.balances
          .filter((balance) =>
            !this.isOperationalGasDustOnDepositAddress(target.source, balance),
          )
          .map((balance) => ({
            assetId: 'id' in balance.asset ? balance.asset.id : undefined,
            symbol: balance.asset.symbol,
            balance: balance.balance,
            status: balance.status,
          })),
      }))
      .filter((target) => target.balances.length > 0);
  }

  async getPortfolioSummaryForUser(userId: string) {
    const balances = await this.ledgerService.listUserSpotBalances(userId, {
      mainnetOnly: this.isMainnetDisplayMode(),
    });
    const portfolio = await this.buildPortfolio(
      balances.filter((balance) => new Prisma.Decimal(balance.total).greaterThan(0)),
    );
    return this.toPortfolioSummary(portfolio);
  }

  private async loadConnectedWalletBalancesForUser(userId: string) {
    const [networks, wallets, assets] = await Promise.all([
      this.prisma.network.findMany({
        orderBy: { chainKey: 'asc' },
      }),
      this.prisma.wallet.findMany({
        where: { userId, status: 'ACTIVE' },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.asset.findMany({
        include: { tokenContracts: { include: { network: true } } },
        orderBy: { symbol: 'asc' },
      }),
    ]);
    const visibleNetworks = this.filterConnectedWalletNetworks(networks);
    const visibleNetworkKeys = new Set(visibleNetworks.map((network) => network.chainKey));
    const tokenContracts = this.buildOnChainTokenContracts(assets, visibleNetworkKeys);

    return this.getConnectedWalletBalances({
      wallets,
      tokenContracts,
      networks: visibleNetworks,
      assets,
    });
  }

  private async getConnectedWalletBalances(input: {
    wallets: Wallet[];
    tokenContracts: OnChainTokenContract[];
    networks: Network[];
    assets: Array<Asset & { tokenContracts: Array<{ network: Network }> }>;
  }) {
    const markets = await this.prisma.market.findMany({
      where: {
        status: MarketStatus.ACTIVE,
        quoteAsset: { symbol: 'USDC' },
        type: { in: [MarketType.SPOT, MarketType.PERP] },
      },
      include: { baseAsset: true, quoteAsset: true },
      orderBy: [{ type: 'asc' }, { symbol: 'asc' }],
    });
    const targets = this.buildConnectedWalletTargets(input.wallets, input.networks);
    const entries = await this.scanOnChainTargetsInBatches(
      targets,
      input.tokenContracts,
      input.assets,
      input.networks,
      markets,
    );

    const walletMap = new Map(
      input.wallets
        .filter((wallet) => wallet.status === 'ACTIVE')
        .map((wallet) => [wallet.id, wallet]),
    );
    const grouped = new Map<
      string,
      Array<(typeof entries)[number]>
    >();

    for (const entry of entries) {
      if (entry.assets.length === 0) {
        continue;
      }
      const bucket = grouped.get(entry.walletId) ?? [];
      bucket.push(entry);
      grouped.set(entry.walletId, bucket);
    }

    return [...walletMap.values()].map((wallet) => {
      const networks = (grouped.get(wallet.id) ?? [])
        .sort((left, right) => left.network.network.localeCompare(right.network.network))
        .map((networkEntry) => ({
          ...networkEntry,
          assets: this.aggregateAssetsBySymbol(networkEntry.assets),
        }));
      const totalBalanceUsdc = networks
        .flatMap((network) => network.assets)
        .reduce((sum, asset) => {
          if (!asset.balanceUsdc) {
            return sum;
          }
          return sum.plus(asset.balanceUsdc);
        }, new Prisma.Decimal(0));

      return {
        wallet: toWalletResponse(wallet),
        networks,
        totalBalanceUsdc: networks.some((network) =>
          network.assets.some((asset) => asset.priceStatus === 'UNAVAILABLE'),
        )
          ? null
          : totalBalanceUsdc.toString(),
        priceStatus: networks.some((network) =>
          network.assets.some((asset) => asset.priceStatus === 'UNAVAILABLE'),
        )
          ? ('PARTIAL' as const)
          : ('AVAILABLE' as const),
      };
    });
  }

  private buildOnChainTokenContracts(
    assets: Array<
      Asset & {
        tokenContracts: Array<{
          standard: string;
          address: string | null;
          decimals: number;
          depositEnabled: boolean;
          withdrawalEnabled: boolean;
          network: Network;
        }>;
      }
    >,
    visibleNetworkKeys?: Set<string>,
  ): OnChainTokenContract[] {
    const contracts: OnChainTokenContract[] = [];
    const seen = new Set<string>();

    for (const asset of assets) {
      for (const contract of asset.tokenContracts) {
        if (visibleNetworkKeys && !visibleNetworkKeys.has(contract.network.chainKey)) {
          continue;
        }
        if (!contract.depositEnabled && !contract.withdrawalEnabled) {
          continue;
        }
        const addresses: string[] = [];
        if (contract.address) {
          addresses.push(contract.address);
        }
        if (
          asset.tokenAddress &&
          contract.network.legacyChain === asset.chain &&
          !addresses.some(
            (address) => address.toLowerCase() === asset.tokenAddress!.toLowerCase(),
          )
        ) {
          addresses.push(asset.tokenAddress);
        }
        if (contract.network.family !== 'EVM' && contract.standard === TokenStandard.NATIVE) {
          addresses.push('');
        }
        if (contract.network.family !== 'EVM' && contract.standard === TokenStandard.BTC) {
          addresses.push('');
        }

        for (const address of addresses) {
          const dedupeKey = `${contract.network.chainKey}:${contract.standard}:${address.toLowerCase()}`;
          if (seen.has(dedupeKey)) {
            continue;
          }
          seen.add(dedupeKey);

          contracts.push({
            asset: {
              id: asset.id,
              symbol: asset.symbol,
              name: asset.name,
              iconUrl: asset.iconUrl,
              type: asset.type,
              decimals: asset.decimals,
            },
            address: address || null,
            standard: contract.standard,
            networkKey: contract.network.chainKey,
            decimals: contract.decimals,
          });
        }
      }
    }

    return contracts;
  }

  private async scanOnChainTargetsInBatches(
    targets: OnChainBalanceTarget[],
    tokenContracts: OnChainTokenContract[],
    assets: Array<Pick<Asset, 'id' | 'symbol' | 'name' | 'iconUrl' | 'type' | 'decimals'>>,
    networks: Network[],
    markets: Array<Market & { baseAsset: Asset }>,
    batchSize = 4,
  ) {
    const networkByKey = new Map(networks.map((network) => [network.chainKey, network]));
    const entries: Array<{
      walletId: string;
      network: {
        network: string;
        displayName: string;
        iconUrl: string | null;
        caip2: string | null;
        chainId: number | null;
        family: NetworkFamily;
        disabledReason: string | null;
      };
      status: 'AVAILABLE' | 'PARTIAL';
      assets: Awaited<ReturnType<AccountService['enrichOnChainAssetBalance']>>[];
    }> = [];

    for (let index = 0; index < targets.length; index += batchSize) {
      const batch = targets.slice(index, index + batchSize);
      const batchEntries = await Promise.all(
        batch.map(async (target) => {
          if (!target.walletId) {
            return null;
          }

          const networkContracts = tokenContracts.filter(
            (contract) => contract.networkKey === target.networkKey,
          );
          const network = networkByKey.get(target.networkKey);
          const [nativeBalance, tokenBalances] =
            network?.family === NetworkFamily.EVM || !network
              ? await this.getEvmBalances(target, networkContracts)
              : await Promise.all([
                  Promise.resolve(null),
                  Promise.all(
                    networkContracts.map((contract) =>
                      this.getNonEvmBalance(target, contract, network),
                    ),
                  ),
                ]);
          const balances = [nativeBalance, ...tokenBalances].filter(
            (balance): balance is NonNullable<typeof balance> => Boolean(balance),
          );
          const nonZeroBalances = balances.filter((balance) =>
            this.hasPositiveBalance(balance.balance),
          );
          const enrichedAssets = await Promise.all(
            nonZeroBalances.map((balance) =>
              this.enrichOnChainAssetBalance(balance, assets, markets),
            ),
          );
          return {
            walletId: target.walletId,
            network: network
              ? {
                  network: network.chainKey,
                  displayName: network.displayName,
                  iconUrl: network.iconUrl,
                  caip2: network.caip2,
                  chainId: network.chainId,
                  family: network.family,
                  disabledReason:
                    this.isNetworkAdapterEnabled(network)
                      ? null
                      : `${network.family} balance adapter is not enabled on mainnet`,
                }
              : {
                  network: target.networkKey,
                  displayName: target.networkKey,
                  iconUrl: null,
                  caip2: null,
                  chainId: null,
                  family: NetworkFamily.EVM,
                  disabledReason: null,
                },
            status: balances.some((balance) => balance.status === 'UNAVAILABLE')
              ? ('PARTIAL' as const)
              : ('AVAILABLE' as const),
            assets: enrichedAssets,
          };
        }),
      );

      entries.push(
        ...batchEntries.filter(
          (entry): entry is NonNullable<typeof entry> => Boolean(entry),
        ),
      );
    }

    return entries;
  }

  private aggregateAssetsBySymbol(
    assets: Array<{
      symbol: string;
      name: string;
      iconUrl: string | null;
      type: string;
      decimals: number;
      tokenStandard: string;
      tokenAddress: string | null;
      balance: string | null;
      priceUsdc: string | null;
      balanceUsdc: string | null;
      priceStatus: 'AVAILABLE' | 'UNAVAILABLE';
      status: string;
    }>,
  ) {
    const grouped = new Map<string, (typeof assets)[number]>();

    for (const asset of assets) {
      const existing = grouped.get(asset.symbol);
      if (!existing) {
        grouped.set(asset.symbol, asset);
        continue;
      }

      const balance = new Prisma.Decimal(existing.balance ?? 0).plus(asset.balance ?? 0);
      const balanceUsdc =
        existing.balanceUsdc && asset.balanceUsdc
          ? new Prisma.Decimal(existing.balanceUsdc).plus(asset.balanceUsdc).toString()
          : existing.balanceUsdc ?? asset.balanceUsdc;

      grouped.set(asset.symbol, {
        ...existing,
        balance: balance.toString(),
        balanceUsdc,
        tokenStandard: existing.tokenStandard,
        tokenAddress: existing.tokenAddress ?? asset.tokenAddress,
        status:
          existing.status === 'UNAVAILABLE' || asset.status === 'UNAVAILABLE'
            ? 'UNAVAILABLE'
            : 'AVAILABLE',
        priceStatus:
          existing.priceStatus === 'UNAVAILABLE' || asset.priceStatus === 'UNAVAILABLE'
            ? 'UNAVAILABLE'
            : 'AVAILABLE',
      });
    }

    return [...grouped.values()];
  }

  private buildConnectedWalletTargets(wallets: Wallet[], networks: Network[]) {
    const evmNetworks = networks.filter(
      (network) => network.family === 'EVM' && network.legacyChain,
    );
    const nonEvmNetworks = networks.filter(
      (network) => network.family !== 'EVM' && network.legacyChain,
    );
    const targets: OnChainBalanceTarget[] = [];

    for (const wallet of wallets) {
      if (wallet.status !== 'ACTIVE') {
        continue;
      }
      for (const network of evmNetworks) {
        targets.push({
          source: 'CONNECTED_WALLET',
          walletId: wallet.id,
          address: wallet.address,
          chain: network.legacyChain!,
          networkKey: network.chainKey,
          label: wallet.label,
        });
      }
      for (const network of nonEvmNetworks) {
        if (wallet.chain !== network.legacyChain) {
          continue;
        }
        targets.push({
          source: 'CONNECTED_WALLET',
          walletId: wallet.id,
          address: wallet.address,
          chain: network.legacyChain!,
          networkKey: network.chainKey,
          label: wallet.label,
        });
      }
    }

    return targets;
  }

  private buildDepositAddressTargets(
    depositAddresses: UserDepositAddress[],
    networks: Network[],
  ) {
    const networkByLegacyChain = this.mapNetworksByLegacyChain(networks);
    const targets: OnChainBalanceTarget[] = [];

    for (const depositAddress of depositAddresses) {
      if (depositAddress.status !== UserDepositAddressStatus.ACTIVE) {
        continue;
      }
      const network = networkByLegacyChain.get(depositAddress.network);
      if (!network?.legacyChain) {
        continue;
      }
      targets.push({
        source: 'PERSONAL_DEPOSIT_ADDRESS',
        depositAddressId: depositAddress.id,
        address: depositAddress.address,
        chain: network.legacyChain,
        networkKey: network.chainKey,
        label: null,
      });
    }

    return targets;
  }

  private hasPositiveBalance(balance: string | null | undefined): boolean {
    if (!balance) {
      return false;
    }
    try {
      return new Prisma.Decimal(balance).greaterThan(0);
    } catch (_error) {
      return false;
    }
  }

  private readOverviewCache(userId: string): OverviewResult | null {
    const cached = this.overviewCache.get(userId);
    if (!cached || cached.expiresAt <= Date.now()) {
      return null;
    }
    return cached.value;
  }

  private writeOverviewCache(userId: string, overview: OverviewResult) {
    this.overviewCache.set(userId, {
      expiresAt: Date.now() + this.config.get<number>('ACCOUNT_OVERVIEW_CACHE_MS', 5_000),
      value: overview,
    });
  }

  private async getPersonalDepositOnChainSnapshot(input: {
    userId: string;
    depositAddresses: UserDepositAddress[];
    tokenContracts: OnChainTokenContract[];
    networks: Network[];
    displayAssets: Array<Pick<Asset, 'id' | 'symbol'>>;
  }) {
    const empty = {
      balances: [] as Awaited<ReturnType<AccountService['getOnChainBalances']>>,
      totalsByAssetId: new Map<string, Prisma.Decimal>(),
    };
    if (input.depositAddresses.length === 0) {
      return empty;
    }

    const cached = this.depositOnChainCache.get(input.userId);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        balances: cached.balances,
        totalsByAssetId: cached.totalsByAssetId,
      };
    }

    let balances: Awaited<ReturnType<AccountService['getOnChainBalances']>>;
    try {
      balances = await this.getOnChainBalances({
        wallets: [],
        depositAddresses: input.depositAddresses,
        tokenContracts: input.tokenContracts,
        networks: input.networks,
      });
    } catch (error) {
      this.logger.warn(
        `Deposit balance snapshot degraded for ${input.userId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return cached
        ? {
            balances: cached.balances,
            totalsByAssetId: cached.totalsByAssetId,
          }
        : empty;
    }
    const totalsByAssetId = this.getPersonalDepositOnChainTotalsByAssetId(
      balances,
      input.displayAssets,
    );
    const snapshot = { balances, totalsByAssetId };
    this.depositOnChainCache.set(input.userId, {
      expiresAt:
        Date.now() + this.config.get<number>('DEPOSIT_ONCHAIN_BALANCE_CACHE_MS', 30_000),
      ...snapshot,
    });
    return snapshot;
  }

  private async getOverviewSpotBalancesByAssetId(
    userId: string,
    assetIds: string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const zero = new Prisma.Decimal(0);
    const result = new Map<string, Prisma.Decimal>(
      assetIds.map((assetId) => [assetId, zero]),
    );
    if (assetIds.length === 0) {
      return result;
    }

    if (!this.isMainnetDisplayMode()) {
      await Promise.all(
        assetIds.map(async (assetId) => {
          const balance = await this.ledgerService.getUserSpotBalance({ userId, assetId });
          result.set(assetId, new Prisma.Decimal(balance.toString()));
        }),
      );
      return result;
    }

    await Promise.all(
      assetIds.map(async (assetId) => {
        const balance = await this.ledgerService.getUserMainnetSpotBalance({ userId, assetId });
        result.set(assetId, new Prisma.Decimal(balance.toString()));
      }),
    );
    return result;
  }

  private async getOverviewSpotBalance(input: {
    userId: string;
    assetId: string;
  }): Promise<Prisma.Decimal> {
    if (!this.isMainnetDisplayMode()) {
      return this.ledgerService.getUserSpotBalance(input);
    }

    return this.ledgerService.getUserMainnetSpotBalance(input);
  }

  private async getPendingDepositTotalsByAsset(
    userId: string,
    mainnetOnly = false,
  ): Promise<Map<string, Prisma.Decimal>> {
    const rows = await this.prisma.deposit.groupBy({
      by: ['assetId'],
      where: {
        userId,
        status: {
          in: [DepositStatus.PENDING_CONFIRMATION, DepositStatus.DETECTED],
        },
        ...(mainnetOnly
          ? {
              tokenContract: {
                network: { mainnet: true },
              },
            }
          : {}),
      },
      _sum: { amount: true },
    });

    return new Map(
      rows.map((row) => [row.assetId, new Prisma.Decimal(row._sum.amount ?? 0)]),
    );
  }

  private resolveBalanceStatus(
    available: Prisma.Decimal,
    pendingDeposit: Prisma.Decimal,
  ): 'CREDITED' | 'PENDING' | 'PARTIAL' {
    if (pendingDeposit.lessThanOrEqualTo(0)) {
      return 'CREDITED';
    }
    if (available.lessThanOrEqualTo(0)) {
      return 'PENDING';
    }
    return 'PARTIAL';
  }

  private getPersonalDepositOnChainTotalsByAssetId(
    onChainBalances: Awaited<ReturnType<AccountService['getOnChainBalances']>>,
    assets: Array<Pick<Asset, 'id' | 'symbol'>>,
  ): Map<string, Prisma.Decimal> {
    const onChainByAssetId = new Map<string, Prisma.Decimal>();

    for (const target of onChainBalances) {
      if (target.source !== 'PERSONAL_DEPOSIT_ADDRESS') {
        continue;
      }
      for (const entry of target.balances) {
        if (entry.status !== 'AVAILABLE' || !this.hasPositiveBalance(entry.balance)) {
          continue;
        }
        if (this.isOperationalGasDustOnDepositAddress('PERSONAL_DEPOSIT_ADDRESS', entry)) {
          continue;
        }
        const assetId =
          'id' in entry.asset && entry.asset.id
            ? entry.asset.id
            : assets.find((asset) => asset.symbol === entry.asset.symbol)?.id;
        if (!assetId) {
          continue;
        }
        const amount = new Prisma.Decimal(entry.balance!);
        onChainByAssetId.set(
          assetId,
          (onChainByAssetId.get(assetId) ?? new Prisma.Decimal(0)).plus(amount),
        );
      }
    }

    return onChainByAssetId;
  }

  private async enrichOnChainAssetBalance(
    balance: {
      asset: {
        id?: string;
        symbol: string;
        name: string;
        iconUrl: string | null;
        type: string;
        decimals: number;
        tokenStandard: string;
        tokenAddress: string | null;
      };
      balance: string | null;
      status: string;
    },
    assets: Array<Pick<Asset, 'id' | 'symbol' | 'name' | 'iconUrl' | 'type' | 'decimals'>>,
    markets: Array<Market & { baseAsset: Asset }>,
  ) {
    const pricingAsset =
      balance.asset.id !== undefined
        ? assets.find((asset) => asset.id === balance.asset.id)
        : assets.find((asset) => asset.symbol === balance.asset.symbol);
    const priceUsdc = pricingAsset
      ? await this.assetValuation.getAssetPriceUsdc(
          pricingAsset,
          markets as Array<Market & { baseAsset: Asset; quoteAsset?: Asset }>,
        )
      : null;
    const amount =
      balance.balance && this.hasPositiveBalance(balance.balance)
        ? new Prisma.Decimal(balance.balance)
        : null;
    const balanceUsdc = priceUsdc && amount ? amount.mul(priceUsdc).toString() : null;

    return {
      symbol: balance.asset.symbol,
      name: balance.asset.name,
      iconUrl: balance.asset.iconUrl,
      type: balance.asset.type,
      decimals: balance.asset.decimals,
      tokenStandard: balance.asset.tokenStandard,
      tokenAddress: balance.asset.tokenAddress,
      balance: balance.balance,
      priceUsdc: priceUsdc?.toString() ?? null,
      balanceUsdc,
      priceStatus: priceUsdc ? ('AVAILABLE' as const) : ('UNAVAILABLE' as const),
      status: balance.status,
    };
  }

  private mapNetworksByLegacyChain(networks: Network[]) {
    return new Map(
      networks
        .filter((network) => network.legacyChain)
        .map((network) => [network.legacyChain!, network]),
    );
  }

  private filterDisplayNetworks(networks: Network[]) {
    if (!this.isMainnetDisplayMode()) {
      return networks;
    }
    return networks.filter((network) => network.mainnet);
  }

  private filterConnectedWalletNetworks(networks: Network[]) {
    const configuredKeys = new Set(
      (this.config.get<string>('CONNECTED_WALLET_NETWORK_KEYS', '') ?? '')
        .split(',')
        .map((key) => key.trim().toLowerCase())
        .filter(Boolean),
    );
    return this.filterDisplayNetworks(networks).filter((network) => {
      if (!network.legacyChain || !this.isNetworkAdapterEnabled(network)) return false;
      if (configuredKeys.size > 0) return configuredKeys.has(network.chainKey.toLowerCase());
      return network.depositEnabled || network.withdrawalEnabled;
    });
  }

  private filterDisplayAssets<
    T extends Asset & { tokenContracts: Array<{ network: Network }> },
  >(assets: T[]) {
    if (!this.isMainnetDisplayMode()) {
      return assets;
    }
    return assets.filter((asset) =>
      asset.tokenContracts.some((contract) => contract.network.mainnet),
    );
  }

  private shouldShowDepositIntent(intent: {
    tokenContract?: { network: Network } | null;
    network: Chain;
  }) {
    if (!this.isMainnetDisplayMode()) {
      return true;
    }
    if (intent.tokenContract?.network) {
      return intent.tokenContract.network.mainnet;
    }
    return false;
  }

  private shouldShowLegacyChain(chain: Chain, networkByLegacyChain: Map<Chain, Network>) {
    if (!this.isMainnetDisplayMode()) {
      return true;
    }
    return networkByLegacyChain.get(chain)?.mainnet === true;
  }

  private isMainnetDisplayMode(): boolean {
    return (
      this.config.get<boolean>('DISPLAY_MAINNET_ONLY', false) ||
      this.config.get<boolean>('MAINNET_ENABLED', false)
    );
  }

  private getSweepGasDustThreshold(): Prisma.Decimal {
    const maxTopupWei = this.config.get<string>('SWEEP_GAS_MAX_TOPUP_WEI', '1000000000000000');
    try {
      return new Prisma.Decimal(formatUnits(BigInt(maxTopupWei), 18));
    } catch (_error) {
      return new Prisma.Decimal('0.001');
    }
  }

  private isOperationalGasDustOnDepositAddress(
    source: string,
    entry: {
      asset: { tokenStandard?: string };
      balance: string | null;
    },
  ): boolean {
    if (source !== 'PERSONAL_DEPOSIT_ADDRESS') {
      return false;
    }
    if (entry.asset.tokenStandard !== 'NATIVE') {
      return false;
    }
    if (!entry.balance || !this.hasPositiveBalance(entry.balance)) {
      return false;
    }
    const amount = new Prisma.Decimal(entry.balance);
    return amount.lessThanOrEqualTo(this.getSweepGasDustThreshold());
  }

  private isOperationalGasDustBalance(balance: {
    asset: { symbol: string };
    total: string;
  }): boolean {
    const total = new Prisma.Decimal(balance.total);
    if (total.greaterThan(this.getSweepGasDustThreshold())) {
      return false;
    }
    const nativeGasSymbols = new Set(['ETH', 'BNB', 'MATIC', 'AVAX']);
    return nativeGasSymbols.has(balance.asset.symbol);
  }

  private toPortfolioSummary(portfolio: {
    currency: string;
    totalUsdc: string;
    priceStatus: string;
  }) {
    return {
      currency: portfolio.currency,
      totalUsdc: portfolio.totalUsdc,
      priceStatus: portfolio.priceStatus,
    };
  }

  private toNetworkResponse(chain: Chain, networkByLegacyChain: Map<Chain, Network>) {
    const network = networkByLegacyChain.get(chain);
    if (network) {
      return {
        network: network.chainKey,
        displayName: network.displayName,
        iconUrl: network.iconUrl,
        caip2: network.caip2,
        chainId: network.chainId,
        family: network.family,
        disabledReason:
          this.isNetworkAdapterEnabled(network)
            ? null
            : `${network.family} balance adapter is not enabled on mainnet`,
      };
    }

    return {
      network: legacyChainToNetworkKey(chain),
      displayName: legacyChainDisplayName(chain),
      iconUrl: null,
      caip2: null,
      chainId: null,
      family: NetworkFamily.EVM,
      disabledReason: null,
    };
  }

  private toOnChainBalanceResponse(
    target: Awaited<ReturnType<AccountService['getOnChainBalances']>>[number],
    networkByLegacyChain: Map<Chain, Network>,
  ) {
    return {
      source: target.source,
      walletId: target.walletId,
      depositAddressId: target.depositAddressId,
      address: target.address,
      network: this.toNetworkResponse(target.chain, networkByLegacyChain),
      label: target.label,
      status: target.status,
      balances: target.balances.map((balance) => ({
        asset: {
          id: 'id' in balance.asset ? balance.asset.id : undefined,
          symbol: balance.asset.symbol,
          name: balance.asset.name,
          iconUrl: 'iconUrl' in balance.asset ? balance.asset.iconUrl : null,
          type: balance.asset.type,
          decimals: balance.asset.decimals,
          tokenStandard: balance.asset.tokenStandard,
          tokenAddress: balance.asset.tokenAddress,
        },
        balance: balance.balance,
        status: balance.status,
      })),
    };
  }

  private toOpenOrderResponse(order: {
    id: string;
    market: { symbol: string; type: MarketType };
    side: string;
    type: string;
    status: string;
    size: { toString(): string };
    filledSize: { toString(): string };
    price: { toString(): string } | null;
    averageFillPrice: { toString(): string } | null;
    triggerPrice: { toString(): string } | null;
    leverage: number;
    reduceOnly: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: order.id,
      market: order.market.symbol,
      marketType: order.market.type,
      side: order.side,
      type: order.type,
      status: order.status,
      size: order.size.toString(),
      filledSize: order.filledSize.toString(),
      price: order.price?.toString() ?? null,
      averageFillPrice: order.averageFillPrice?.toString() ?? null,
      triggerPrice: order.triggerPrice?.toString() ?? null,
      leverage: order.leverage,
      reduceOnly: order.reduceOnly,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private toDepositIntentResponse(
    intent: {
      id: string;
      asset: {
        id: string;
        symbol: string;
        name: string;
        iconUrl: string | null;
        type: string;
        decimals: number;
      };
      tokenContract?: {
        standard: string;
        address: string | null;
        network: Network;
      } | null;
      network: Chain;
      fromAddress: string;
      treasuryAddress: string;
      amount: { toString(): string };
      rawAmount: string;
      txHash: string | null;
      status: string;
      expiresAt: Date;
      createdAt: Date;
      updatedAt: Date;
    },
    networkByLegacyChain: Map<Chain, Network>,
  ) {
    const network = intent.tokenContract?.network
      ? {
          network: intent.tokenContract.network.chainKey,
          displayName: intent.tokenContract.network.displayName,
          iconUrl: intent.tokenContract.network.iconUrl,
          caip2: intent.tokenContract.network.caip2,
          chainId: intent.tokenContract.network.chainId,
          family: intent.tokenContract.network.family,
          disabledReason:
            this.isNetworkAdapterEnabled(intent.tokenContract.network)
              ? null
              : `${intent.tokenContract.network.family} balance adapter is not enabled on mainnet`,
        }
      : this.toNetworkResponse(intent.network, networkByLegacyChain);

    return {
      id: intent.id,
      status: intent.status,
      asset: {
        id: intent.asset.id,
        symbol: intent.asset.symbol,
        name: intent.asset.name,
        iconUrl: intent.asset.iconUrl,
        type: intent.asset.type,
        decimals: intent.asset.decimals,
      },
      network,
      fromAddress: intent.fromAddress,
      depositAddress: intent.treasuryAddress,
      amount: intent.amount.toString(),
      rawAmount: intent.rawAmount,
      txHash: intent.txHash,
      expiresAt: intent.expiresAt,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
    };
  }

  private toAssetNetworkResponse(
    contract: {
    standard: string;
    address: string | null;
    decimals: number;
    depositEnabled: boolean;
    withdrawalEnabled: boolean;
    withdrawalFeeAmount: { toString(): string };
    minWithdrawalAmount: { toString(): string };
    contractVerifiedAt: Date | null;
    contractCodeHash: string | null;
    verifiedChainId: number | null;
    network: {
      chainKey: string;
      displayName: string;
      iconUrl: string | null;
      caip2: string | null;
      chainId: number | null;
      family: NetworkFamily;
      depositEnabled: boolean;
      withdrawalEnabled: boolean;
      confirmations: number;
      mainnet: boolean;
    };
  },
    assetSymbol: string,
    nativePricesUsd?: Partial<Record<string, string>>,
  ) {
    const isNativeLike = contract.standard === 'NATIVE' || contract.standard === 'BTC';
    const adapterEnabled = this.isNetworkAdapterEnabled(contract.network);
    const contractReady = isNativeLike || Boolean(contract.address);
    const contractVerified = Boolean(
      isNativeLike
        ? contract.contractVerifiedAt
        : contract.network.family === NetworkFamily.EVM
          ? contract.contractVerifiedAt && contract.contractCodeHash
          : contract.contractVerifiedAt || contract.address,
    );

    const feeBreakdown = buildWithdrawalFeeBreakdown({
      assetSymbol,
      networkKey: contract.network.chainKey,
      configuredAmount: contract.withdrawalFeeAmount.toString(),
      tokenStandard: contract.standard as TokenStandard,
      nativePricesUsd,
    });

    return {
      network: contract.network.chainKey,
      displayName: contract.network.displayName,
      iconUrl: contract.network.iconUrl,
      caip2: contract.network.caip2,
      chainId: contract.network.chainId,
      family: contract.network.family,
      tokenStandard: contract.standard,
      tokenAddress: contract.address,
      decimals: contract.decimals,
      nativeGasSymbol: nativeGasSymbol(contract.network.chainKey),
      depositEnabled:
        adapterEnabled &&
        contract.network.depositEnabled &&
        contract.depositEnabled &&
        contractReady,
      withdrawalEnabled:
        adapterEnabled &&
        contract.network.withdrawalEnabled &&
        contract.withdrawalEnabled &&
        contractReady &&
        contractVerified,
      disabledReason: adapterEnabled
        ? null
        : `${contract.network.family} adapter is not enabled on mainnet`,
      withdrawalFeeAmount: feeBreakdown.withdrawalFeeAmount,
      estimatedNetworkCostUsd: feeBreakdown.estimatedNetworkCostUsd,
      gasPaidByExchange: feeBreakdown.gasPaidByExchange,
      minWithdrawalAmount: contract.minWithdrawalAmount.toString(),
      contractVerified,
      verifiedChainId: contract.verifiedChainId,
      requiredConfirmations: contract.network.confirmations,
    };
  }

  private isNetworkAdapterEnabled(network: {
    family: NetworkFamily;
    mainnet: boolean;
  }): boolean {
    if (network.family === NetworkFamily.EVM || !network.mainnet) {
      return true;
    }
    if (!this.config.get<boolean>('MAINNET_ENABLED', false)) {
      return false;
    }
    if (network.family === NetworkFamily.SVM) {
      return Boolean(this.config.get<string>('SOLANA_RPC_PRIMARY_URL'));
    }
    if (network.family === NetworkFamily.TVM) {
      return Boolean(this.config.get<string>('TRON_RPC_PRIMARY_URL'));
    }
    return false;
  }

  private async buildPortfolio(
    balances: Array<{
      asset: Pick<
        Asset,
        | 'id'
        | 'symbol'
        | 'name'
        | 'iconUrl'
        | 'type'
        | 'decimals'
      > & {
        networks?: Array<{
          network: string;
          displayName: string;
          iconUrl: string | null;
          caip2: string | null;
          chainId: number | null;
          family: NetworkFamily;
          tokenStandard: string;
          tokenAddress: string | null;
          decimals: number;
          depositEnabled: boolean;
          withdrawalEnabled: boolean;
          disabledReason: string | null;
          contractVerified: boolean;
          verifiedChainId: number | null;
          requiredConfirmations: number;
        }>;
      };
      balance: string;
      available: string;
      total: string;
    }>,
  ) {
    const markets = await this.assetValuation.loadUsdcMarkets();
    const prices = await Promise.all(
      balances.map(async (balance) => {
        const price = await this.assetValuation.getAssetPriceUsdc(balance.asset, markets);
        const amount = new Prisma.Decimal(balance.total);
        const value = price ? amount.mul(price) : null;

        return {
          ...balance,
          priceUsdc: price?.toString() ?? null,
          valueUsdc: value?.toString() ?? null,
          priceStatus: price ? 'AVAILABLE' : 'UNAVAILABLE',
        };
      }),
    );
    const totalUsdc = prices.reduce(
      (sum, asset) => (asset.valueUsdc ? sum.plus(asset.valueUsdc) : sum),
      new Prisma.Decimal(0),
    );

    return {
      currency: 'USDC',
      totalUsdc: totalUsdc.toString(),
      priceStatus: prices.some((asset) => asset.priceStatus === 'UNAVAILABLE')
        ? 'PARTIAL'
        : 'AVAILABLE',
      assets: prices,
    };
  }

  private async getOnChainBalances(input: {
    wallets: Wallet[];
    depositAddresses: UserDepositAddress[];
    tokenContracts: OnChainTokenContract[];
    networks: Network[];
  }) {
    const targets = [
      ...this.buildConnectedWalletTargets(input.wallets, input.networks),
      ...this.buildDepositAddressTargets(input.depositAddresses, input.networks),
    ];
    const networkByKey = new Map(input.networks.map((network) => [network.chainKey, network]));

    return Promise.all(
      targets.map(async (target) => {
        const networkContracts = input.tokenContracts.filter(
          (contract) => contract.networkKey === target.networkKey,
        );
        const network = networkByKey.get(target.networkKey);
        const [nativeBalance, tokenBalances] =
          network?.family === NetworkFamily.EVM || !network
            ? await this.getEvmBalances(target, networkContracts)
            : await Promise.all([
                Promise.resolve(null),
                Promise.all(
                  networkContracts.map((contract) =>
                    this.getNonEvmBalance(target, contract, network),
                  ),
          ),
        ]);

        const balances = [nativeBalance, ...tokenBalances].filter(
          (balance): balance is NonNullable<typeof balance> => Boolean(balance),
        );
        const status = balances.some((balance) => balance.status === 'UNAVAILABLE')
          ? 'PARTIAL'
          : 'AVAILABLE';

        return {
          ...target,
          status,
          balances,
        };
      }),
    );
  }

  private async getNativeBalance(target: OnChainBalanceTarget) {
    const gasSymbol = nativeGasSymbol(target.networkKey);
    try {
      const balance = await this.rpcProvider.getBalance(
        target.address,
        undefined,
        target.networkKey,
      );
      return {
        asset: {
          symbol: gasSymbol,
          name: gasSymbol,
          iconUrl: null,
          type: 'NATIVE',
          chain: target.chain,
          decimals: 18,
          tokenStandard: 'NATIVE',
          tokenAddress: null,
        },
        balance: formatUnits(BigInt(balance.value), 18),
        rawBalance: balance.value,
        status: 'AVAILABLE',
      };
    } catch (_error) {
      return {
        asset: {
          symbol: gasSymbol,
          name: gasSymbol,
          iconUrl: null,
          type: 'NATIVE',
          chain: target.chain,
          decimals: 18,
          tokenStandard: 'NATIVE',
          tokenAddress: null,
        },
        balance: null,
        rawBalance: null,
        status: 'UNAVAILABLE',
      };
    }
  }

  private async getEvmBalances(
    target: OnChainBalanceTarget,
    contracts: OnChainTokenContract[],
  ): Promise<[
    Awaited<ReturnType<AccountService['getNativeBalance']>>,
    Array<Awaited<ReturnType<AccountService['getTokenBalance']>>>,
  ]> {
    const tokenContracts = contracts.filter(
      (contract): contract is OnChainTokenContract & { address: string } =>
        Boolean(contract.address),
    );
    if (!this.rpcProvider.getBalances) {
      return Promise.all([
        this.getNativeBalance(target),
        Promise.all(tokenContracts.map((contract) => this.getTokenBalance(target, contract))),
      ]);
    }
    try {
      const balances = await this.rpcProvider.getBalances(
        target.address,
        [
          {},
          ...tokenContracts.map((contract) => ({
            token: contract.address,
            tokenDecimals: contract.decimals,
          })),
        ],
        target.networkKey,
      );
      const native = balances[0];
      if (!native) throw new Error('Multicall native balance is missing');
      const nativeBalance = {
        asset: {
          symbol: nativeGasSymbol(target.networkKey),
          name: nativeGasSymbol(target.networkKey),
          iconUrl: null,
          type: 'NATIVE',
          chain: target.chain,
          decimals: 18,
          tokenStandard: 'NATIVE',
          tokenAddress: null,
        },
        balance: formatUnits(BigInt(native.value), 18),
        rawBalance: native.value,
        status: 'AVAILABLE' as const,
      };
      const tokenBalances = tokenContracts.map((contract, index) => ({
        asset: {
          id: contract.asset.id,
          symbol: contract.asset.symbol,
          name: contract.asset.name,
          iconUrl: contract.asset.iconUrl,
          type: contract.asset.type,
          chain: target.chain,
          decimals: contract.asset.decimals,
          tokenStandard: contract.standard,
          tokenAddress: contract.address,
        },
        balance: balances[index + 1]?.value ?? null,
        rawBalance: null,
        status: balances[index + 1] ? ('AVAILABLE' as const) : ('UNAVAILABLE' as const),
      }));
      return [nativeBalance, tokenBalances];
    } catch (_error) {
      return Promise.all([
        this.getNativeBalance(target),
        Promise.all(tokenContracts.map((contract) => this.getTokenBalance(target, contract))),
      ]);
    }
  }

  private async getTokenBalance(target: OnChainBalanceTarget, contract: OnChainTokenContract) {
    if (!contract.address) {
      return null;
    }
    try {
      const balance = await this.rpcProvider.getBalance(
        target.address,
        contract.address,
        target.networkKey,
        contract.decimals,
      );
      return {
        asset: {
          id: contract.asset.id,
          symbol: contract.asset.symbol,
          name: contract.asset.name,
          iconUrl: contract.asset.iconUrl,
          type: contract.asset.type,
          chain: target.chain,
          decimals: contract.asset.decimals,
          tokenStandard: contract.standard,
          tokenAddress: contract.address,
        },
        balance: balance.value,
        rawBalance: null,
        status: 'AVAILABLE',
      };
    } catch (_error) {
      return {
        asset: {
          id: contract.asset.id,
          symbol: contract.asset.symbol,
          name: contract.asset.name,
          iconUrl: contract.asset.iconUrl,
          type: contract.asset.type,
          chain: target.chain,
          decimals: contract.asset.decimals,
          tokenStandard: contract.standard,
          tokenAddress: contract.address,
        },
        balance: null,
        rawBalance: null,
        status: 'UNAVAILABLE',
      };
    }
  }

  private async getNonEvmBalance(
    target: OnChainBalanceTarget,
    contract: OnChainTokenContract,
    network: Network,
  ) {
    const asset = {
      id: contract.asset.id,
      symbol: contract.asset.symbol,
      name: contract.asset.name,
      iconUrl: contract.asset.iconUrl,
      type: contract.asset.type,
      chain: target.chain,
      decimals: contract.asset.decimals,
      tokenStandard: contract.standard,
      tokenAddress: contract.address,
    };
    try {
      const result = await this.nonEvm.getBalance({
        network,
        tokenContract: {
          standard: contract.standard as TokenStandard,
          address: contract.address,
          decimals: contract.decimals,
        },
        address: target.address,
      });
      return {
        asset,
        balance: result.balance,
        rawBalance: result.rawBalance,
        status: result.status,
      };
    } catch (error) {
      this.logger.warn(
        `Non-EVM balance unavailable for ${network.chainKey}/${contract.asset.symbol}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return {
        asset,
        balance: null,
        rawBalance: null,
        status: 'UNAVAILABLE' as const,
      };
    }
  }
}
