FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN npm run prisma:generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
