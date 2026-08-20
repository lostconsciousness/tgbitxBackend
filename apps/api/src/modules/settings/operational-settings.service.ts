import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class OperationalSettingsService {
  private static readonly permanentlyDisabledPauseKeys = new Set(['trading:paused']);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getBoolean(key: string, envKey: string, fallback = false): Promise<boolean> {
    if (OperationalSettingsService.permanentlyDisabledPauseKeys.has(key)) {
      return false;
    }
    const setting = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (typeof setting?.value === 'boolean') {
      return setting.value;
    }
    return this.config.get<boolean>(envKey, fallback);
  }

  setBoolean(key: string, value: boolean) {
    if (OperationalSettingsService.permanentlyDisabledPauseKeys.has(key)) {
      value = false;
    }
    return this.prisma.systemSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  async getDecimalsByPrefix(prefix: string): Promise<Map<string, Prisma.Decimal>> {
    const settings = await this.prisma.systemSetting.findMany({
      where: { key: { startsWith: prefix } },
    });
    return new Map(
      settings.map((setting) => {
        const raw = setting.value;
        if (typeof raw !== 'string' && typeof raw !== 'number') {
          throw new Error(`Operational setting ${setting.key} must contain a decimal string`);
        }
        return [setting.key.slice(prefix.length), new Prisma.Decimal(raw)];
      }),
    );
  }

  setDecimal(key: string, value: Prisma.Decimal.Value) {
    const normalized = new Prisma.Decimal(value).toString();
    return this.prisma.systemSetting.upsert({
      where: { key },
      update: { value: normalized },
      create: { key, value: normalized },
    });
  }
}
