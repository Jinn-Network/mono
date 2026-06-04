#!/usr/bin/env bash
# Smoke-boot an operator overlay image (#1066).
#
# Boots the image with its BAKED default CMD (the per-harness seed script) and
# asserts the base entrypoint dispatched it correctly — i.e. exec'd the
# absolute-path seed script as-is, which then reaches `exec node dist/bin/jinn.js
# run`. This reproduces the exact failure that took the test operator down on
# 2026-06-04: a #988 overlay on a pre-#988 base, where the entrypoint instead
# fed the seed script to `jinn` as a verb → "Unknown verb" → exit 11.
#
# PASS  : logs contain the seed script's `[seed] exec node dist/bin/jinn.js run`
#         line (the dispatch reached the daemon hand-off) — network-independent.
# FAIL  : logs contain "Unknown verb" (base/overlay mismatch), OR the container
#         exits / times out before the hand-off line ever appears.
#
# Usage: smoke-boot-operator.sh <image-ref> <harness-name>
set -euo pipefail

IMAGE="${1:?usage: smoke-boot-operator.sh <image-ref> <harness-name>}"
NAME="${2:?usage: smoke-boot-operator.sh <image-ref> <harness-name>}"

SEED_EXEC='\[seed\] exec node dist/bin/jinn.js run'
MISMATCH='Unknown verb'
DEADLINE=30

echo "::group::smoke-boot ${NAME} (${IMAGE})"

# No real secrets: the daemon boots to the readiness gate / awaiting-funding and
# stays up. JINN_STATE_DIR makes the deployment-readiness gate arm (and pass, on
# a writable container /data running as the gosu-dropped node user).
cid="$(docker run -d \
  -e JINN_STATE_DIR=/data \
  -e JINN_NETWORK=testnet \
  -e JINN_PASSWORD=smoke \
  "${IMAGE}")"

# shellcheck disable=SC2329  # invoked indirectly via the EXIT trap below
cleanup() { docker rm -f "${cid}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() {
  echo "::error::${NAME}: $1"
  echo "---- last 50 log lines ----"
  docker logs "${cid}" 2>&1 | tail -50 || true
  echo "::endgroup::"
  exit 1
}

for _ in $(seq 1 "${DEADLINE}"); do
  logs="$(docker logs "${cid}" 2>&1 || true)"
  if printf '%s' "${logs}" | grep -qi "${MISMATCH}"; then
    fail "base/overlay MISMATCH — the seed script was dispatched as a jinn verb (pre-#988 base). The overlay needs a #988+ base."
  fi
  if printf '%s' "${logs}" | grep -q "${SEED_EXEC}"; then
    echo "${NAME}: dispatch OK — reached the daemon hand-off (\`exec node dist/bin/jinn.js run\`)."
    echo "::endgroup::"
    exit 0
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "${cid}" 2>/dev/null || echo false)" != "true" ]; then
    # Exited before the hand-off line. Re-read once in case the exec line landed
    # in the final flush, then fail.
    logs="$(docker logs "${cid}" 2>&1 || true)"
    if printf '%s' "${logs}" | grep -q "${SEED_EXEC}"; then
      echo "${NAME}: dispatch OK (seen on final flush)."
      echo "::endgroup::"
      exit 0
    fi
    code="$(docker inspect -f '{{.State.ExitCode}}' "${cid}" 2>/dev/null || echo '?')"
    fail "container exited early (code=${code}) before reaching the daemon hand-off."
  fi
  sleep 1
done

fail "timed out after ${DEADLINE}s without reaching the daemon hand-off line."
