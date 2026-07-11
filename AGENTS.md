\# AGENTS.md



\## Project



This repository is a crypto exchange backend/frontend project.



Main priorities:

\- Security first.

\- Never expose private keys, mnemonics, WIFs, API keys, JWT secrets, RPC credentials, or `.env` values.

\- Never commit `.env`, wallet JSON files, private key files, seed phrases, or generated hot wallet files.

\- Treat all withdrawal, custody, signing, and balance logic as high-risk code.



\## How to work in this repo



Before editing:

\- Inspect the relevant files first.

\- Do not rewrite unrelated modules.

\- Prefer minimal targeted patches.

\- Do not change public APIs, database schemas, Prisma migrations, or env variable names unless the task explicitly requires it.

\- If a task is ambiguous, ask a short clarifying question before making large changes.



\## Token-saving rules



\- Do not read huge/generated folders unless explicitly needed:

&#x20; - node\_modules/

&#x20; - dist/

&#x20; - build/

&#x20; - .next/

&#x20; - coverage/

&#x20; - .git/

&#x20; - logs/

&#x20; - tmp/

\- Prefer `rg`/`grep` searches over opening many files.

\- Start by reading package.json, relevant route/service files, and nearby tests only.

\- Summarize findings briefly before editing.

\- Keep final answers concise: changed files, why, tests run, remaining risks.



\## Commands



Use the package manager already used by the repo. Do not switch npm/yarn/pnpm unless asked.



Common commands:

\- Install: npm install

\- Lint: npm run lint

\- Test: npm test

\- Typecheck: npm run typecheck

\- API dev: npm run dev



If a command is missing, inspect package.json and use the closest available script.



\## Crypto/network rules



Never confuse:

\- BITCOIN\_SIGNET with Bitcoin mainnet.

\- TRON\_NILE with TRON mainnet.

\- SOLANA\_DEVNET with Solana mainnet-beta.

\- EVM networks with non-EVM networks.



For testnet smoke:

\- Solana Devnet uses devnet SOL only.

\- Bitcoin Signet uses signet BTC only.

\- TRON Nile uses Nile TRX and optional Nile TRC20 tokens.



Withdrawal code must:

\- Validate network before signing.

\- Check hot wallet balance before broadcast.

\- Use idempotency keys for withdrawal attempts.

\- Store tx hash/signature after broadcast.

\- Handle confirmation polling separately from broadcast.

\- Never log private keys or raw secrets.



\## Env/secrets



Required local env files may exist, but Codex must never print full secret values.



Allowed to show:

\- variable names

\- masked values like `abc...xyz`

\- testnet public addresses



Not allowed to show:

\- private keys

\- WIF

\- mnemonic

\- full RPC URL if it contains credentials

\- JWT/database/password secrets



\## Database



Before changing schema:

\- inspect existing schema/migrations

\- explain the migration impact

\- avoid destructive migrations unless explicitly requested



\## Testing



After code changes:

\- run the narrowest relevant test first

\- then run lint/typecheck if available

\- if tests cannot run, explain why and what command should be run manually



\## Output format



When done, respond with:

1\. What changed

2\. Files changed

3\. Tests/checks run

4\. Any risks or manual follow-up

