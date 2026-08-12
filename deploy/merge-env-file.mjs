import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

const [target, source, ...keys] = process.argv.slice(2);
if (!target || !source || keys.length === 0) {
  throw new Error('Usage: node merge-env-file.mjs <target> <source> KEY [...]');
}

const validKey = /^[A-Z][A-Z0-9_]*$/;
const sourceValues = parseEnv(readFileSync(source, 'utf8'));
let contents = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

for (const key of keys) {
  if (!validKey.test(key)) throw new Error(`Unsafe environment key: ${key}`);
  const value = sourceValues.get(key);
  if (!value) throw new Error(`Missing or empty source value: ${key}`);
  if (/[\r\n]/.test(value)) throw new Error(`Multiline values are not supported: ${key}`);

  const line = `${key}=${value}`;
  const matcher = new RegExp(`^${key}=.*$`, 'gm');
  contents = matcher.test(contents)
    ? contents.replace(matcher, line)
    : `${contents.replace(/\s*$/, '\n')}${line}\n`;
}

const temporary = `${target}.tmp`;
const mode = statSync(target).mode;
writeFileSync(temporary, contents, { encoding: 'utf8', mode });
renameSync(temporary, target);
console.log(JSON.stringify({ merged: keys, target }));

function parseEnv(contents) {
  const values = new Map();
  for (const rawLine of contents.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7) : line;
    const separator = normalized.indexOf('=');
    if (separator < 1) continue;
    const key = normalized.slice(0, separator).trim();
    if (!validKey.test(key)) continue;
    values.set(key, normalized.slice(separator + 1).trim());
  }
  return values;
}
