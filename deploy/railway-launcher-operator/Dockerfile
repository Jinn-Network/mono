# Railway launcher+operator deploy image (claude-code / Haiku).
#
# Hosts the operator's single jinn-run daemon that is BOTH the SWE-rebench v2
# launcher/generator (owns a launched record) AND a solver — one wallet, both
# roles (see docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md).
#
# Derived from client/Dockerfile. Differences:
#   - entrypoint wrapper materialises config + launched record (+ optional
#     one-shot state restore) from env onto the /data volume on each boot.
#   - no VOLUME directive (Railway rejects it; volume attached at service level).
#
# Build context MUST be the monorepo root (copies from client/ and packages/sdk/).

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

# Claude CLI for the claude-code harness. Pinned to the version verified in the
# Task 0 spike (env-only CLAUDE_CODE_OAUTH_TOKEN auth confirmed at this version).
RUN npm install -g @anthropic-ai/claude-code@2.1.159

# Auth is env-only (CLAUDE_CODE_OAUTH_TOKEN, verified in the Task 0 spike) — no
# claude.json persistence is needed. /root/.claude is created only so the
# entrypoint's commented-out file-fallback path has a directory to write to if a
# future CLI version ever stops honouring the env var.
RUN mkdir -p /root/.claude

COPY --from=build /app/client/dist dist/
COPY --from=build /app/client/deployments deployments/
COPY --from=build /app/client/plugins plugins/
COPY --from=build /app/client/node_modules node_modules/
COPY --from=build /app/client/package.json ./

# Durable state on the Railway volume at /data.
ENV NODE_ENV=production
ENV JINN_EARNING_DIR=/data/earning
ENV JINN_DB_PATH=/data/jinn.db
ENV JINN_CONFIG=/data/config.json
# Generator state + validated-pool artifact MUST live on the volume. The default
# is $HOME/.jinn-client/swe-rebench-v2 (= /root/...), which is off-volume and
# wiped on every restart — and the validated pool has no IPFS fetch fallback, so
# an unseeded/ephemeral state dir means the generator posts ZERO tasks.
ENV JINN_SWE_REBENCH_V2_STATE_DIR=/data/swe-rebench-v2
ENV JINN_NETWORK=testnet
ENV JINN_AUTO_TESTNET_FAUCET=1

EXPOSE 7331
# NOTE: no `VOLUME ["/data"]` — Railway rejects the Dockerfile directive.
# Attach the /data volume at the service level (railway volume add --mount-path /data).

COPY deploy/railway-launcher-operator/entrypoint.sh /usr/local/bin/jinn-launcher-operator-entrypoint.sh
RUN chmod +x /usr/local/bin/jinn-launcher-operator-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/jinn-launcher-operator-entrypoint.sh"]
CMD ["run", "--config", "/data/config.json"]
