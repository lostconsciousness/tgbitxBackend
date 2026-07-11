import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AssetsService } from '../src/modules/assets/assets.service';
import { AssetsModule } from '../src/modules/assets/assets.module';
import { DatabaseModule } from '../src/database/database.module';

type Mode = 'verify' | 'enable';

type Options = {
  scope?: string;
  networks: string[];
  assetSymbols: string[];
  standards: string[];
  dryRun: boolean;
  deposits?: boolean;
  withdrawals?: boolean;
};

const mode = parseMode(process.argv[2]);
const options = mergeEnvOptions(parseArgs(process.argv.slice(3)));
const apiUrl = process.env.ASSETS_BULK_API_URL ?? process.env.E2E_API_URL ?? 'http://localhost:3000';
const useHttp = parseBoolean(process.env.ASSETS_BULK_USE_HTTP);

const path =
  mode === 'verify'
    ? '/admin/assets/bulk-verify'
    : '/admin/assets/bulk-enable-transfers';

const body = {
  scope: options.scope ?? 'testnet',
  ...(options.networks.length ? { networks: options.networks } : {}),
  ...(options.assetSymbols.length ? { assetSymbols: options.assetSymbols } : {}),
  ...(options.standards.length ? { standards: options.standards } : {}),
  dryRun: options.dryRun,
  ...(mode === 'enable'
    ? {
        deposits: options.deposits ?? true,
        withdrawals: options.withdrawals ?? false,
      }
    : {}),
};

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: ['apps/api/.env', '.env', '../../.env'],
      isGlobal: true,
    }),
    DatabaseModule,
    AssetsModule,
  ],
})
class BulkAssetsCliModule {}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const result = useHttp
    ? await post(path, body)
    : await runDirect(mode, body);
  console.log(JSON.stringify(result, null, 2));
}

async function runDirect(selectedMode: Mode, payload: Record<string, unknown>) {
  const app = await NestFactory.createApplicationContext(BulkAssetsCliModule, {
    logger: ['error', 'warn'],
  });
  try {
    const assets = app.get(AssetsService);
    return selectedMode === 'verify'
      ? assets.bulkVerify(payload)
      : assets.bulkEnableTransfers(payload);
  } finally {
    await app.close();
  }
}

async function post(pathname: string, payload: Record<string, unknown>) {
  const adminToken = process.env.ASSETS_BULK_ADMIN_TOKEN ?? process.env.E2E_ADMIN_ACCESS_TOKEN;
  if (!adminToken) {
    throw new Error('Set ASSETS_BULK_ADMIN_TOKEN or E2E_ADMIN_ACCESS_TOKEN for HTTP mode');
  }
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${pathname}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(
      `Could not connect to ${apiUrl}${pathname}${cause}. Start the API server or unset ASSETS_BULK_USE_HTTP to use direct mode.`,
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${pathname}: ${JSON.stringify(data)}`);
  }
  return data;
}

function parseMode(value: string | undefined): Mode {
  if (value === 'verify' || value === 'enable') {
    return value;
  }
  throw new Error('Usage: ts-node scripts/bulk-assets.ts <verify|enable> [--scope testnet]');
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    networks: [],
    assetSymbols: [],
    standards: [],
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    switch (arg) {
      case '--scope':
        options.scope = requireValue(arg, next);
        index += 1;
        break;
      case '--network':
      case '--networks':
        options.networks.push(...splitList(requireValue(arg, next)));
        index += 1;
        break;
      case '--asset':
      case '--assets':
      case '--asset-symbol':
      case '--asset-symbols':
        options.assetSymbols.push(...splitList(requireValue(arg, next)).map((value) => value.toUpperCase()));
        index += 1;
        break;
      case '--standard':
      case '--standards':
        options.standards.push(...splitList(requireValue(arg, next)).map((value) => value.toUpperCase()));
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--deposits':
        options.deposits = true;
        break;
      case '--no-deposits':
        options.deposits = false;
        break;
      case '--withdrawals':
        options.withdrawals = true;
        break;
      case '--no-withdrawals':
        options.withdrawals = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function mergeEnvOptions(options: Options): Options {
  return {
    scope: options.scope ?? process.env.ASSETS_BULK_SCOPE,
    networks: options.networks.length
      ? options.networks
      : splitEnvList(process.env.ASSETS_BULK_NETWORKS),
    assetSymbols: options.assetSymbols.length
      ? options.assetSymbols
      : splitEnvList(process.env.ASSETS_BULK_ASSETS).map((value) => value.toUpperCase()),
    standards: options.standards.length
      ? options.standards
      : splitEnvList(process.env.ASSETS_BULK_STANDARDS).map((value) => value.toUpperCase()),
    dryRun: options.dryRun || parseBoolean(process.env.ASSETS_BULK_DRY_RUN),
    deposits: options.deposits ?? parseOptionalBoolean(process.env.ASSETS_BULK_DEPOSITS),
    withdrawals: options.withdrawals ?? parseOptionalBoolean(process.env.ASSETS_BULK_WITHDRAWALS),
  };
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitEnvList(value: string | undefined): string[] {
  return value ? splitList(value) : [];
}

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseBoolean(value);
}
