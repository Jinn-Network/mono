# Railway launcher+operator deploy image (claude-code or codex) — thin overlay.
#
# Hosts the operator's single jinn-run daemon that is BOTH the SWE-rebench v2
# launcher/generator (owns a launched record) AND a solver — one wallet, both
# roles (see docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md).
#
# This is now a thin overlay on the container-native base (#988). Published base
# tags can lag the repo Dockerfile, so this overlay defensively ensures gosu is
# present before it owns the launcher/operator's per-deployment seeding.

ARG BASE_TAG=latest
# BASE_IMAGE lets CI weld this overlay to an exact base digest built from the
# SAME commit (--build-arg BASE_IMAGE=ghcr.io/jinn-network/client@sha256:…), so
# base+overlay can never be mismatched (#1066). It defaults to the BASE_TAG-
# resolved tag, so Railway's existing BASE_TAG service var keeps working.
ARG BASE_IMAGE=ghcr.io/jinn-network/client:${BASE_TAG}
FROM ${BASE_IMAGE}
# NOTE: BASE_TAG/BASE_IMAGE must point to a published base that includes the
# container-native changes (#988); flip the ghcr.io/jinn-network/client package
# PUBLIC first (see README).
# gosu lets the seed script chown the mounted Railway volume and then drop root
# before launching the daemon. ca-certificates are required by Codex's native TLS
# client when connecting to chatgpt.com websockets. Some published base tags do
# not include these yet.
RUN if ! command -v gosu >/dev/null 2>&1 || [ ! -f /etc/ssl/certs/ca-certificates.crt ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends gosu ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi
# Codex CLI for a Codex-backed solver lane on the hosted launcher. Pinned to the
# version covered by the codex-code adapter's stdin contract tests.
RUN npm install -g @openai/codex@0.133.0
COPY operator/plugins/learner/hooks/session-start /app/dist/plugins/learner/hooks/session-start
RUN chmod +x /app/dist/plugins/learner/hooks/session-start
COPY deploy/railway-launcher-operator/patch-codex-session-start-context.js /usr/local/bin/patch-codex-session-start-context.js
RUN node /usr/local/bin/patch-codex-session-start-context.js
ENV JINN_NETWORK=testnet
ENV JINN_AUTO_TESTNET_FAUCET=1
ENV JINN_STATE_DIR=/data
ENV JINN_EARNING_DIR=/data/earning
ENV JINN_SWE_REBENCH_V2_STATE_DIR=/data/swe-rebench-v2
ENV JINN_ENGINE_IMPL_STATE_DIR_ROOT=/data/engine/impl-state
ENV JINN_CONFIG=/data/config.json
ENV CODEX_HOME=/data/codex-home
COPY deploy/railway-launcher-operator/seed.sh /usr/local/bin/jinn-launcher-seed.sh
RUN chmod +x /usr/local/bin/jinn-launcher-seed.sh

# Override the base ENTRYPOINT defensively: published base tags can lag the
# absolute-path dispatch support, so the seed script performs the same root→node
# drop before seeding and handing off to the daemon.
ENTRYPOINT ["/usr/local/bin/jinn-launcher-seed.sh"]
CMD ["run", "--config", "/data/config.json"]
