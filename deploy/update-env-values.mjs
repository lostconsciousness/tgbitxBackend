import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

const [target, ...assignments] = process.argv.slice(2);
if (!target || assignments.length === 0) {
  throw new Error('Usage: node update-env-values.mjs <env-file> KEY=VALUE [...]');
}

let contents = readFileSync(target, 'utf8');
for (const assignment of assignments) {
  const separator = assignment.indexOf('=');
  if (separator < 1) throw new Error(`Invalid assignment: ${assignment}`);
  const key = assignment.slice(0, separator);
  const value = assignment.slice(separator + 1);
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) {
    throw new Error(`Unsafe environment assignment: ${key}`);
  }
  const line = `${key}=${value}`;
  const matcher = new RegExp(`^${key}=.*$`, 'm');
  contents = matcher.test(contents)
    ? contents.replace(matcher, line)
    : `${contents.replace(/\s*$/, '\n')}${line}\n`;
}

const temporary = `${target}.tmp`;
const mode = statSync(target).mode;
writeFileSync(temporary, contents, { encoding: 'utf8', mode });
renameSync(temporary, target);
