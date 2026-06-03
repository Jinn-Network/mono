# Railway deploy — launcher+operator (claude-code / Haiku)

Hosts the operator's single `jinn run` daemon that is **both** the SWE-rebench v2
launcher/generator and a solver — one wallet, both roles. Standing this up on a
supervised host is how we stop the task-generator gaps that fail Milestone 1
blocks (see `docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md`).

Run locally with `jinn run`; this directory is only for the headless hosted deploy.

## Shape: thin overlay on the container-native base

`Dockerfile` is a ~4-line overlay on `ghcr.io/jinn-network/client` (the
container-native base, #988):

```dockerfile
ARG BASE_TAG=latest
FROM ghcr.io/jinn-network/client:${BASE_TAG}
ENV JINN_NETWORK=testnet JINN_AUTO_TESTNET_FAUCET=1 JINN_CONFIG=/data/config.json
COPY deploy/railway-launcher-operator/seed.sh /usr/local/bin/jinn-launcher-seed.sh
RUN chmod +x /usr/local/bin/jinn-launcher-seed.sh
CMD ["/usr/local/bin/jinn-launcher-seed.sh", "run", "--config", "/data/config.json"]
```

The base already owns the four former daemon-correctness workarounds — the
gosu root→node drop (base entrypoint), and `rm daemon.pid` / `find ._* -delete`
/ state-dir derivation (the daemon, #954/#955/#956). `seed.sh` is **seeding-only**:
config + launched-record + optional one-shot state restore, then
`exec node dist/bin/jinn.js`.

`BASE_TAG` must point to a base release that includes #988. See
[`../README.md`](../README.md) for the full deploy path (the public-GHCR ops
step, the deploy contract, the claim-relayer, and the consolidation checklist).

## Required Railway env vars (secrets)

| Variable | Source | Purpose |
|---|---|---|
| `JINN_PASSWORD` | the operator's existing keystore password | Decrypts the migrated keystore. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` on a logged-in machine | Authenticates Haiku headless **and** keeps the AI-units throttle engaged. **If unset, the throttle is silently OFF.** |
| `CONFIG_TEMPLATE_JSON` | the operator config, minified | Seeded to `/data/config.json` on first boot. Must include the `joinedSolverNets[<cid>]` entry with `harness: "claude-code"`, `model: "claude-haiku-4-5-20251001"`, and the load-bearing `contract: { id, version }` field (#674). |
| `JINN_STATE_TARBALL_B64` *(migration)* | `base64` of `tar -czf - -C ~/.jinn-client earning swe-rebench-v2` | One-shot restore of keystore + stake state + launched record **and** the generator state + validated pool. Extracted only when `/data/earning` is absent. |
| `LAUNCHED_RECORD_JSON` *(fresh, alt to tarball)* | the owned `…/solvernets/launched/<id>.json` | Seeds the launched record so the generator spawns. Redundant if the tarball already carries it. See "Launched record" below. |

Baked-in defaults (override via Railway env): `JINN_NETWORK=testnet`,
`JINN_AUTO_TESTNET_FAUCET=1`, `JINN_CONFIG=/data/config.json`. State paths
(earning, db, swe-rebench-v2, impl-state) are derived by the daemon from the
base's `JINN_STATE_DIR=/data` — no per-key overrides needed.

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
> #988) authenticates non-interactively from `CLAUDE_CODE_OAUTH_TOKEN` alone,
> with no `~/.claude.json` file.

## Volume

Attach a volume at `/data`: `railway volume add --mount-path /data`. Keystore,
earning/stake state, launched records, SQLite db, and the Claude config all live there.

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
4. Deploy: from the repo root, `railway up --service <name> --environment production --ci -m "launcher-operator cutover"`.
5. Confirm the staked service re-appears in the staking contract's `getServiceIds()` and the generator resumes (see Verification).

## Funding

The agent EOA needs Base Sepolia ETH (gas + task-creation fees); the Safe needs
OLAS for the bond. On a migration the wallet is already funded/staked, so this is
moot. For a fresh wallet, `JINN_AUTO_TESTNET_FAUCET=1` only fires in Stage 2 — drip
the EOA manually past the Stage-1 minimum (~0.02 ETH) first.

## Verification

- Boot log shows `[ai-units] cap=100/2800 per (block, week) source=…` → throttle engaged. **If absent, the credential didn't resolve — check `CLAUDE_CODE_OAUTH_TOKEN`.**
- `[seed] claude CLI: <version>` and `[creator] …` task-posting lines appear.
- Task-creation rate on the indexer is non-zero and continuous (no gap > a few minutes). If creation is silent, confirm the swe-rebench-v2 state dir holds a `validated-pool.json` (see "Generator state + validated pool" above).
- Headless observability is on `/v1/status` (ai-units / loop-completion / impl-state cadence / earning, S6/#959) — no more `railway ssh` + SQLite. `measure-learning.sh` is retired.

## Caveats

- **Supply single-point-of-failure.** This box is now the sole task creator. `ON_FAILURE`
  restart + the task backlog buffer + an alert on stalled task-creation mitigate it; the
  *second* distinct operator M1 needs comes from the fleet on independent infra.
- True supply redundancy needs a **second** launcher with its own wallet + launch (future).
- A Claude OAuth token lives in Railway secrets (same posture as the codex recipe's `CODEX_AUTH_JSON`).
- **Launcher + solver only.** This image installs no Docker; swe-rebench v2 *evaluation* needs a Docker daemon, so do not add the `evaluator` role to this box's `joinedSolverNets` — evaluation tasks would fail at pickup.
- **Earning needs the separate claim-relayer.** The daemon is emit-only; deploy `packages/claim-relayer` alongside it (see [`../README.md`](../README.md)).
