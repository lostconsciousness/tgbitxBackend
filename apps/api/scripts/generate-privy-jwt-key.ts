import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
if (!existsSync(envPath)) {
  throw new Error(`Environment file was not found: ${envPath}`);
}

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
});

const encodedPrivateKey = Buffer.from(privateKey, 'utf8').toString('base64');
const current = readFileSync(envPath, 'utf8');
const keyLine = `PRIVY_JWT_PRIVATE_KEY_BASE64=${encodedPrivateKey}`;
const updated = /^PRIVY_JWT_PRIVATE_KEY_BASE64=.*$/m.test(current)
  ? current.replace(/^PRIVY_JWT_PRIVATE_KEY_BASE64=.*$/m, keyLine)
  : `${current.trimEnd()}\n${keyLine}\n`;

writeFileSync(envPath, updated, { encoding: 'utf8', mode: 0o600 });

console.log('Generated an RSA-2048 PKCS8 key for Privy JWT authentication.');
console.log('Private key written only to apps/api/.env as PRIVY_JWT_PRIVATE_KEY_BASE64.');
console.log('No PEM files were created and the private key was not printed.');
console.log('Restart the backend, then open /.well-known/jwks.json.');
