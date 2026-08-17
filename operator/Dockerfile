# @jinn-network/client — OCI image
#
# Build from the repository root:
#   docker build -f operator/Dockerfile -t jinn-client .
#
# Run:
#   docker run -e JINN_PASSWORD=secret jinn-client run
#   docker run jinn-client version --json
#   docker run jinn-client doctor --json

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build

ARG JINN_BUILD_COMMIT=unknown
ENV JINN_BUILD_COMMIT=$JINN_BUILD_COMMIT

WORKDIR /app

# Install build essentials for native addons (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first for layer caching. The client resolves the
# mono checkout's SDK, core, plugin, and layer packages through Yarn portals,
# so Docker builds use the repository root as their build context.
COPY operator/package.json operator/yarn.lock operator/.yarnrc.yml ./operator/
COPY packages/sdk/package.json packages/sdk/yarn.lock packages/sdk/.yarnrc.yml packages/sdk/README.md ./packages/sdk/
COPY packages/core/package.json packages/core/yarn.lock packages/core/.yarnrc.yml ./packages/core/
COPY packages/plugin/package.json packages/plugin/yarn.lock packages/plugin/.yarnrc.yml packages/plugin/process-contract.json ./packages/plugin/
COPY packages/layer/package.json packages/layer/yarn.lock packages/layer/.yarnrc.yml ./packages/layer/
# Composition-stack portal manifests (cutover stage 1). The operator daemon resolves the
# merged marketplace / task-execution / evidence / discovery / trust trees through Yarn
# portals, so every one of their manifests must land before `yarn install --immutable`.
COPY packages/evidence/protocol/package.json packages/evidence/protocol/yarn.lock packages/evidence/protocol/.yarnrc.yml ./packages/evidence/protocol/
COPY packages/evidence/repository/package.json packages/evidence/repository/yarn.lock packages/evidence/repository/.yarnrc.yml ./packages/evidence/repository/
COPY packages/evidence/discovery/package.json packages/evidence/discovery/yarn.lock packages/evidence/discovery/.yarnrc.yml ./packages/evidence/discovery/
COPY packages/evidence/catalog-sqlite/package.json packages/evidence/catalog-sqlite/yarn.lock packages/evidence/catalog-sqlite/.yarnrc.yml ./packages/evidence/catalog-sqlite/
COPY packages/evidence/local-runtime/package.json packages/evidence/local-runtime/yarn.lock packages/evidence/local-runtime/.yarnrc.yml ./packages/evidence/local-runtime/
COPY packages/evidence/execution-evidence-builder/package.json packages/evidence/execution-evidence-builder/yarn.lock packages/evidence/execution-evidence-builder/.yarnrc.yml ./packages/evidence/execution-evidence-builder/
COPY packages/evidence/execution-recorder/package.json packages/evidence/execution-recorder/yarn.lock packages/evidence/execution-recorder/.yarnrc.yml ./packages/evidence/execution-recorder/
COPY packages/evidence/attestation-issuer/package.json packages/evidence/attestation-issuer/yarn.lock packages/evidence/attestation-issuer/.yarnrc.yml ./packages/evidence/attestation-issuer/
COPY packages/task-execution/protocol/package.json packages/task-execution/protocol/yarn.lock packages/task-execution/protocol/.yarnrc.yml ./packages/task-execution/protocol/
COPY packages/task-execution/backend/package.json packages/task-execution/backend/yarn.lock packages/task-execution/backend/.yarnrc.yml ./packages/task-execution/backend/
COPY packages/task-execution/profiles/package.json packages/task-execution/profiles/yarn.lock packages/task-execution/profiles/.yarnrc.yml ./packages/task-execution/profiles/
COPY packages/trust/core/package.json packages/trust/core/yarn.lock packages/trust/core/.yarnrc.yml ./packages/trust/core/
COPY packages/trust/authoring/package.json packages/trust/authoring/yarn.lock packages/trust/authoring/.yarnrc.yml ./packages/trust/authoring/
COPY packages/trust/resolve/package.json packages/trust/resolve/yarn.lock packages/trust/resolve/.yarnrc.yml ./packages/trust/resolve/
COPY packages/environments/record/package.json packages/environments/record/yarn.lock packages/environments/record/.yarnrc.yml ./packages/environments/record/
COPY packages/task-supply/admission/package.json packages/task-supply/admission/yarn.lock packages/task-supply/admission/.yarnrc.yml ./packages/task-supply/admission/
COPY packages/marketplace/binding/package.json packages/marketplace/binding/yarn.lock packages/marketplace/binding/.yarnrc.yml ./packages/marketplace/binding/
COPY packages/task-execution/backend-local/supervisor/package.json packages/task-execution/backend-local/supervisor/yarn.lock packages/task-execution/backend-local/supervisor/.yarnrc.yml ./packages/task-execution/backend-local/supervisor/
COPY packages/task-execution/backend-local/workspace/package.json packages/task-execution/backend-local/workspace/yarn.lock packages/task-execution/backend-local/workspace/.yarnrc.yml ./packages/task-execution/backend-local/workspace/
COPY packages/task-execution/backend-local/launchers/package.json packages/task-execution/backend-local/launchers/yarn.lock packages/task-execution/backend-local/launchers/.yarnrc.yml ./packages/task-execution/backend-local/launchers/
COPY packages/task-execution/evaluation-harness/package.json packages/task-execution/evaluation-harness/yarn.lock packages/task-execution/evaluation-harness/.yarnrc.yml ./packages/task-execution/evaluation-harness/
COPY packages/task-execution/evaluator-adapters/package.json packages/task-execution/evaluator-adapters/yarn.lock packages/task-execution/evaluator-adapters/.yarnrc.yml ./packages/task-execution/evaluator-adapters/
COPY packages/task-execution/backend-local/assembly/package.json packages/task-execution/backend-local/assembly/yarn.lock packages/task-execution/backend-local/assembly/.yarnrc.yml ./packages/task-execution/backend-local/assembly/
COPY packages/marketplace/pipeline/package.json packages/marketplace/pipeline/yarn.lock packages/marketplace/pipeline/.yarnrc.yml ./packages/marketplace/pipeline/
COPY packages/discovery/protocol/package.json packages/discovery/protocol/yarn.lock packages/discovery/protocol/.yarnrc.yml ./packages/discovery/protocol/
COPY packages/policy/identity/package.json packages/policy/identity/yarn.lock packages/policy/identity/.yarnrc.yml ./packages/policy/identity/
COPY packages/discovery/serve/package.json packages/discovery/serve/yarn.lock packages/discovery/serve/.yarnrc.yml ./packages/discovery/serve/
COPY packages/marketplace/projector/package.json packages/marketplace/projector/yarn.lock packages/marketplace/projector/.yarnrc.yml ./packages/marketplace/projector/
COPY packages/marketplace/venue-base/package.json packages/marketplace/venue-base/yarn.lock packages/marketplace/venue-base/.yarnrc.yml ./packages/marketplace/venue-base/
COPY packages/discovery/client/package.json packages/discovery/client/yarn.lock packages/discovery/client/.yarnrc.yml ./packages/discovery/client/
COPY packages/discovery/facts/task-execution/package.json packages/discovery/facts/task-execution/yarn.lock packages/discovery/facts/task-execution/.yarnrc.yml ./packages/discovery/facts/task-execution/
COPY packages/discovery/transport-http/package.json packages/discovery/transport-http/yarn.lock packages/discovery/transport-http/.yarnrc.yml ./packages/discovery/transport-http/
COPY packages/discovery/testing/package.json packages/discovery/testing/yarn.lock packages/discovery/testing/.yarnrc.yml ./packages/discovery/testing/
RUN corepack enable && cd operator && yarn install --immutable

# Copy portal-package sources before the client build; `yarn build` builds them
# in dependency order before compiling the client.
COPY packages/sdk/tsconfig.json ./packages/sdk/
COPY packages/sdk/src/ ./packages/sdk/src/
COPY packages/sdk/fixtures/ ./packages/sdk/fixtures/
COPY packages/plugin/tsconfig.json ./packages/plugin/
COPY packages/plugin/src/ ./packages/plugin/src/
COPY packages/core/tsconfig.json ./packages/core/
COPY packages/core/src/ ./packages/core/src/
COPY packages/layer/tsconfig.json ./packages/layer/
COPY packages/layer/src/ ./packages/layer/src/

# Composition-stack portal sources, in dependency order; `yarn build:stack` compiles them
# before the client’s own `tsc` run.
COPY packages/evidence/protocol/tsconfig.json ./packages/evidence/protocol/
COPY packages/evidence/repository/tsconfig.json ./packages/evidence/repository/
COPY packages/evidence/discovery/tsconfig.json ./packages/evidence/discovery/
COPY packages/evidence/catalog-sqlite/tsconfig.json ./packages/evidence/catalog-sqlite/
COPY packages/evidence/local-runtime/tsconfig.json ./packages/evidence/local-runtime/
COPY packages/evidence/execution-evidence-builder/tsconfig.json packages/evidence/execution-evidence-builder/tsconfig.build.json ./packages/evidence/execution-evidence-builder/
COPY packages/evidence/execution-recorder/tsconfig.json ./packages/evidence/execution-recorder/
COPY packages/evidence/attestation-issuer/tsconfig.json ./packages/evidence/attestation-issuer/
COPY packages/task-execution/protocol/tsconfig.json ./packages/task-execution/protocol/
COPY packages/task-execution/backend/tsconfig.json ./packages/task-execution/backend/
COPY packages/task-execution/profiles/tsconfig.json ./packages/task-execution/profiles/
COPY packages/trust/core/tsconfig.json ./packages/trust/core/
COPY packages/trust/authoring/tsconfig.json ./packages/trust/authoring/
COPY packages/policy/identity/tsconfig.json packages/policy/identity/tsconfig.build.json ./packages/policy/identity/
COPY packages/policy/identity/scripts/ ./packages/policy/identity/scripts/
COPY packages/trust/resolve/tsconfig.json ./packages/trust/resolve/
COPY packages/environments/record/tsconfig.json ./packages/environments/record/
COPY packages/task-supply/admission/tsconfig.json ./packages/task-supply/admission/
COPY packages/marketplace/binding/tsconfig.json ./packages/marketplace/binding/
COPY packages/task-execution/backend-local/supervisor/tsconfig.json ./packages/task-execution/backend-local/supervisor/
COPY packages/task-execution/backend-local/workspace/tsconfig.json ./packages/task-execution/backend-local/workspace/
COPY packages/task-execution/backend-local/launchers/tsconfig.json ./packages/task-execution/backend-local/launchers/
COPY packages/task-execution/evaluation-harness/tsconfig.json ./packages/task-execution/evaluation-harness/
COPY packages/task-execution/evaluator-adapters/tsconfig.json ./packages/task-execution/evaluator-adapters/
COPY packages/task-execution/backend-local/assembly/tsconfig.json ./packages/task-execution/backend-local/assembly/
COPY packages/marketplace/pipeline/tsconfig.json ./packages/marketplace/pipeline/
COPY packages/discovery/protocol/tsconfig.json ./packages/discovery/protocol/
COPY packages/discovery/serve/tsconfig.json ./packages/discovery/serve/
COPY packages/marketplace/projector/tsconfig.json ./packages/marketplace/projector/
COPY packages/marketplace/venue-base/tsconfig.json ./packages/marketplace/venue-base/
COPY packages/discovery/client/tsconfig.json ./packages/discovery/client/
COPY packages/discovery/facts/task-execution/tsconfig.json ./packages/discovery/facts/task-execution/
COPY packages/discovery/transport-http/tsconfig.json ./packages/discovery/transport-http/
COPY packages/discovery/testing/tsconfig.json ./packages/discovery/testing/
COPY packages/evidence/protocol/src/ ./packages/evidence/protocol/src/
COPY packages/evidence/repository/src/ ./packages/evidence/repository/src/
COPY packages/evidence/discovery/src/ ./packages/evidence/discovery/src/
COPY packages/evidence/catalog-sqlite/src/ ./packages/evidence/catalog-sqlite/src/
COPY packages/evidence/local-runtime/src/ ./packages/evidence/local-runtime/src/
COPY packages/evidence/execution-evidence-builder/src/ ./packages/evidence/execution-evidence-builder/src/
COPY packages/evidence/execution-recorder/src/ ./packages/evidence/execution-recorder/src/
COPY packages/evidence/attestation-issuer/src/ ./packages/evidence/attestation-issuer/src/
COPY packages/task-execution/protocol/src/ ./packages/task-execution/protocol/src/
COPY packages/task-execution/backend/src/ ./packages/task-execution/backend/src/
COPY packages/task-execution/profiles/src/ ./packages/task-execution/profiles/src/
COPY packages/trust/core/src/ ./packages/trust/core/src/
COPY packages/trust/authoring/src/ ./packages/trust/authoring/src/
COPY packages/policy/identity/src/ ./packages/policy/identity/src/
COPY packages/trust/resolve/src/ ./packages/trust/resolve/src/
COPY packages/environments/record/src/ ./packages/environments/record/src/
COPY packages/task-supply/admission/src/ ./packages/task-supply/admission/src/
COPY packages/marketplace/binding/src/ ./packages/marketplace/binding/src/
COPY packages/task-execution/backend-local/supervisor/src/ ./packages/task-execution/backend-local/supervisor/src/
COPY packages/task-execution/backend-local/workspace/src/ ./packages/task-execution/backend-local/workspace/src/
COPY packages/task-execution/backend-local/launchers/src/ ./packages/task-execution/backend-local/launchers/src/
COPY packages/task-execution/evaluation-harness/src/ ./packages/task-execution/evaluation-harness/src/
COPY packages/task-execution/evaluator-adapters/src/ ./packages/task-execution/evaluator-adapters/src/
COPY packages/task-execution/backend-local/assembly/src/ ./packages/task-execution/backend-local/assembly/src/
COPY packages/marketplace/pipeline/src/ ./packages/marketplace/pipeline/src/
COPY packages/discovery/protocol/src/ ./packages/discovery/protocol/src/
COPY packages/discovery/serve/src/ ./packages/discovery/serve/src/
COPY packages/marketplace/projector/src/ ./packages/marketplace/projector/src/
COPY packages/marketplace/venue-base/src/ ./packages/marketplace/venue-base/src/
COPY packages/discovery/client/src/ ./packages/discovery/client/src/
COPY packages/discovery/facts/task-execution/src/ ./packages/discovery/facts/task-execution/src/
COPY packages/discovery/transport-http/src/ ./packages/discovery/transport-http/src/
COPY packages/discovery/testing/src/ ./packages/discovery/testing/src/
COPY packages/evidence/catalog-sqlite/README.md ./packages/evidence/catalog-sqlite/README.md
COPY packages/evidence/discovery/README.md ./packages/evidence/discovery/README.md
COPY packages/evidence/discovery/docs/ ./packages/evidence/discovery/docs/
COPY packages/evidence/discovery/specifications/ ./packages/evidence/discovery/specifications/
COPY packages/evidence/protocol/profiles/ ./packages/evidence/protocol/profiles/
COPY packages/evidence/protocol/fixtures/ ./packages/evidence/protocol/fixtures/
COPY packages/evidence/protocol/README.md ./packages/evidence/protocol/README.md
COPY packages/evidence/repository/README.md ./packages/evidence/repository/README.md
COPY packages/evidence/repository/specification.md ./packages/evidence/repository/specification.md
COPY packages/evidence/execution-evidence-builder/README.md ./packages/evidence/execution-evidence-builder/README.md
COPY packages/evidence/execution-recorder/fixtures/ ./packages/evidence/execution-recorder/fixtures/
COPY packages/evidence/execution-recorder/README.md ./packages/evidence/execution-recorder/README.md
COPY packages/evidence/attestation-issuer/fixtures/ ./packages/evidence/attestation-issuer/fixtures/
COPY packages/evidence/attestation-issuer/README.md ./packages/evidence/attestation-issuer/README.md
COPY packages/discovery/client/README.md ./packages/discovery/client/README.md
COPY packages/task-execution/backend/README.md ./packages/task-execution/backend/README.md
COPY packages/task-execution/backend-local/supervisor/native/jinn-attempt-shim.c ./packages/task-execution/backend-local/supervisor/native/jinn-attempt-shim.c
COPY packages/task-execution/backend-local/supervisor/README.md ./packages/task-execution/backend-local/supervisor/README.md
COPY packages/trust/core/fixtures/ ./packages/trust/core/fixtures/
COPY packages/trust/core/README.md ./packages/trust/core/README.md
COPY packages/trust/authoring/README.md ./packages/trust/authoring/README.md
COPY packages/policy/identity/fixtures/ ./packages/policy/identity/fixtures/
COPY packages/policy/identity/README.md ./packages/policy/identity/README.md
COPY packages/environments/record/schemas/ ./packages/environments/record/schemas/
COPY packages/environments/record/fixtures/ ./packages/environments/record/fixtures/
COPY packages/environments/record/README.md ./packages/environments/record/README.md
COPY packages/task-supply/admission/fixtures/ ./packages/task-supply/admission/fixtures/
COPY packages/task-supply/admission/README.md ./packages/task-supply/admission/README.md

# Publish-file payloads the bundled stack packages declare in their `files` arrays
# (profiles, fixtures, schemas, READMEs). They must exist before
# `materialize-bundled-workspaces.mjs prepare` copies each portal into node_modules.
COPY packages/evidence/local-runtime/README.md ./packages/evidence/local-runtime/README.md
COPY packages/marketplace/binding/README.md ./packages/marketplace/binding/README.md
COPY packages/marketplace/binding/fixtures/ ./packages/marketplace/binding/fixtures/
COPY packages/marketplace/pipeline/README.md ./packages/marketplace/pipeline/README.md
COPY packages/marketplace/projector/README.md ./packages/marketplace/projector/README.md
COPY packages/marketplace/venue-base/README.md ./packages/marketplace/venue-base/README.md
COPY packages/plugin/process-contract.json ./packages/plugin/process-contract.json
COPY packages/discovery/facts/task-execution/profiles/ ./packages/discovery/facts/task-execution/profiles/
COPY packages/discovery/facts/task-execution/README.md ./packages/discovery/facts/task-execution/README.md
COPY packages/discovery/protocol/fixtures/ ./packages/discovery/protocol/fixtures/
COPY packages/discovery/protocol/README.md ./packages/discovery/protocol/README.md
COPY packages/discovery/serve/README.md ./packages/discovery/serve/README.md
COPY packages/discovery/transport-http/README.md ./packages/discovery/transport-http/README.md
COPY packages/task-execution/backend-local/assembly/README.md ./packages/task-execution/backend-local/assembly/README.md
COPY packages/task-execution/backend-local/launchers/README.md ./packages/task-execution/backend-local/launchers/README.md
COPY packages/task-execution/evaluation-harness/README.md ./packages/task-execution/evaluation-harness/README.md
COPY packages/task-execution/evaluator-adapters/fixtures/ ./packages/task-execution/evaluator-adapters/fixtures/
COPY packages/task-execution/evaluator-adapters/README.md ./packages/task-execution/evaluator-adapters/README.md
COPY packages/task-execution/profiles/profiles/ ./packages/task-execution/profiles/profiles/
COPY packages/task-execution/profiles/fixtures/ ./packages/task-execution/profiles/fixtures/
COPY packages/task-execution/profiles/README.md ./packages/task-execution/profiles/README.md
COPY packages/task-execution/protocol/profiles/ ./packages/task-execution/protocol/profiles/
COPY packages/task-execution/protocol/schemas/ ./packages/task-execution/protocol/schemas/
COPY packages/task-execution/protocol/fixtures/ ./packages/task-execution/protocol/fixtures/
COPY packages/task-execution/protocol/README.md ./packages/task-execution/protocol/README.md
COPY packages/task-execution/backend-local/workspace/README.md ./packages/task-execution/backend-local/workspace/README.md
COPY packages/trust/resolve/README.md ./packages/trust/resolve/README.md

# Copy source and bundled deployment artifacts.
COPY operator/src/ ./operator/src/
COPY operator/deployments/ ./operator/deployments/
COPY operator/docs/ ./operator/docs/
COPY operator/plugins/ ./operator/plugins/
COPY operator/scripts/ ./operator/scripts/
COPY operator/templates/ ./operator/templates/
COPY operator/tsconfig.json ./operator/

# Build TypeScript
WORKDIR /app/operator
RUN yarn build

# Remove development-only portals (including the extracted layer) and their
# generated .bin shims before node_modules leaves the repository layout.
RUN yarn workspaces focus @jinn-network/client --production

# Replace the remaining production core/plugin portals with their
# publish-shaped runtime directories before node_modules crosses into the
# final image.
RUN node scripts/materialize-bundled-workspaces.mjs prepare

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

ARG JINN_BUILD_COMMIT=unknown
ENV JINN_BUILD_COMMIT=$JINN_BUILD_COMMIT

WORKDIR /app

# better-sqlite3 needs libstdc++ at runtime; git and curl are often required by
# agent tools. gosu lets the base entrypoint drop root → node at boot (see
# docker-entrypoint.sh); ca-certificates is needed for TLS once non-root.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 git curl ca-certificates gosu docker.io \
    && rm -rf /var/lib/apt/lists/*

# The CLI talks only to the isolated verifier daemon configured by Compose.
# The host Docker socket is deliberately never mounted into this container.

# Claude CLI for the default claude-code harness. This exact version is verified
# to expose the semantic evaluator's required --safe-mode flag; the build fails
# if that capability drifts. claude-code stays in the base on purpose: this is
# the runnable claude/compose default image, and the operator launches it
# directly. The codex overlay (S8) adds its own CLI on top of this base.
RUN npm install -g @anthropic-ai/claude-code@2.1.216 \
    && claude --version \
    && claude --help | grep -F -- '--safe-mode'

# The daemon runs as the non-root `node` user (uid 1000, already present in the
# node:22-slim base): Claude Code refuses --dangerously-skip-permissions when
# running as root. Pre-create node's home + .claude dir so the CLI can write its
# session/config state; the entrypoint chowns $JINN_STATE_DIR and drops root →
# node. Auth is env-based by default (CLAUDE_CODE_OAUTH_TOKEN) — compose users
# who prefer file-auth mount their token at /home/node/.claude.
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node

# Copy only what's needed to run
COPY --from=build /app/operator/dist dist/
COPY --from=build /app/operator/deployments deployments/
COPY --from=build /app/operator/plugins plugins/
COPY --from=build /app/operator/node_modules node_modules/
COPY --from=build /app/operator/package.json ./

# Single volume-aware durable-state root (S3). The daemon derives earningDir,
# dbPath, and engine.impl-state under this when they are not set explicitly, so
# one ENV replaces the former per-key JINN_EARNING_DIR / JINN_DB_PATH lines.
ENV NODE_ENV=production
ENV JINN_STATE_DIR=/data

# Base-contract version (#1066): the contract that overlays depend on. Contract
# 1 == the #988 entrypoint dispatch that exec's an absolute-path CMD[0] (an
# overlay seed script) as-is. Overlay seed scripts read this and fail loud if a
# base is too old, turning future contract drift into a clear message instead of
# a cryptic "Unknown verb" crash. Bump only when the entrypoint contract changes.
ENV JINN_BASE_CONTRACT=1

# Expose API port
EXPOSE 7331

# NOTE: no `VOLUME ["/data"]` — Railway rejects the Dockerfile directive, and a
# baked VOLUME also masks the entrypoint's chown on some runtimes. Attach the
# /data volume at the service level instead: `docker run -v jinn-data:/data`,
# a compose-file `volumes:` mount, or `railway volume add --mount-path /data`.

# Base entrypoint: a gosu privilege-drop wrapper (chowns $JINN_STATE_DIR then
# re-execs itself as the node user). It is deliberately minimal — no pidfile
# cleanup, no dotfile pruning, no state seeding (the daemon owns those now per
# S1/S2/S3). Its final dispatch is back-compatible: a bare jinn subcommand
# (run/version/doctor) gets the `node dist/bin/jinn.js` prefix, preserving the
# historical `docker run IMAGE version` contract; an absolute-path/node/sh/bash
# first arg is exec'd as-is, so an S8 overlay passes its own seeding script as
# the CMD (e.g. ["/usr/local/bin/seed.sh","run"]) without replacing this entrypoint.
COPY operator/docker-entrypoint.sh /usr/local/bin/jinn-entrypoint.sh
RUN chmod +x /usr/local/bin/jinn-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/jinn-entrypoint.sh"]
CMD ["run"]
