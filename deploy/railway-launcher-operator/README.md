# Railway deploy — launcher+operator (claude-code / Haiku)

Hosts the operator's single `jinn run` daemon that is **both** the SWE-rebench v2
launcher/generator and a solver — one wallet, both roles. Standing this up on a
supervised host is how we stop the task-generator gaps that fail Milestone 1
blocks (see `docs/superpowers/specs/2026-06-01-host-supervised-launcher-operator-daemon-design.md`).

Run locally with `jinn run`; this directory is only for the headless hosted deploy.

## Required Railway env vars (secrets)

| Variable | Source | Purpose |
|---|---|---|
| `JINN_PASSWORD` | the operator's existing keystore password | Decrypts the migrated keystore. |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` on a logged-in machine | Authenticates Haiku headless **and** keeps the AI-units throttle engaged. **If unset, the throttle is silently OFF.** |
| `CONFIG_TEMPLATE_JSON` | the operator config, minified | Seeded to `/data/config.json` on first boot. Must include the `joinedSolverNets[<cid>]` entry with `harness: "claude-code"`, `model: "claude-haiku-4-5-20251001"`, and the load-bearing `contract: { id, version }` field (#674). |
| `JINN_STATE_TARBALL_B64` *(migration)* | `base64` of `tar -czf - -C ~/.jinn-client earning` | One-shot restore of keystore + stake state + launched record. Extracted only when `/data/earning` is absent. |
| `LAUNCHED_RECORD_JSON` *(fresh, alt to tarball)* | the owned `…/launched/<id>.json` | Seeds the launched record so the generator spawns. Redundant if the tarball already carries it. |

Baked-in defaults (override via Railway env): `JINN_NETWORK=testnet`,
`JINN_AUTO_TESTNET_FAUCET=1`, `JINN_EARNING_DIR=/data/earning`,
`JINN_DB_PATH=/data/jinn.db`, `JINN_CONFIG=/data/config.json`.

> Auth mechanism is **env-only** — the Task 0 spike confirmed the claude CLI
> (verified at `@anthropic-ai/claude-code@2.1.159`, pinned in the Dockerfile)
> authenticates non-interactively from `CLAUDE_CODE_OAUTH_TOKEN` alone, with no
> `~/.claude.json` file. The entrypoint's file-based fallback stays commented
> out unless a future CLI version stops honouring the env var.

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
2. Export local state: `tar -czf - -C ~/.jinn-client earning | base64 | tr -d '\n' > state.b64` → set as `JINN_STATE_TARBALL_B64`.
3. Set the other secrets above; attach the volume; set the config-as-code path.
4. Deploy: from the repo root, `railway up --service <name> --environment production --ci -m "launcher-operator cutover"`.
5. Confirm the staked service re-appears in the staking contract's `getServiceIds()` and the generator resumes (see Verification).

## Funding

The agent EOA needs Base Sepolia ETH (gas + task-creation fees); the Safe needs
OLAS for the bond. On a migration the wallet is already funded/staked, so this is
moot. For a fresh wallet, `JINN_AUTO_TESTNET_FAUCET=1` only fires in Stage 2 — drip
the EOA manually past the Stage-1 minimum (~0.02 ETH) first.

## Verification

- Boot log shows `[ai-units] cap=100/2800 per (block, week)` → throttle engaged. **If absent, the credential didn't resolve — check `CLAUDE_CODE_OAUTH_TOKEN`.**
- `[entrypoint] claude CLI: <version>` and `[creator] …` task-posting lines appear.
- Task-creation rate on the indexer is non-zero and continuous (no gap > a few minutes).

## Caveats

- **Supply single-point-of-failure.** This box is now the sole task creator. `ON_FAILURE`
  restart + the task backlog buffer + an alert on stalled task-creation mitigate it; the
  *second* distinct operator M1 needs comes from the fleet on independent infra.
- True supply redundancy needs a **second** launcher with its own wallet + launch (future).
- A Claude OAuth token lives in Railway secrets (same posture as the codex recipe's `CODEX_AUTH_JSON`).
