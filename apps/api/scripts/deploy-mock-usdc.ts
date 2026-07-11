import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, getAddress, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type Artifact = {
  abi?: unknown[];
  bytecode?: string | { object?: string };
};

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '../../.env'));

const network = required('MOCK_USDC_NETWORK');
const rpcUrl = process.env.MOCK_USDC_RPC_URL || rpcUrlForNetwork(network);
const privateKey = required('MOCK_USDC_DEPLOYER_PRIVATE_KEY') as `0x${string}`;
const initialHolder = getAddress(process.env.MOCK_USDC_INITIAL_HOLDER ?? accountAddress(privateKey));
const initialSupply = parseUnits(process.env.MOCK_USDC_INITIAL_SUPPLY ?? '1000000', 6);
const artifactPath = process.env.MOCK_USDC_ARTIFACT_PATH;
const bytecode = normalizeBytecode(
  process.env.MOCK_USDC_BYTECODE ??
    (artifactPath ? readArtifact(artifactPath).bytecode : undefined),
);

const abi = [
  {
    type: 'constructor',
    inputs: [
      { name: 'initialHolder', type: 'address' },
      { name: 'initialSupply', type: 'uint256' },
    ],
  },
] as const;

async function main(): Promise<void> {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    chain: null,
    args: [initialHolder, initialSupply],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error('Deployment receipt did not include contractAddress');
  }
  const envName = mockUsdcEnvName(network);
  console.log(
    JSON.stringify(
      {
        network,
        chainId,
        txHash: hash,
        contractAddress: receipt.contractAddress,
        env: `${envName}=${receipt.contractAddress}`,
        initialHolder,
        initialSupply: initialSupply.toString(),
      },
      null,
      2,
    ),
  );
}

function readArtifact(path: string): Artifact {
  return JSON.parse(readFileSync(path, 'utf8')) as Artifact;
}

function normalizeBytecode(value: Artifact['bytecode'] | undefined): `0x${string}` {
  const raw = typeof value === 'string' ? value : value?.object;
  if (!raw) {
    throw new Error('Set MOCK_USDC_BYTECODE or MOCK_USDC_ARTIFACT_PATH with compiled bytecode');
  }
  const bytecode = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode)) {
    throw new Error('Compiled MockUSDC bytecode is not valid hex');
  }
  return bytecode as `0x${string}`;
}

function rpcUrlForNetwork(chainKey: string): string {
  const envName = `${chainKey.toUpperCase().replace(/-/g, '_')}_RPC_PRIMARY_URL`;
  const value = process.env[envName];
  if (!value) {
    throw new Error(`Set MOCK_USDC_RPC_URL or ${envName}`);
  }
  return value;
}

function mockUsdcEnvName(chainKey: string): string {
  return `MOCK_USDC_${chainKey.toUpperCase().replace(/-/g, '_')}_ADDRESS`;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator < 1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function accountAddress(privateKey: `0x${string}`): string {
  return privateKeyToAccount(privateKey).address;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
