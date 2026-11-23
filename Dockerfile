FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:shared && chown -R node:node /app/apps

FROM base AS release
RUN npm run build && chown -R node:node /app/apps
USER node
CMD ["node", "apps/api/dist/main.js"]

FROM base AS development
USER node
CMD ["npm", "run", "dev", "-w", "@ado/api"]
