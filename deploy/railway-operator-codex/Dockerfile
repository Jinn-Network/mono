# Railway operator-codex deploy image.
#
# Derived from client/Dockerfile (build + runtime stages identical), with two
# additions for headless Railway operation:
#   1. @openai/codex CLI installed globally so the codex harness can spawn it.
#   2. Entrypoint wrapper that materialises CODEX_AUTH_JSON + CONFIG_TEMPLATE_JSON
#      from env into the persistent volume at /data on each restart.
#
# Build context is expected to be the monorepo root (the build copies from
# `client/` and `packages/sdk/`).

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build

ARG JINN_BUILD_COMMIT=unknown
ENV JINN_BUILD_COMMIT=$JINN_BUILD_COMMIT

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY client/package.json client/yarn.lock client/.yarnrc.yml ./client/
COPY client/src/dashboard/spa/package.json ./client/src/dashboard/spa/package.json
COPY packages/sdk/package.json packages/sdk/yarn.lock packages/sdk/README.md ./packages/sdk/
RUN corepack enable && cd client && yarn install --immutable

COPY packages/sdk/tsconfig.json ./packages/sdk/
COPY packages/sdk/src/ ./packages/sdk/src/

COPY client/src/ ./client/src/
COPY client/deployments/ ./client/deployments/
COPY client/docs/ ./client/docs/
COPY client/plugins/ ./client/plugins/
COPY client/scripts/ ./client/scripts/
COPY client/templates/ ./client/templates/
COPY client/tsconfig.json ./client/

WORKDIR /app/client
RUN yarn build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

ARG JINN_BUILD_COMMIT=unknown
ENV JINN_BUILD_COMMIT=$JINN_BUILD_COMMIT

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Codex CLI for the codex harness. Pinned to the version verified locally.
RUN npm install -g @openai/codex@0.133.0

COPY --from=build /app/client/dist dist/
COPY --from=build /app/client/deployments deployments/
COPY --from=build /app/client/plugins plugins/
COPY --from=build /app/client/node_modules node_modules/
COPY --from=build /app/client/package.json ./

# Defaults: durable state on the Railway volume mounted at /data.
ENV NODE_ENV=production
ENV JINN_EARNING_DIR=/data/earning
ENV JINN_DB_PATH=/data/jinn.db
ENV CODEX_HOME=/data/codex-home
ENV JINN_CONFIG=/data/config.json
ENV JINN_NETWORK=testnet
ENV JINN_AUTO_TESTNET_FAUCET=1

EXPOSE 7331
# NOTE: no `VOLUME ["/data"]` here — Railway rejects the Dockerfile directive.
# The persistent /data volume is attached at the service level via
# `railway volume add --mount-path /data`.

COPY deploy/railway-operator-codex/entrypoint.sh /usr/local/bin/jinn-operator-entrypoint.sh
RUN chmod +x /usr/local/bin/jinn-operator-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/jinn-operator-entrypoint.sh"]
CMD ["run", "--config", "/data/config.json"]
