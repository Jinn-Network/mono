# Rotating harness API keys

How an operator sets — and rotates — the provider credentials each Harness uses. Target audience: you run a Jinn daemon, a harness is reporting "auth expired" or silently failing its claims, and you need to know exactly which file or command to touch.

## The mental model: harness auth lives outside the Jinn app

The daemon does not hold your provider API keys. It spawns each Harness as a separate subprocess (the `claude`, `codex`, or `hermes` binary), and **each binary reads its own auth store** — the same store it would read if you ran it by hand. Jinn never persists `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` for you.

The one thing the daemon does is **forward an allowlisted set of environment variables** into the subprocess. Each adapter builds a scrubbed env from a fixed allowlist (the `buildAgentEnv` function in each adapter) — it does **not** pass `process.env` through wholesale. This is the mechanism behind the most common failure: a provider key set somewhere the allowlist or the harness's own auth store doesn't cover never reaches the spawned binary, and the harness fails its first model call. See [Why a wrong key fails](#why-a-wrong-key-fails) below.

So there are two valid ways to give a harness a key:

1. **Put it in the harness's own auth store** (the canonical path — survives restarts, no shell wiring). Done via the harness's `login` command or by editing its credential file.
2. **Put it in the daemon process's environment** under a name the allowlist forwards. Useful for containers and secret managers.

Both are documented per harness below. Do **not** use the repo's `operator/.env` for this — see [operator/.env is dev-only](#clientenv-is-dev-only).

## Per-harness reference

| Harness | Auth store (own its credentials here) | Canonical rotate command / file | Provider env vars the daemon forwards |
|---|---|---|---|
| **claude-code** (default) | `~/.claude/` (CLI session / OAuth) | `claude auth login` (interactive) or `claude setup-token` → a long-lived `CLAUDE_CODE_OAUTH_TOKEN`. Pay-per-request fallback: `ANTHROPIC_API_KEY`. | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` |
| **codex** | `auth.json` under `$CODEX_HOME` (default `~/.codex/auth.json`) | `codex login` (writes `auth.json`). Fallback: `OPENAI_API_KEY` in the daemon env. | `OPENAI_API_KEY`, `CODEX_HOME`, `JINN_CODEX_PATH` |
| **hermes-agent** | `$HERMES_HOME` (default `~/.hermes/`): provider keys in `~/.hermes/.env`, OAuth / pooled creds in `~/.hermes/auth/` + `~/.hermes/auth.json` | Edit `~/.hermes/.env` for the provider key (shipping catalog uses `OPENROUTER_API_KEY`); `hermes login` for OAuth. See note below. | any `*_API_KEY` / `*_API_TOKEN` / `*_TOKEN`, plus `OPENAI_API_KEY` and any `HERMES_*` var |

### claude-code (default harness)

If you authenticated the `claude` CLI on this host (`claude auth login`), you have nothing more to do — the harness reads `~/.claude/` directly. Rotate via the commands in the table. Prefer OAuth over a raw `ANTHROPIC_API_KEY`: the key works as a pay-per-request fallback but skips the prompt-caching / subscription tiers.

The Autopilot marketplace semantic evaluator is a deliberately stricter
exception: it runs Claude with an isolated `HOME` so host settings, plugins,
skills, and project instructions cannot affect a verdict. A host-only
`claude auth login` session is therefore not visible to that evaluator.
SolverNet evaluator daemons must provide `CLAUDE_CODE_OAUTH_TOKEN` (preferred)
or `ANTHROPIC_API_KEY` in the daemon environment. Readiness fails before a
marketplace claim when neither explicit credential is present.

In headless containers the host keychain is unavailable, so the OAuth token must be forwarded as `CLAUDE_CODE_OAUTH_TOKEN`. The Docker path for this is documented in [`operator/README.md`](../../client/README.md) (the "Docker" section) — note the distinction in the next section.

### codex

Use `codex login` (see the table). The daemon also forwards `CODEX_HOME` (so a non-default store location survives) and `JINN_CODEX_PATH` (the binary location). A leftover-but-expired `auth.json` reports `auth expired`, not "ready" — re-running `codex login` is the fix.

### hermes-agent

The provider key surface that is **verified in the adapter code** is the file `~/.hermes/.env`. Put the catalog's provider key there:

```
OPENROUTER_API_KEY=sk-or-...
```

(`OPENROUTER_API_KEY` is the provider var for the currently-shipping model catalog. Hermes also recognises `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, and others by name.) The daemon seeds each per-Task `$HERMES_HOME` from your real `~/.hermes/` (`.env`, `auth/`, `auth.json`), and additionally forwards any `*_API_KEY` / `*_API_TOKEN` / `*_TOKEN` (plus `OPENAI_API_KEY`) that is present in its own process env. So a key in `~/.hermes/.env` **or** in the daemon's shell env will reach `hermes chat`.

For OAuth / pooled credentials, run `hermes login`; it writes `~/.hermes/auth/` and `~/.hermes/auth.json`, which the daemon seeds per Task.

Model / provider precedence: `JINN_HERMES_MODEL` / `JINN_HERMES_PROVIDER` in the daemon env win over the per-SolverNet config value, which wins over `~/.hermes/config.yaml`. When `JINN_HERMES_BASE_URL` (a local OpenAI-compatible endpoint) is set the provider stays `custom` regardless of `JINN_HERMES_PROVIDER`; the model name is still env-overridable.

> Note on the rotate subcommand: a `hermes auth add` subcommand could **not** be confirmed in the harness code as shipped. The verified surfaces are `hermes login` (OAuth), the `~/.hermes/.env` file (provider key), and `hermes auth list` (used by the readiness probe). For an explicit add/rotate subcommand, run `hermes --help` against your installed version rather than relying on an unverified command.

## operator/.env is dev-only

**Do not put provider API keys in the repo's `operator/.env` and expect them to take effect at runtime — they will not reach the harness subprocess.**

`operator/.env` is loaded by `dotenv` in `operator/src/main.ts` **only** when `JINN_LOAD_DEV_ENV=1` or `NODE_ENV=development`, and it is resolved relative to the compiled module inside the repo checkout. The published global package (`npm install -g @jinn-network/client`, then `jinn run`) sets neither of those, and ships no `operator/.env`, so the file is never read in a normal operator install. It exists for repo contributors iterating from source. Use each harness's own auth store / command (the table above) instead.

**This is a different file from the docker-compose `.env`.** When you run the daemon under Docker Compose, [`operator/README.md`](../../client/README.md) tells you to create a `.env` next to `docker-compose.yml` holding `CLAUDE_CODE_OAUTH_TOKEN` (and `JINN_PASSWORD`). That one is read by `docker-compose` and injected into the container's `process.env`, where the adapter allowlist then picks it up — so it works. The warning here is only about the **repo `operator/.env`** that `main.ts` conditionally loads, not the docker-compose env-file.

## Why a wrong key fails

The symptom is a delayed, quiet failure rather than a loud startup error:

- **claude-code** spawned without a credential fails its `claude -p …` call with "Not logged in · Please run /login".
- **codex** without a key or `auth.json` is reported `auth not configured` (and a stale, expired `auth.json` is reported `auth expired`).
- **hermes-agent** spawns, completes plugin discovery and MCP registration, and then dies ~14 seconds later at the first model call with "Provider resolver returned an empty API key" (exit 1).

In all three cases the daemon's readiness check (it probes the responsible harness before spending gas on a claim) records the Task as FAILED locally with a clear reason instead of burning a claim. So a wrong or missing key shows up as harness-not-ready and failing claims, not a crash.

To confirm a key is actually loaded, use the operator console's **per-harness precheck / doctor panel** (the §2.9 Harness Selection surface in [`apps/operator-console/OPERATOR-APP-SPEC.md`](../../apps/operator-console/OPERATOR-APP-SPEC.md)) — it runs each harness's own readiness probe (the same probe the daemon uses) and reports installed / authenticated / ready, with a re-check action. If the panel says ready, the key is reaching the binary; if it says auth-expired or not-configured, rotate it via the table above and re-check.

## Links

- Operator testnet runbook: [`docs/operator-testnet.md`](../operator-testnet.md)
- Client README (Docker auth, SolverNet harness toggles): [`operator/README.md`](../../client/README.md)
- Operator app spec — §2.9 Harness Selection: [`apps/operator-console/OPERATOR-APP-SPEC.md`](../../apps/operator-console/OPERATOR-APP-SPEC.md)
