# Railway operator-codex deploy image — thin overlay.
#
# A ~4-line overlay on the container-native base (#988): FROM the base, add the
# codex CLI, add a seeding-only entrypoint. The base already owns the non-root
# gosu-drop entrypoint, JINN_STATE_DIR=/data (the daemon derives earning/db/
# impl-state/swe-rebench under it), env-auth, and no VOLUME.

# `next` — the canary lane republishes it on every push to `next`, so the
# default keeps resolving between named cuts. `latest` moves only on a release,
# so it 404s whenever the stable lane has not published since a rename (#2811).
# CI overrides this with BASE_IMAGE=…@sha256:… and Railway pins BASE_TAG.
ARG BASE_TAG=next
# BASE_IMAGE lets CI weld this overlay to an exact base digest built from the
# SAME commit (--build-arg BASE_IMAGE=ghcr.io/jinn-network/operator@sha256:…), so
# base+overlay can never be mismatched (#1066). It defaults to the BASE_TAG-
# resolved tag, so Railway's existing BASE_TAG service var keeps working.
ARG BASE_IMAGE=ghcr.io/jinn-network/operator:${BASE_TAG}
FROM ${BASE_IMAGE}
# NOTE: BASE_TAG/BASE_IMAGE must point to a published base that includes the
# container-native changes (#988). The ghcr.io/jinn-network/operator package is
# public — an unauthenticated pull works (see README).

# Codex CLI for the codex harness. Pinned to the version verified locally.
RUN npm install -g @openai/codex@0.133.0
# Testnet + faucet auto-drip — parity with the prior codex image and the launcher
# overlay; the README's first-boot funding flow depends on JINN_AUTO_TESTNET_FAUCET=1.
ENV JINN_NETWORK=testnet
ENV JINN_AUTO_TESTNET_FAUCET=1
ENV JINN_CONFIG=/data/config.json
COPY deploy/railway-operator-codex/seed.sh /usr/local/bin/jinn-codex-seed.sh
RUN chmod +x /usr/local/bin/jinn-codex-seed.sh

# Keep the base ENTRYPOINT (gosu drop runs first, then dispatches this CMD).
CMD ["/usr/local/bin/jinn-codex-seed.sh", "run", "--config", "/data/config.json"]
