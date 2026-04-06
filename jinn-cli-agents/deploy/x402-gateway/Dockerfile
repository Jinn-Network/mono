# Build context: monorepo root
# docker build -f deploy/x402-gateway/Dockerfile .

# =============================================================================
# Stage 1: Build
# =============================================================================
FROM node:22-slim AS builder

WORKDIR /app

# Build tools for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first for layer caching
COPY package.json yarn.lock ./
COPY jinn-node/package.json jinn-node/yarn.lock ./jinn-node/

# Install all dependencies (including devDeps for building)
# postinstall hook runs `cd jinn-node && yarn install` automatically
RUN yarn install --frozen-lockfile --production=false

# Copy jinn-node source and build it
COPY jinn-node/src/ ./jinn-node/src/
COPY jinn-node/tsconfig.json jinn-node/tsconfig.build.json ./jinn-node/
RUN cd jinn-node && yarn build

# Symlink for package resolution (jinn-node is not a workspace)
RUN ln -sf /app/jinn-node /app/node_modules/jinn-node

# Prune devDependencies for a leaner runtime image
RUN rm -rf node_modules && yarn install --frozen-lockfile --production \
    && cd jinn-node && rm -rf node_modules && yarn install --frozen-lockfile --production

# =============================================================================
# Stage 2: Runtime
# =============================================================================
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Install tsx globally for runtime TypeScript execution
RUN npm install -g tsx

# Create non-root user
RUN groupadd -r jinn && useradd -r -g jinn -m -d /home/jinn -s /bin/bash jinn

WORKDIR /app

# Copy production dependencies from builder
COPY --chown=jinn:jinn --from=builder /app/node_modules/ ./node_modules/
COPY --chown=jinn:jinn --from=builder /app/package.json ./

# Copy built jinn-node (dist + package.json for exports map)
COPY --chown=jinn:jinn --from=builder /app/jinn-node/dist/ ./jinn-node/dist/
COPY --chown=jinn:jinn --from=builder /app/jinn-node/package.json ./jinn-node/
COPY --chown=jinn:jinn --from=builder /app/jinn-node/node_modules/ ./jinn-node/node_modules/

# Recreate symlink for package resolution
RUN ln -sf /app/jinn-node /app/node_modules/jinn-node

# Copy service source
COPY --chown=jinn:jinn services/x402-gateway/index.ts services/x402-gateway/discovery.ts \
     services/x402-gateway/output-spec.ts services/x402-gateway/pricing.ts \
     services/x402-gateway/tsconfig.json \
     ./services/x402-gateway/
COPY --chown=jinn:jinn services/x402-gateway/credentials/ ./services/x402-gateway/credentials/
COPY --chown=jinn:jinn services/x402-gateway/provisioning/ ./services/x402-gateway/provisioning/

# Copy all shared scripts (imported by provisioning modules via relative path)
COPY --chown=jinn:jinn scripts/shared/ ./scripts/shared/

ENV NODE_ENV=production

EXPOSE 3001

USER jinn

CMD ["dumb-init", "--", "tsx", "services/x402-gateway/index.ts"]
