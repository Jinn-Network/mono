# Deploying a hosted Jinn operator

This is **the one documented deploy path** for a headless, hosted `jinn run`
daemon. Per-harness recipes are thin overlays on a single container-native base
image; everything they share lives here.

> Local operators do not need any of this — `npm install -g @jinn-network/client@latest && jinn run` (see the root `CLAUDE.md`). This directory is only for headless, hosted (Railway) deployments.

## The base image

`ghcr.io/jinn-network/client` is the container-native base, built from
`client/Dockerfile` by [`.github/workflows/docker.yml`](../.github/workflows/docker.yml)
on every published GitHub Release (tag `vX.Y.Z` or `client-vX.Y.Z`). The workflow
pushes three tags: `:<version>`, `:sha-<short>`, and `:latest` (linux/amd64 +
linux/arm64).

The base is container-native after **#988**: its entrypoint drops root→node via
gosu and chowns `$JINN_STATE_DIR`; it bakes the pinned `claude-code` CLI, `gosu`,
env-based auth (no `~/.claude.json` file), and `JINN_STATE_DIR=/data`; it ships
**no** `VOLUME` directive (Railway rejects it and a baked VOLUME masks the chown).
The daemon owns the four former entrypoint workarounds — pidfile reclaim (#955),
dotfile skip (#954), and state-dir derivation under `JINN_STATE_DIR` (#956).

### Ops step (one-time): let the build pull the private base

The `ghcr.io/jinn-network/client` package is **private**, and the
`Jinn-Network` org **disallows public packages** (the "Change visibility →
Public" control reports *"Setting is disabled by organization
administrators"*). So overlays authenticate to GHCR to pull the base — no
org-policy change needed. Two equivalent ways:

- **Railway:** add `ghcr.io/jinn-network/client` as a private image source /
  set GHCR registry credentials on the service — a token with **`read:packages`**
  on the `client` package (a classic PAT or a fine-grained token).
- **CI / local:** `echo "$GHCR_TOKEN" | docker login ghcr.io -u <user> --password-stdin`
  before `docker build` of an overlay.

This is the documented default. Two alternatives, if you'd rather not wire a
pull-token:
- **ARG build-from-source** — the overlays can instead build the client from
  source (one shared Dockerfile, `ARG AGENT_CLI`), needing no registry pull at
  all, at the cost of a full rebuild per target. (Requires the `client/` +
  `packages/sdk/` sources in the build context.)
- **Re-enable public packages org-wide** — an org *owner* can flip
  Org → Settings → Packages to allow public, then make `client` public. Broader
  policy change; only worth it if you want public packages generally.

Until the build can pull (or build) the base, an overlay build will fail with
an `unauthorized`/`denied` error on the `FROM` line.

## The overlay pattern

Each per-harness recipe is a ~4-line overlay:

```dockerfile
ARG BASE_TAG=latest
FROM ghcr.io/jinn-network/client:${BASE_TAG}
RUN npm install -g <agent-cli>@<pinned-version>   # claude-code is already in the base
ENV <seed env...>
COPY deploy/<recipe>/seed.sh /usr/local/bin/<recipe>-seed.sh
RUN chmod +x /usr/local/bin/<recipe>-seed.sh
CMD ["/usr/local/bin/<recipe>-seed.sh", "run", "--config", "/data/config.json"]
```

The overlay keeps the base `ENTRYPOINT` (do **not** override it). At boot the
base entrypoint drops root→node, then its case-dispatch sees the absolute-path
CMD[0] and `exec`s the seed script as the node user. The seed script does
**seeding only** (auth file, git identity, config / launched-record seed,
optional one-shot state restore) and ends with `exec node dist/bin/jinn.js "$@"`,
so the CMD tail (`run --config /data/config.json`) reaches the daemon.

`BASE_TAG` must point to a base release that includes #988. Default is `latest`;
pin it via a `BASE_TAG` Railway service variable or `[build.args]` in the
recipe's `railway.toml`.

### Build context — what each build actually needs

- **The base image** (`client/Dockerfile`, built **once** in CI by
  `.github/workflows/docker.yml`) compiles only **`client/` + `packages/sdk/`**
  (the SDK is a Yarn-portal workspace dependency). It does **not** touch
  `contracts/`, `docs/`, `spec/`, etc. — the build context is the repo root but
  `.dockerignore` keeps it to those two subtrees.
- **An overlay build** needs only this recipe's **`deploy/<recipe>/` files +
  pull access to the base image** — no monorepo compilation, no `client/`, no
  `sdk/`. On Railway, point the service at this repo with
  `RAILWAY_DOCKERFILE_PATH=deploy/<recipe>/Dockerfile`; Railway clones the repo
  for context but the build only `COPY`s `deploy/<recipe>/seed.sh` and pulls the
  base. (An overlay could equally live in a thin standalone deploy repo pointing
  at the published base — the monorepo is only the *base build's* concern.)

Current recipes:

| Recipe | Harness | Agent CLI added on top of base |
|---|---|---|
| [`railway-launcher-operator/`](railway-launcher-operator/) | claude-code / Haiku | none (claude-code is in the base) |
| [`railway-operator-codex/`](railway-operator-codex/) | codex | `@openai/codex@0.133.0` |

## The deploy contract

Every recipe shares the same runtime contract:

- **A `/data` volume, mounted at the service level** — never a `VOLUME` directive
  in the Dockerfile (Railway rejects it and it masks the entrypoint chown). On
  Railway: `railway volume add --mount-path /data`.
- **`JINN_STATE_DIR=/data`** (baked into the base). The daemon derives `earning/`,
  the SQLite db, `engine/impl-state/`, and `swe-rebench-v2/` under this one root —
  no per-key `JINN_EARNING_DIR` / `JINN_DB_PATH` / etc. overrides needed.
- **Seed env vars** (set in the service's Variables panel):
  - `CLAUDE_CODE_OAUTH_TOKEN` (claude-code recipe) **or** `CODEX_AUTH_JSON`
    (codex recipe) — the agent CLI credential.
  - `CONFIG_TEMPLATE_JSON` — the operator config, minified; seeded to
    `/data/config.json` on first boot only. Must carry the `joinedSolverNets`
    entry with the load-bearing `contract: { id, version }` field (#674).
  - `LAUNCHED_RECORD_JSON` *(launcher recipe only)* — the owned launched record,
    so the generator spawns.
  - `JINN_STATE_TARBALL_B64` *(optional one-shot migration)* — base64 of
    `tar -czf - -C ~/.jinn-client earning swe-rebench-v2`; extracted into `/data`
    only when `/data/earning` is absent (a redeploy never clobbers live state).
  - `JINN_PASSWORD` — keystore password (decrypts a migrated keystore, or sets
    the password for a fresh wallet).

## The separate claim-relayer service

**Earning requires the claim-relayer.** The operator daemon is **emit-only** — it
increments on-chain activity counters but does not itself settle reward claims.
Deploy [`packages/claim-relayer`](../packages/claim-relayer) as its own Railway
service alongside the operator; without it the operator accrues activity but
never claims. See that package's README for its own deploy + env contract.

## `railway.toml` — pin the Dockerfile path, never the repo root

Each recipe ships its own `railway.toml` pinned to its overlay Dockerfile, and
the service must set **Settings → Config as code → `deploy/<recipe>/railway.toml`**.
**Never** put a `railway.toml` at the repo root — Railway applies a root
config to *every* monorepo service (jinn-indexer, jinn-worker, …), overriding
their build configs and forcing this operator image on them. That is what took
the indexer offline for hours (#846).

## Headless observability

`/v1/status` carries the headless readouts — ai-units, loop-completion rate,
impl-state commit cadence, and earning (S6/#959). No more `railway ssh` + SQLite
spelunking; the `measure-learning.sh` script is **retired**.

## Verify the consolidation (regression reference)

Run this after merge, in CI or against a real Railway deploy, to confirm the
overlay path is equivalent to the pre-consolidation recipe — with **none** of the
four daemon-correctness bash lines in the entrypoint:

1. **Build the launcher overlay** against a base tag that includes #988
   (`docker build -f deploy/railway-launcher-operator/Dockerfile --build-arg BASE_TAG=<release> .`).
2. **Deploy it** with the same `JINN_STATE_TARBALL_B64` + `CONFIG_TEMPLATE_JSON`
   + `LAUNCHED_RECORD_JSON` the #952 launcher used, and a `/data` volume.
3. **Assert** the daemon reaches launched/generating state (a launched record is
   loaded, the generator spawns, task-creation on the indexer is non-zero) and
   `/v1/status` shows the same readouts (ai-units cap engaged, loop-completion,
   impl-state cadence, earning).
4. **Confirm the entrypoint is clean** — none of the four daemon-correctness bash
   lines remain in the overlay seed scripts:
   - `gosu node …` (the base entrypoint does the drop, not the overlay),
   - `rm -f …/daemon.pid` (#955, daemon-owned),
   - `find … -name '._*' -delete` (#954, daemon-owned),
   - `JINN_SWE_REBENCH_V2_STATE_DIR` / `JINN_ENGINE_IMPL_STATE_DIR_ROOT`
     state-dir seeding (#956, daemon derives from `JINN_STATE_DIR`).

   Static check:
   ```bash
   grep -RnE "rm -f .*daemon\.pid|find .*-name '\._\*'|JINN_SWE_REBENCH_V2_STATE_DIR|JINN_ENGINE_IMPL_STATE_DIR_ROOT|gosu node" deploy/
   ```
   must return nothing.
