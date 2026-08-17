# Railway deploy — launcher+operator (claude-code or codex)

Hosts the operator's single `jinn run` daemon that is **both** the SWE-rebench v2
launcher/generator and a solver — one wallet, both roles. The solver lane can be
selected by persisted `joinedSolverNets` config (`claude-code-learner` or
`codex-code-learner`). Standing this up on a
supervised host is how we stop the task-generator gaps that fail Milestone 1
blocks (see `docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md`).

Run locally with `jinn run`; this directory is only for the headless hosted deploy.

## Shape: thin overlay on the container-native base

`Dockerfile` is a ~4-line overlay on `ghcr.io/jinn-network/operator` (the
container-native base, #988; `ghcr.io/jinn-network/client` remains a dual-push
alias during the F1 window):

```dockerfile
ARG BASE_TAG=latest
FROM ghcr.io/jinn-network/operator:${BASE_TAG}
RUN if ! command -v gosu >/dev/null 2>&1 || [ ! -f /etc/ssl/certs/ca-certificates.crt ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends gosu ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi
RUN npm install -g @openai/codex@0.133.0
COPY operator/plugins/learner/hooks/session-start /app/dist/plugins/learner/hooks/session-start
RUN chmod +x /app/dist/plugins/learner/hooks/session-start
COPY deploy/railway-launcher-operator/patch-codex-session-start-context.js /usr/local/bin/patch-codex-session-start-context.js
RUN node /usr/local/bin/patch-codex-session-start-context.js
ENV JINN_NETWORK=testnet JINN_AUTO_TESTNET_FAUCET=1 JINN_STATE_DIR=/data
ENV JINN_EARNING_DIR=/data/earning JINN_SWE_REBENCH_V2_STATE_DIR=/data/swe-rebench-v2
ENV JINN_ENGINE_IMPL_STATE_DIR_ROOT=/data/engine/impl-state JINN_CONFIG=/data/config.json
ENV CODEX_HOME=/data/codex-home
COPY deploy/railway-launcher-operator/seed.sh /usr/local/bin/jinn-launcher-seed.sh
RUN chmod +x /usr/local/bin/jinn-launcher-seed.sh
ENTRYPOINT ["/usr/local/bin/jinn-launcher-seed.sh"]
CMD ["run", "--config", "/data/config.json"]
```

The daemon owns the former pidfile / AppleDouble / state-dir workarounds
(#954/#955/#956) in current source, but published base tags can lag. `seed.sh`
therefore owns the minimal Railway entrypoint duties for this overlay: ensure
the mounted `/data` directory is writable, drop root→`node`, seed
config/auth/launched state, reclaim a stale PID-1 daemon pidfile if present, then
`exec node dist/bin/jinn.js`. The overlay also installs `gosu` when the
published base tag does not have it yet, and ensures native CA roots are present
for Codex's `chatgpt.com` websocket connection. While published base tags lag
the source tree, it also overlays the current learner `session-start` hook and
applies a generic Codex adapter bridge so Claude-style `SessionStart` hook
`additionalContext` reaches the Codex prompt.

`BASE_TAG` must point to a base release that includes #988. See
[`../README.md`](../README.md) for the full deploy path (the public-GHCR ops
step, the deploy contract, the claim-relayer, and the consolidation checklist).

## Required Railway env vars (secrets)

| Variable | Source | Purpose |
|---|---|---|
| `JINN_PASSWORD` | the operator's existing keystore password | Decrypts the migrated keystore. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` on a logged-in machine | Authenticates Claude Code headless and keeps the AI-units throttle engaged for `claude-code-learner`. Keep this set so rollback to Claude is config-only. |
| `CODEX_AUTH_JSON` | `base64 -i ~/.codex/auth.json \| tr -d '\n'` | Base64-encoded Codex auth file. Decoded into `$CODEX_HOME/auth.json` on each boot for `codex-code-learner`. |
| `CONFIG_TEMPLATE_JSON` | the operator config, minified | Seeded to `/data/config.json` on first boot. Must include the `joinedSolverNets[<cid>]` entry with `harness: "codex-code-learner"`, `model: "gpt-5.4-mini"` (or the Claude rollback pair), and the load-bearing `contract: { id, version }` field (#674). |
| `JINN_STATE_TARBALL_B64` *(migration)* | `base64` of `tar -czf - -C ~/.jinn-client earning swe-rebench-v2` | One-shot restore of keystore + stake state + launched record **and** the generator state + validated pool. Extracted only when `/data/earning` is absent. |
| `LAUNCHED_RECORD_JSON` *(fresh, alt to tarball)* | the owned `…/solvernets/launched/<id>.json` | Seeds the launched record so the generator spawns. Redundant if the tarball already carries it. See "Launched record" below. |

Baked-in defaults (override via Railway env): `JINN_NETWORK=testnet`,
`JINN_AUTO_TESTNET_FAUCET=1`, `JINN_STATE_DIR=/data`,
`JINN_EARNING_DIR=/data/earning`,
`JINN_SWE_REBENCH_V2_STATE_DIR=/data/swe-rebench-v2`,
`JINN_ENGINE_IMPL_STATE_DIR_ROOT=/data/engine/impl-state`,
`JINN_CONFIG=/data/config.json`, `CODEX_HOME=/data/codex-home`. The explicit
per-key state envs are kept while published base tags lag the root-aware state
derivation.

## Generator state + validated pool (required, or the generator posts 0 tasks)

The generator reads its validated pool from the daemon's swe-rebench-v2 state
dir (derived under `/data`) — there is **no IPFS fetch fallback**. If that dir
has no `validated-pool.json` under `admissionMode: required`, the pool is empty
and the generator posts nothing. Two ways to satisfy it:

- **Migration (recommended):** include `swe-rebench-v2` in the state tarball (the
  command above already does). It carries your local `validated-pool.json`.
- **Fresh box:** run `jinn solver-nets validate-pool swe-rebench-v2` on the box
  before the generator can post.

## Launched record

The generator spawns only for an owned record with `status: "launched"` and
`generatorEnabled: true` (it walks `${earning}/solvernets/launched/`). The record
is schema-validated on load and **silently dropped** if it fails
(`solvernet.launched.v1`: requires `solverNetId`, `manifestCid`, `manifestHash`
(`0x…`), `launcherAgentId`, `launcherSafeAddress` (20-byte address), `launchedAt`,
`status`, `statusUpdatedAt`, `generatorEnabled`, `registry`). Provide it via the
migration tarball, or as `LAUNCHED_RECORD_JSON` — use your **real** local record
verbatim (a placeholder with a malformed `manifestHash` parses but is dropped at
load, and the generator never spawns).

> Auth mechanism is **env-only** — the claude CLI (pinned in the base image,
> #988) authenticates non-interactively from `CLAUDE_CODE_OAUTH_TOKEN`, and the
> codex CLI reads `$CODEX_HOME/auth.json` seeded from `CODEX_AUTH_JSON`.

## Volume

Attach a volume at `/data`: `railway volume add --mount-path /data`. Keystore,
earning/stake state, launched records, SQLite db, and the Codex auth/config live there.

## One-time service setup

Set **Settings → Config as code → `deploy/railway-launcher-operator/railway.toml`**.
Do **not** put a `railway.toml` at the repo root — it hijacks `jinn-indexer` and
every other monorepo service (#846).

## Cutover (migration) — same wallet, so NOT parallel

The hosted box uses the **same wallet** as the laptop; running both at once causes
nonce races and double-claims. Cut over:

1. Stop the local daemon (`jinn kill` or Ctrl-C).
2. Export local state (includes the validated pool): `tar -czf - -C ~/.jinn-client earning swe-rebench-v2 | base64 | tr -d '\n' > state.b64` → set as `JINN_STATE_TARBALL_B64`.
3. Set the other secrets above; attach the volume; set the config-as-code path.
4. Deploy: from the repo root, `railway up --service <name> --environment production --ci`.
5. Confirm the staked service re-appears in the staking contract's `getServiceIds()` and the generator resumes (see Verification).

## Funding

The agent EOA needs Base Sepolia ETH (gas + task-creation fees); the Safe needs
OLAS for the bond. On a migration the wallet is already funded/staked, so this is
moot. For a fresh wallet, `JINN_AUTO_TESTNET_FAUCET=1` only fires in Stage 2 — drip
the EOA manually past the Stage-1 minimum (~0.02 ETH) first.

## Verification

- Boot log shows `[ai-units] cap=100/2800 per (block, week) source=…` → throttle engaged. **If absent, the selected harness credential didn't resolve — check `CODEX_AUTH_JSON` / `$CODEX_HOME/auth.json` for Codex or `CLAUDE_CODE_OAUTH_TOKEN` for Claude.**
- `[seed] codex CLI: <version>` appears when Codex is selected; `[seed] claude CLI: <version>` remains present for rollback.
- `[creator] …` task-posting lines appear.
- Task-creation rate on the indexer is non-zero and continuous (no gap > a few minutes). If creation is silent, confirm the swe-rebench-v2 state dir holds a `validated-pool.json` (see "Generator state + validated pool" above).
- Headless observability is on `/v1/status` (ai-units / loop-completion / impl-state cadence / earning, S6/#959) — no more `railway ssh` + SQLite. `measure-learning.sh` is retired.

## Caveats

- **Supply single-point-of-failure.** This box is now the sole task creator. `ON_FAILURE`
  restart + the task backlog buffer + an alert on stalled task-creation mitigate it; the
  *second* distinct operator M1 needs comes from the fleet on independent infra.
- True supply redundancy needs a **second** launcher with its own wallet + launch (future).
- Claude and Codex OAuth material may both live in Railway secrets. Keep both during temporary cutovers so rollback is config-only.
- **Launcher + solver only.** This image installs no Docker; swe-rebench v2 *evaluation* needs a Docker daemon, so do not add the `evaluator` role to this box's `joinedSolverNets` — evaluation tasks would fail at pickup.
- **Earning needs the separate claim-relayer.** The daemon is emit-only; deploy `packages/claim-relayer` alongside it (see [`../README.md`](../README.md)).
