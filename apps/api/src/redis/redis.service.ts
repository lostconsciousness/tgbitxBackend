import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private client?: Redis;

  constructor(private readonly config: ConfigService) {}

  getClient(): Redis {
    if (!this.client) {
      this.client = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
    }

    return this.client;
  }

  async connect(): Promise<void> {
    const client = this.getClient();
    if (client.status === 'wait') {
      await client.connect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }
}
