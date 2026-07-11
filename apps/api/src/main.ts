import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { MarketDataService } from './modules/market-data/market-data.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');
  const onchainChainId = config.get<number>('ONCHAIN_CHAIN_ID', 421614);
  const mainnetChainIds = new Set([
    1, 10, 56, 137, 324, 5000, 8453, 42161, 42220, 43114, 59144, 534352,
  ]);
  if (mainnetChainIds.has(onchainChainId) && !config.get<boolean>('MAINNET_ENABLED', false)) {
    throw new Error(
      'Mainnet is blocked. Set MAINNET_ENABLED=true only after explicit production approval.',
    );
  }
  if (
    !config.get<boolean>('HYPERLIQUID_TESTNET', true) &&
    !config.get<boolean>('MAINNET_ENABLED', false)
  ) {
    throw new Error(
      'Hyperliquid mainnet is blocked until MAINNET_ENABLED=true is explicitly approved.',
    );
  }

  const corsOrigins = uniqueOrigins([
    ...parseCorsOrigins(config.get<string>('CORS_ORIGINS')),
    ...readCorsOriginsFromEnvFiles(),
  ]);

  app.use(helmet());
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('etag', false);
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || corsOrigins.includes('*') || corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      logger.warn(`Blocked CORS origin: ${origin}`);
      callback(null, false);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    optionsSuccessStatus: 204,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Dream Crypto Exchange API')
    .setDescription('Backend-only API for the Dream Crypto Exchange MVP.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  configureMarketDataSocket(app.getHttpServer(), app.get(MarketDataService), corsOrigins);
  logger.log(`API listening on http://localhost:${port}`);
  logger.log(`Swagger available at http://localhost:${port}/docs`);
  logger.log(`CORS origins: ${corsOrigins.join(', ')}`);
}

function configureMarketDataSocket(
  httpServer: HttpServer,
  marketDataService: MarketDataService,
  corsOrigins: string[],
): void {
  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigins.includes('*') ? true : corsOrigins,
      credentials: true,
    },
  });
  const marketData = io.of('/market-data');

  marketData.on('connection', (socket: Socket) => {
    const subscriptions = new Map<string, () => void>();

    socket.on('subscribeOrderbook', async (payload: { symbol?: string }, acknowledge?) => {
      const symbol = payload?.symbol?.trim().toUpperCase();
      if (!symbol) {
        acknowledge?.({ ok: false, error: 'symbol is required' });
        return;
      }
      if (subscriptions.has(symbol)) {
        acknowledge?.({ ok: true, symbol });
        return;
      }
      try {
        const unsubscribe = await marketDataService.subscribeOrderBook({
          symbol,
          onSnapshot: (snapshot) => socket.emit('orderbook', snapshot),
        });
        subscriptions.set(symbol, unsubscribe);
        acknowledge?.({ ok: true, symbol });
      } catch (error) {
        acknowledge?.({
          ok: false,
          symbol,
          error: error instanceof Error ? error.message : 'Failed to subscribe orderbook',
        });
      }
    });

    socket.on('unsubscribeOrderbook', (payload: { symbol?: string }, acknowledge?) => {
      const symbol = payload?.symbol?.trim().toUpperCase();
      if (!symbol) {
        acknowledge?.({ ok: false });
        return;
      }
      subscriptions.get(symbol)?.();
      subscriptions.delete(symbol);
      acknowledge?.({ ok: true, symbol });
    });

    socket.on('disconnect', () => {
      subscriptions.forEach((unsubscribe) => unsubscribe());
      subscriptions.clear();
    });
  });
}

function parseCorsOrigins(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function readCorsOriginsFromEnvFiles(): string[] {
  const candidates = uniqueOrigins([
    ...envFileCandidates(process.cwd()),
    ...envFileCandidates(__dirname),
  ]);
  const origins: string[] = [];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) {
      continue;
    }

    const match = readFileSync(filePath, 'utf8').match(/^CORS_ORIGINS=(.*)$/m);
    if (match?.[1]) {
      origins.push(...parseCorsOrigins(match[1]));
    }
  }

  return uniqueOrigins(origins);
}

function envFileCandidates(startPath: string): string[] {
  const candidates: string[] = [];
  let current = resolve(startPath);

  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(current, '.env'));
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return candidates;
}

function uniqueOrigins(origins: string[]): string[] {
  return [...new Set(origins)];
}

void bootstrap();
