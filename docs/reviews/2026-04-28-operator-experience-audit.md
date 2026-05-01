# Operator-Experience Audit: Agent-Driven Progressive Disclosure

Date: 2026-04-28
Task: `jinn-mono-964`
Lens: an AI agent helping a human operator go from "I want to run a Jinn node" to "my node is operating productively."

> **Update (jinn-mono-zqm2):** `jinn quickstart` has been removed; `jinn run`
> now subsumes its behaviour (init + funding check + bootstrap + foreground
> daemon, with the same auto-password and progressive-disclosure semantics).
> The corresponding MCP tool was renamed `jinn_run`. This audit's references
> to `jinn quickstart` (the verb and the MCP tool `jinn_quickstart`) describe
> the pre-zqm2 surface; underlying findings still apply to the unified
> `jinn run` where they were not surface-specific. Findings partially or
> fully closed by the unification: U5 (the "two canonical recipes"
> dichotomy is gone — there is now one first-run command), H2 (the
> help/`quickstart` vs `run` confusion is moot — the dichotomy is gone).
> Findings still open against `jinn run`: U1 (MCP parity), U3 (structured
> progress stream), W4 (plaintext password before preflight), H1 (skill
> content freshness).

## Entrypoint Analysis

The simplest plausible agent path is now `jinn --help` -> `jinn auth` -> `jinn quickstart` -> `jinn status`. That is the right shape: the top-level help names `quickstart`, the README leads with `jinn auth` and `jinn quickstart`, and operational verbs default to JSON for headless callers.

Where it actually lands:

1. `jinn --help` is good at verb discovery, but it does not identify the one canonical "new operator" path as strongly as the README does. The "Operator map" starts with `run`, not `quickstart`, so a help-only agent can reasonably over-index on `run`.
2. `jinn auth` is a necessary first step because runtime-mode detection still has a known filesystem fallback that can misdetect a source checkout as Docker Compose. A fresh probe from `client/` reported `claude_auth: Not authenticated (docker-compose)`, matching the known `jinn-mono-q6f` issue.
3. `jinn quickstart` is the intended one-shot, but its progressive state is mostly stderr text. The structured stdout record appears only on completion or fatal envelope. For a host agent, this is hard to poll, resume, or summarize without tailing logs.
4. The MCP/plugin path advertises "let your agent do it", but the MCP server does not expose `quickstart`, `auth`, `logs`, `rewards`, `claim-rewards`, `intents`, `keys`, `plugin`, or `update`. The installed skill then compensates with shell instructions, some of which are stale.

The net: the human-facing CLI is close to coherent; the agent-facing surface is not yet the same product. Agents still need shell access and repo/docs knowledge to complete the first 30 minutes safely.

## Progressive-Disclosure Map

| Step | What the agent tries | What it learns | What it still needs |
|---|---|---|---|
| Install / discovery | `jinn --help`, README | Commands, JSON-default contract, `auth`, `quickstart`, monitoring verbs | A single canonical first command in help, plus whether `npx @jinn-network/client@latest doctor` works with multiple bins |
| Runtime/auth | `jinn auth`, `jinn doctor --human` | Runtime mode, Claude binary/auth, RPC, deployment, keystore, compiled artifact status | A reliable non-heuristic auth context in source/package dirs; an agent-safe way to set mode and proceed without an interactive TTY |
| Wallet/config | `jinn quickstart` or `JINN_PASSWORD=... jinn init` | Password resolution, earning directory, master address, next step | Config/profile isolation surfaced everywhere; no secret file written before blocking preflight passes |
| Funding/bootstrap | `jinn fund-requirements`, `jinn bootstrap` | Funding gaps and bootstrap gates | A read-only funding plan. Today `fund-requirements` calls `FleetBootstrapper.bootstrap()`, which can mutate state, request faucet funds, and advance services |
| Daemon start | `jinn quickstart`, `jinn run` | Foreground daemon, dashboard URL, API status route | Machine-readable progress events and a detached/managed daemon path equivalent to what MCP exposes |
| Observability | `jinn status`, `jinn fleet`, `jinn logs`, dashboard | Status rollup, paths, local activity rows, dashboard when daemon is up | Stuck-state causality: "last bootstrap step", "last daemon loop event", "last Claude session", and "next operator action" in one structured view |
| MCP/plugin | `jinn plugin install`, MCP tools | Installs MCP plus copied skill for supported tools | Tool coverage parity with the CLI quickstart path, accurate generated skill docs, and explicit confirmation controls for mutating tools |
| Docs | README, `docs/operator-testnet.md`, `client/skills/jinn-operator/SKILL.md` | Good conceptual model and troubleshooting | One consistent first-30-minutes script; skill and runbook drift removed |

## Findings

### Wrong / Unsafe

**W1. `jinn fund-requirements` is not read-only.**

`fund-requirements` resolves the keystore password, constructs a `FleetBootstrapper`, then calls `bootstrapper.bootstrap(password)` to discover funding state (`client/src/cli/commands/fund-requirements.ts:116-137`). That bootstrap path can generate/hydrate wallet state, request Base Sepolia faucet funds, reconcile services, and advance bootstrap when enough ETH exists. The command name and help promise "list exact funding gaps"; agents will treat it as an inspection verb.

Proposal: split bootstrap into a read-only planning/probe API and a mutating advance API. `fund-requirements` should never call the mutating state machine, never request faucet funds, and should expose whether its answer is partial because a keystore or RPC is unavailable.

**W2. MCP `jinn_submit_intent` implicitly confirms on-chain action.**

The MCP tool accepts `dry_run` defaulting to false, then appends `--yes` whenever `dry_run` is false (`client/src/mcp/operator-server.ts:284-296`). In an agent workflow, "call a tool" and "spend gas / post an intent" need an explicit confirmation boundary that is visible in the tool schema.

Proposal: require a `confirm: true` parameter for mutating MCP calls, default to dry-run, and return a preview envelope with the exact follow-up tool call. Apply the same pattern to bootstrap/start-daemon where local or chain state changes are possible.

**W3. Plugin install can rewrite host-agent instruction/config files without preview.**

`jinn plugin install` appends MCP config and large skill blocks into user or project files for tools including Codex (`~/.codex/config.toml`, `~/.codex/AGENTS.md`) once a target is detected (`client/src/cli/commands/plugin-install.ts:504-545`, `558-647`). There is no `--dry-run`, backup path, diff summary, or `--yes` gate.

Proposal: make plugin installation two-phase: `plugin plan` or `plugin install --dry-run` emits exact target files and patches; `plugin install --yes` applies. Separate `--mcp-only` from `--skill-only` so agents can avoid changing global behavioral instructions unless the operator approves.

**W4. `quickstart` writes the plaintext auto-password before blocking preflight.**

When `JINN_PASSWORD` is absent, `quickstart` creates `~/.jinn-client/keystore-password` before RPC, port, and doctor checks (`client/src/cli/commands/quickstart.ts:126-168`, `188-219`). If a blocking preflight fails, a secret file is left behind even though no usable wallet may exist yet.

Proposal: run non-secret preflight first, then create the password immediately before `init`; or clean up the generated password file on preflight failure when no keystore was created. Include `passwordGenerated` and cleanup status in the error envelope.

### Unintuitive

**U1. The MCP surface does not expose the documented agent path.**

The README says an operator can wire Jinn into an agent and ask it to run `jinn quickstart` (`client/README.md:109-128`). The MCP server exposes lower-level tools such as `jinn_init`, `jinn_bootstrap`, and `jinn_start_daemon`, but not `jinn_auth`, `jinn_quickstart`, `jinn_logs`, `jinn_rewards`, `jinn_claim_rewards`, `jinn_intents`, or `jinn_keys_backup` (`client/src/mcp/operator-server.ts:219-339`). Agents therefore fall back to Bash for the recommended path.

Proposal: add MCP parity for the first-30-minutes lifecycle: auth status/mode, quickstart with structured progress, logs, rewards, intents list/enable/status, keys backup guidance, and update/plugin status. Tool descriptions should include mutability and expected duration.

**U2. Runtime-mode detection is documented as flawed and still affects fresh agents.**

`detectAuthContext` comments acknowledge that running from `client/` misdetects Docker Compose because the package compose file names `jinn-daemon` (`client/src/preflight/claude-auth.ts:14-16`, `90-115`). A fresh probe from this checkout produced `claude_auth: Not authenticated (docker-compose)`. Existing bead: `jinn-mono-q6f`.

Proposal: fix the heuristic rather than relying on `jinn auth` to paper over it. Ignore the package's bundled compose file, or only use compose mode when a persisted runtime mode or an operator-owned compose path exists.

**U3. `quickstart` is hard for an agent to monitor or resume.**

`quickstart` captures subcommand stdout internally and logs progress to stderr (`client/src/cli/commands/quickstart.ts:188-260`). During funding it can poll for 30 minutes, but stdout remains empty until completion or failure. An agent with only structured tool output cannot tell which step is active without parsing stderr.

Proposal: add `--json-progress` or emit newline-delimited progress envelopes on stdout for long-running lifecycle verbs. Include stable fields: `phase`, `step`, `attempt`, `blocking`, `nextAction`, `addresses`, and `estimatedWaitMs`.

**U4. Observability is split across status, fleet, logs, dashboard, and ad hoc files.**

`jinn status` has a useful rollup and paths, but its `exit.hint` can be a raw viem error when RPC fails. `jinn logs` reads only activity events and says "No events yet" on a fresh daemon store, which does not help with auth, bootstrap, faucet, Claude, or loop stalls. The runbook points to transcript paths under `/tmp`, while status does not surface those paths.

Proposal: add a single `jinn diagnose` or enrich `status --detail` with last bootstrap step, last daemon lifecycle event, last Claude session path/result, last chain tx, and next operator action. Keep `logs` for event streams, but do not make it the only "what happened?" affordance.

**U5. Documentation disagrees on password strategy and first-run shape.**

The README says `quickstart` auto-generates a password and no env var is needed (`client/README.md:32-49`). The testnet runbook still instructs operators to export `JINN_PASSWORD` before `quickstart` (`docs/operator-testnet.md:43-55`). Both are valid modes, but a first-run agent sees two canonical recipes.

Proposal: choose one primary path in every first-30-minutes doc. Recommend `jinn auth` -> `jinn quickstart` with auto-password for testnet, then show `JINN_PASSWORD` as an explicit advanced variant.

### Hygienic

**H1. Installed skill content is stale relative to the current CLI and MCP server.**

The `jinn-operator` skill says the package gives "17 verbs" and recommends `jinn-mcp` (`client/skills/jinn-operator/SKILL.md:42-44`, `55-75`), while top-level help currently lists many more verbs and `jinn mcp` is canonical. The skill also documents `jinn_rewards` as an MCP tool (`client/skills/jinn-operator/SKILL.md:78-92`), but the operator MCP server does not expose it.

Proposal: generate the skill's command/tool tables from the CLI command registry and MCP server definitions during build or release. At minimum, add a test that compares documented MCP tool names to registered server tools.

**H2. `jinn --help` and `quickstart --help` understate the agent path.**

Top-level help has an "Operator map", but `quickstart` appears only in the verb list, while `run` is the first lifecycle item. `quickstart --help` does not mention `jinn auth`, runtime mode, `--json` behavior, or the plaintext password file security tradeoff.

Proposal: make `jinn --help` explicitly say "New operator: run `jinn auth`, then `jinn quickstart`." Add "agent/script mode" examples to `quickstart --help`, including `--no-daemon` and the expected final JSON payload.

**H3. Config errors are structured, but config provenance is only partly visible.**

Invalid env/config values produce good `invalid_invocation` envelopes. However, most successful outputs do not include the resolved config source or profile. `status` includes paths, while `doctor` does not show the config file path when the default was absent.

Proposal: add a small `config` block to `doctor`, `version`, and lifecycle success payloads: `configPath`, `configLoaded`, `network`, `earningDir`, `dbPath`, `runtimeMode`, and redacted env overrides used.

**H4. `npx` documentation remains risky while multiple bins exist.**

The README still suggests `npx @jinn-network/client@latest doctor` (`client/README.md:103-107`). There is an existing open bead, `jinn-mono-7bc`, for ambiguity with multiple package bins.

Proposal: until the package shape is fixed, document the unambiguous form everywhere: `npx -p @jinn-network/client@latest jinn doctor`.

## Follow-Up Beads

Non-trivial fixes from this audit should be tracked as child beads of `jinn-mono-964`:

| Finding | Bead |
|---|---|
| W1 read-only funding plan | `jinn-mono-964.1` |
| W2 mutating MCP confirmation boundary | `jinn-mono-964.2` |
| W3 plugin install dry-run/confirmation | `jinn-mono-964.3` |
| U1/U3 MCP quickstart + structured progress | `jinn-mono-964.4` |
| H1 generated / verified operator skill docs | `jinn-mono-964.5` |
| U2 runtime-mode misdetect | Existing: `jinn-mono-q6f` |
| H4 npx ambiguity | Existing: `jinn-mono-7bc` |

## Verification Notes

Fresh-tree probes were run from `/Users/adrianobradley/harbor/jinn-mono/.tasks/jinn-mono-964` on branch `jinn-mono/jinn-mono-964`.

- Installed missing client dependencies with `yarn install` because `client/node_modules` was absent.
- Ran `yarn jinn --help`, `yarn jinn quickstart --help`, `yarn jinn doctor --help`.
- Ran `HOME=$(mktemp -d) yarn jinn init`; it correctly exited 11 with a structured missing-password envelope.
- Ran `HOME=$(mktemp -d) JINN_CLAUDE_PATH=/bin/false yarn jinn doctor --human`; it surfaced missing Claude binary, Docker-Compose auth context, source-build runtime artifact, RPC, deployment, and distributor checks.
- Ran `HOME=$(mktemp -d) JINN_RPC_URL=http://127.0.0.1:1 yarn jinn status`; it returned JSON with paths and a raw RPC failure hint.
- Ran `HOME=$(mktemp -d) yarn jinn logs --human`; it returned "No events yet."
- Ran `HOME=$(mktemp -d) yarn jinn plugin list --human`; it detected Claude Code and no other targets in this environment.
