# Railway deploy — codex-harness operator

A reference Railway deployment for a hosted `@jinn-network/client` operator daemon running the **codex** harness against Base Sepolia testnet. This is the recipe currently running service 62 in production; documented here so future operators have a starting point and so the recipe survives operator turnover.

Operators who want to run locally should use `jinn run` directly (see `operator/README.md`) — this directory is only for headless, hosted deployments.

## Shape: thin overlay on the container-native base

`Dockerfile` is a ~4-line overlay on `ghcr.io/jinn-network/client` (the
container-native base, #988):

```dockerfile
ARG BASE_TAG=latest
FROM ghcr.io/jinn-network/client:${BASE_TAG}
RUN npm install -g @openai/codex@0.133.0
ENV JINN_CONFIG=/data/config.json
COPY deploy/railway-operator-codex/seed.sh /usr/local/bin/jinn-codex-seed.sh
RUN chmod +x /usr/local/bin/jinn-codex-seed.sh
CMD ["/usr/local/bin/jinn-codex-seed.sh", "run", "--config", "/data/config.json"]
```

The base owns the non-root gosu-drop entrypoint, `JINN_STATE_DIR=/data` (the
daemon derives earning/db/impl-state/swe-rebench under it), env-auth, and no
VOLUME. `seed.sh` is **seeding-only**: it writes the codex auth file, sets the
git identity, seeds `/data/config.json` on first boot, then
`exec node dist/bin/jinn.js`.

`BASE_TAG` must point to a base release that includes #988. See
[`../README.md`](../README.md) for the full deploy path (the public-GHCR ops
step, the deploy contract, the claim-relayer, and the consolidation checklist).

- **`seed.sh`** — materialises per-deployment state from env vars on each boot:
  - Sets a global git identity so the harness's plugin session-start hooks can `git commit --allow-empty` to initialise their per-task workdirs without an `"Author identity unknown"` error.
  - Decodes the base64 `CODEX_AUTH_JSON` env var into `$CODEX_HOME/auth.json` so the Codex CLI is authenticated without an interactive login.
  - Seeds `/data/config.json` from `CONFIG_TEMPLATE_JSON` on first boot only — durable config lives on the Railway volume after that.
- **`railway.toml`** (in this directory — **must NOT be at the monorepo root**) — points Railway at this Dockerfile and sets `restartPolicyType=ON_FAILURE` with 10 retries. A root `railway.toml` is applied by Railway to *every* service that deploys from this monorepo — including `jinn-indexer` (Ponder), `jinn-worker`, etc. — overriding their own build configs. That is exactly what broke the indexer for hours (#846). So this recipe lives here, not at root, and **the codex-operator service must set its Railway "Config as code" path to `deploy/railway-operator-codex/railway.toml`** (Settings → Config-as-code) so the recipe applies only to it.

## Required Railway env vars

Set these in the service's Variables panel:

| Variable | Source | Purpose |
|---|---|---|
| `JINN_PASSWORD` | `openssl rand -base64 24` | Keystore password for the operator's wallet. Generate once; treat as a secret. |
| `CODEX_AUTH_JSON` | `base64 -i ~/.codex/auth.json \| tr -d '\n'` (from a machine where Codex is logged in) | Base64-encoded Codex auth file. Decoded into the container's `$CODEX_HOME/auth.json` on each boot. |
| `CONFIG_TEMPLATE_JSON` | The operator config JSON, minified onto one line | Seeded into `/data/config.json` on first boot. Must include a `joinedSolverNets` entry with a `contract: { id, version }` field (see [#674](https://github.com/Jinn-Network/mono/issues/674)). |

The base/overlay bake in these defaults (overridable via Railway env):

```
JINN_NETWORK=testnet
JINN_AUTO_TESTNET_FAUCET=1
CODEX_HOME=/data/codex-home
JINN_CONFIG=/data/config.json
JINN_STATE_DIR=/data        # base; the daemon derives earning/db/impl-state/swe-rebench under it
```

## Required Railway volume

Attach a volume mounted at `/data`. The daemon's keystore, earning state, SQLite database, codex auth, and operator config all live there.

## First-boot funding

`JINN_AUTO_TESTNET_FAUCET=1` enables the CDP faucet auto-drip — but it only fires inside Stage 2 of the bootstrap, not Stage 1. A cold-start operator with 0 ETH on the EOA gets stuck at `awaiting_funding` indefinitely until something funds the EOA past the Stage 1 minimum (~0.02 ETH at deploy time). Until [#661](https://github.com/Jinn-Network/mono/issues/661)'s "auto-faucet should cover Stage 1" sub-fix lands, you need to drip the EOA manually before the daemon can advance.

## Example operator config (`CONFIG_TEMPLATE_JSON`)

```json
{
  "joinedSolverNets": {
    "bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi": {
      "manifestCid": "bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi",
      "name": "swe-rebench-v2",
      "contract": { "id": "swe-rebench-v2", "version": "v1" },
      "roles": ["solver"],
      "harness": "codex",
      "model": "gpt-5.4-mini",
      "plugins": []
    }
  }
}
```

The `contract` field is load-bearing — without it the SolverNet entry silently never registers into the runtime claim flow (see [#674](https://github.com/Jinn-Network/mono/issues/674)).

## Deploying

From the monorepo root, after `railway link`-ing the service:

```bash
railway up --service <name> --environment production --ci -m "<message>"
```

The Railway CLI uploads the worktree (respecting `.gitignore`, so `node_modules` is skipped) and builds the Dockerfile remotely.

**One-time service setup (required since the recipe is not at the repo root):** in this service's Railway settings, set **Config as code → `deploy/railway-operator-codex/railway.toml`**. Without it the service falls back to nixpacks/auto-detect and won't build this Dockerfile. Do **not** move `railway.toml` back to the repo root — see the warning above (it hijacks `jinn-indexer` and every other monorepo service, #846).

## Earning needs the separate claim-relayer

The daemon is emit-only; earning settlement runs through the separate
`packages/claim-relayer` service — deploy it alongside this operator (see
[`../README.md`](../README.md)).
