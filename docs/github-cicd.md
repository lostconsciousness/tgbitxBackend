# GitHub CI/CD

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

1. `npm ci` on Node.js 22;
2. Prisma client generation;
3. all Jest unit tests;
4. NestJS production build;
5. production Docker image build.

Production `.env` files, backups, wallet JSON files and generated key material are
excluded from Git and from deployment synchronization.

## Production CD

Production deployment is intentionally manual and protected by the GitHub
`production` environment. Run **Deploy backend to production** from the Actions
tab and select the Git ref after CI is green.

The repository must have these Actions secrets:

- `PRODUCTION_HOST` — production host name or IP;
- `PRODUCTION_USER` — SSH user allowed to update `/opt/tgbitx/backend` and run Docker;
- `PRODUCTION_SSH_KEY` — dedicated deploy private key, not a developer's personal key;
- `PRODUCTION_SSH_KNOWN_HOSTS` — pinned `ssh-keyscan` output for the production host.

The deployment workflow:

1. uploads source with `rsync`, preserving production env and backups;
2. creates a PostgreSQL backup;
3. builds the API image;
4. applies Prisma migrations;
5. replaces only the API container;
6. verifies `GET /health/ready`.

Keep manual approval enabled for the `production` GitHub environment because the
service controls custody, withdrawals and trading. Automatic deployment on every
push should only be enabled after at least several successful manual releases.
