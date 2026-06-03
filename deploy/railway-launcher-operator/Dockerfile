# Railway launcher+operator deploy image (claude-code / Haiku) — thin overlay.
#
# Hosts the operator's single jinn-run daemon that is BOTH the SWE-rebench v2
# launcher/generator (owns a launched record) AND a solver — one wallet, both
# roles (see docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md).
#
# This is now a ~4-line overlay on the container-native base (#988). The base
# already has: the non-root gosu-drop entrypoint, pinned claude-code, gosu,
# env-auth default, JINN_STATE_DIR=/data, and no VOLUME. This overlay adds only
# the launcher/operator's per-deployment seeding + testnet env.

ARG BASE_TAG=latest
FROM ghcr.io/jinn-network/client:${BASE_TAG}
# NOTE: BASE_TAG must point to a published base that includes the container-native
# changes (#988); flip the ghcr.io/jinn-network/client package PUBLIC first (see README).
ENV JINN_NETWORK=testnet
ENV JINN_AUTO_TESTNET_FAUCET=1
ENV JINN_CONFIG=/data/config.json
COPY deploy/railway-launcher-operator/seed.sh /usr/local/bin/jinn-launcher-seed.sh
RUN chmod +x /usr/local/bin/jinn-launcher-seed.sh

# Keep the base ENTRYPOINT (the gosu drop runs first, then dispatches this CMD).
# The base case-dispatch matches the absolute-path CMD[0] and exec's the seed
# script as the node user; the seed script ends with `exec node dist/bin/jinn.js`
# so the CMD tail (run --config /data/config.json) reaches the daemon.
CMD ["/usr/local/bin/jinn-launcher-seed.sh", "run", "--config", "/data/config.json"]
