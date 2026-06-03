# Railway operator-codex deploy image — thin overlay.
#
# A ~4-line overlay on the container-native base (#988): FROM the base, add the
# codex CLI, add a seeding-only entrypoint. The base already owns the non-root
# gosu-drop entrypoint, JINN_STATE_DIR=/data (the daemon derives earning/db/
# impl-state/swe-rebench under it), env-auth, and no VOLUME.

ARG BASE_TAG=latest
FROM ghcr.io/jinn-network/client:${BASE_TAG}
# NOTE: BASE_TAG must point to a published base that includes the container-native
# changes (#988); flip the ghcr.io/jinn-network/client package PUBLIC first (see README).

# Codex CLI for the codex harness. Pinned to the version verified locally.
RUN npm install -g @openai/codex@0.133.0
ENV JINN_CONFIG=/data/config.json
COPY deploy/railway-operator-codex/seed.sh /usr/local/bin/jinn-codex-seed.sh
RUN chmod +x /usr/local/bin/jinn-codex-seed.sh

# Keep the base ENTRYPOINT (gosu drop runs first, then dispatches this CMD).
CMD ["/usr/local/bin/jinn-codex-seed.sh", "run", "--config", "/data/config.json"]
