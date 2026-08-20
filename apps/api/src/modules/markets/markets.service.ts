import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';

@Injectable()
export class MarketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assetsService: AssetsService,
    private readonly config: ConfigService,
  ) {}

  async list() {
    const markets = await this.prisma.market.findMany({
      where: { status: 'ACTIVE' },
      include: { baseAsset: true, quoteAsset: true, riskConfig: true, feeConfig: true },
      orderBy: { symbol: 'asc' },
    });
    return markets.map((market) => this.withTradingLimits(market));
  }

  async getBySymbol(symbol: string) {
    const market = await this.prisma.market.findUnique({
      where: { symbol: symbol.toUpperCase() },
      include: { baseAsset: true, quoteAsset: true, riskConfig: true, feeConfig: true },
    });

    if (!market) {
      throw new NotFoundException('Market not found');
    }

    return this.withTradingLimits(market);
  }

  private withTradingLimits<T extends { riskConfig: { maxLeverage: number } | null; feeConfig: { takerFeeBps: number } | null }>(market: T) {
    const pilotMaxLeverage = this.config.get<number>('PERP_MAX_LEVERAGE', 10);
    return {
      ...market,
      maxLeverage: Math.min(market.riskConfig?.maxLeverage ?? 1, pilotMaxLeverage),
      takerFeeBps: market.feeConfig?.takerFeeBps ?? 5,
    };
  }

  async create(dto: CreateMarketDto) {
    const [baseAsset, quoteAsset] = await Promise.all([
      this.assetsService.getBySymbol(dto.baseAssetSymbol),
      this.assetsService.getBySymbol(dto.quoteAssetSymbol),
    ]);

    return this.prisma.market.create({
      data: {
        symbol: dto.symbol.toUpperCase(),
        type: dto.type,
        status: dto.status,
        providerName: dto.providerName,
        providerSymbol: dto.providerSymbol,
        tradingViewSymbol: dto.tradingViewSymbol,
        orderbookEnabled: dto.orderbookEnabled,
        baseAssetId: baseAsset.id,
        quoteAssetId: quoteAsset.id,
        pricePrecision: dto.pricePrecision,
        sizePrecision: dto.sizePrecision,
        minOrderSize: dto.minOrderSize ? new Prisma.Decimal(dto.minOrderSize) : undefined,
      },
      include: { baseAsset: true, quoteAsset: true },
    });
  }

  async update(symbol: string, dto: UpdateMarketDto) {
    await this.getBySymbol(symbol);
    return this.prisma.market.update({
      where: { symbol: symbol.toUpperCase() },
      data: {
        status: dto.status,
        providerName: dto.providerName,
        providerSymbol: dto.providerSymbol,
        tradingViewSymbol: dto.tradingViewSymbol,
        orderbookEnabled: dto.orderbookEnabled,
      },
      include: { baseAsset: true, quoteAsset: true },
    });
  }
}
