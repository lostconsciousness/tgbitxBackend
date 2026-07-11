import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
}
