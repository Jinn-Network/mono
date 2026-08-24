# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Jinn Network monorepo. Phase 0 is complete (Base mainnet). Phase 1a shipped a JINN token + DAO + distribution on Sepolia/Base Sepolia, but that token stack is **superseded by DR-2026-06-30 (tokenless, OLAS-native)** — Jinn no longer launches its own token or runs its own chain; OLAS (Base) is the permanent unit of both stake and reward, and operators earn OLAS for verified completed-loop work. See `spec/2026-06-30-tokenless-olas-native.md` and `log/decisions/2026-06-30-tokenless-olas-native-pivot.md` (DR-2026-06-30). Forward roadmap is the **Phase A umbrella** under the knowledge-market substrate framing — see `spec/2026-04-30-phase-a-umbrella.md`, `docs/superpowers/plans/2026-04-30-phase-a-umbrella-plan.md`, `log/decisions/2026-04-30-knowledge-market-vision-framing.md` (DR-2026-04-30), and GitHub Discussions [#59](https://github.com/Jinn-Network/mono/discussions/59) (substrate vision) + [#57](https://github.com/Jinn-Network/mono/discussions/57) (paired GTM). The original Phase 1b roadmap (`spec/2026-04-06-phase-1a-design.md` §9, `docs/superpowers/plans/2026-04-06-phase-1a-tokenomics.md`) is subsumed: anti-farming decay and ve-JINN are shipped, evidence-schema work executes through Phase A.1, the residual challenge mechanism is re-homed to Phase B.2.

Jinn is a training protocol for agentic intents. It defines a loop (Creation → Execution → Evaluation → Knowledge) where intents are published with fees, participants attempt fulfillment, evaluators verify results, and knowledge accumulates to improve future attempts.

## Canonical Docs

Canonical docs are the repo's stable sources of truth. They change only via approved PRs (see `spec/2026-04-28-canonical-docs.md`). Always prefer canonical docs over restated information found elsewhere in the repo, and never redefine canonical content locally — link instead.

[`PRINCIPLES.md`](PRINCIPLES.md) — This document should be read by agents at the beginning of all new sessions. All decision-making should run through these principles. Agents should keep their thinking and actions, as well as attempt to keep their human users' thinking and actions, in line with the principles stated herein.

Other canonical docs:

- `SPEC.md` — read before reasoning about the protocol loop, roles, contracts, or phase boundaries
- `THESIS.md` — read before writing positioning, pitch, strategic copy, or any "why Jinn" framing
- `BRAND.md` — read before producing any user-facing artifact (UI, slides, docs, marketing copy)
- `GROWTH.md` — read before planning distribution, campaigns, channel strategy, or growth experiments
- `GLOSSARY.md` — read whenever a Jinn-specific term appears; never redefine terms locally
- [`apps/operator-console/OPERATOR-APP-SPEC.md`](apps/operator-console/OPERATOR-APP-SPEC.md) — read before designing, extending, or reasoning about the operator app's data model, actions, or notification taxonomy (referenced from `SPEC.md` Roles → Operator)

## Coding Rules

These rules apply to every task in this project unless explicitly overridden. Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

### Rule 1 — Think Before Coding
State assumptions explicitly. If uncertain, ask rather than guess. Present multiple interpretations when ambiguity exists. Push back when a simpler approach exists. Stop when confused. Name what's unclear.

### Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative. No features beyond what was asked. No abstractions for single-use code. Test: would a senior engineer say this is overcomplicated? If yes, simplify.

### Rule 3 — Surgical Changes
Touch only what you must. Clean up only your own mess. Don't "improve" adjacent code, comments, or formatting. Don't refactor what isn't broken. Match existing style.

### Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified. Don't follow steps. Define success and iterate. Strong success criteria let you loop independently.

### Rule 5 — American English in the codebase
Identifiers, CLI verbs, file names, env vars, paths, and user-facing copy use American English spelling. Canonical example: `distill` / `distillation`, never `distil`. Dated historical documents (specs, DRs, press releases) and pinned hash-published artifacts (e.g. versioned LLM prompts) are not retro-edited.

## Engineering handbook

How this team ships — cadence, dist-tags, work-shape taxonomy, AI workflow rules. Full text at [`docs/engineering/handbook.md`](docs/engineering/handbook.md). Always read the handbook before doing non-trivial work; it ratifies the SOPs that apply to every shape.

### Work shape (declare it before executing)

Seven shapes plus one emergency sub-flow plus one meta-shape (`design`, for design-only sessions whose output is a spec or DR, not implementation), keyed to Conventional Commits prefixes. Per DR-2026-05-20-b, the canonical surface for shape is the native GitHub **Issue Type** — nine org-level types (`feat`, `fix`, `refactor`, `spike`, `chore`, `docs`, `test`, `incident`, `design`). Set the Issue Type at create-time; replicate the shape as the PR title Conventional-Commit prefix. The `## Run-mode` body section is kept but slimmed to a one-line pointer to the handbook SOP for the declared type — it is no longer the source of truth.

- **`fix`** — bug fix. Regression test first. Skill chain: `systematic-debugging` → `executing-plans` → `verification-before-completion` → `receiving-code-review`.
- **`feat`** — feature. TDD. Skill chain: (`brainstorming` if ambiguous) → `writing-plans` → `test-driven-development` → `executing-plans` / `dispatching-parallel-agents` → `verification-before-completion` → `receiving-code-review`.
- **`refactor`** — architecture / migration. TDD + integration tests; required design upfront; stacked PRs required (strangler-fig).
- **`spike`** — research / exploration. Output is a finding, not code. Spike code does not merge.
- **`chore`** — deps, CI, dev tooling. Integration tests if touches a dep.
- **`docs`** — documentation. Canonical-doc changes need Discussion + CODEOWNERS approval.
- **`test`** — test-only. Meta test discipline.
- **`incident`** — hotfix sub-flow (`fix(incident)` in the PR title). Relaxed review; post-hoc regression test required as a follow-up Issue before closing the incident.
- **`design`** — meta-shape: design-only session whose output is a spec or DR, not implementation.

If an Issue does not fit one of these shapes, it is mis-scoped — split or reshape it. Per-shape SOPs (v0 flows) live in the handbook §The shapes of work; they evolve via iterative refinement (file a GitHub Issue under the engineering handbook umbrella when friction surfaces).

Routing is governed by three Project (v2) single-select fields set at Friday triage: **Blocked on** (`Nothing` / `Human` / `Another issue`), **Effort** (`Low` / `Medium` / `High` / `XHigh` / `Max` — the implementation reasoning-depth signal), and **Priority** (`P0` … `P4`). Autopilot's AI runtime is process-wide (`JINN_AUTOPILOT_RUNTIME=claude|hermes`), not selected per issue.

### Ten ratified AI workflow rules

1. **Worktree-for-multi-agent.** Multi-agent or speculative subagent work uses a separate git worktree (current convention: `git worktree add ../jinn-mono_worktrees/<name>`), not the primary checkout.
2. **Issues frame problems, not solutions.** GitHub Issue body = context + impact + acceptance criteria. Solutions go in design sessions or implementation plans, not the Issue body.
3. **GitHub Issues are the single SoR for engineering work.** All new engineering work originates as a GitHub Issue on `Jinn-Network/mono`. Per DR-2026-05-20-b, each axis has one canonical surface: shape is the native **Issue Type**; parent/child and epic are native **sub-issues**; Sprint and Status live on the "Jinn engineering" Project (v2); **Blocked on / Effort / Priority** are Project single-select fields. The `epic:*`, `sprint:*`, `agent:*`, `priority:*`, and redundant GitHub default labels are retired.
4. **Reviewed, then queued.** Review is a pipeline stage, not an identity ritual. The merge queue plus required CI is the quality gate for every PR into `next`. Generic approving-review count on `next` is 0: write users enqueue with Merge when ready when checks are green. CODEOWNER Approve is required only on the human-surface set in `.github/CODEOWNERS` (DR-2026-08-20; DR-2026-06-03's mechanism retained on that shrunk set, its "agent never satisfies CODEOWNERS" doctrine still superseded by DR-2026-08-18-b). Platform architecture ownership lives in `.github/architecture-owners`, not GitHub CODEOWNERS. GitHub refuses to record the authoring account's own CODEOWNER approval, so human-surface PRs are authored under a non-owner operator credential. Self-enqueue is permitted once required checks are green (and CODEOWNER Approve exists when the diff hits the set); the merge queue on `next` is the only merger of ordinary PRs (#1735 lineage). Autopilot is out of this gate's enforcement and never bypasses or weakens the queue or branch protection. Mechanical merge preparation must make the PR draft before mutation and the resulting head re-enters every merge gate. Exceptions: `fix(incident)` reviewer relaxation with documented justification; mechanical conflict resolution via the children ladder.
5. _(Deferred — supervised-diff for the self-modifying learner. Mechanism open.)_
6. **Integration tests > mocks for migration / contract surfaces.**
7. **TDD for new features, regression test for fixes.**
8. **Auto-canary on push to `next`; Monday-only named stable cut promotes `main`.** Cadence policy.
9. **`canary` for rolling patches, `latest` for Monday named.** Dist-tag policy.
10. **PRs target `next`, not `main`.** The only exception is `fix(incident)` hotfixes (target `main` directly, mandatory back-merge per `docs/runbooks/hotfix.md`). Branch protection on `main` enforces this (issue #589).

### Cadence

- Every push to `next` → npm `canary` (`<v>-canary.<sha>`).
- Monday named cut → v<semver> tag on `next` HEAD → npm `latest` → `promote-main.yml` fast-forwards `main`.
- Hotfix → PR to `main` directly; mandatory back-merge to `next`. See `docs/runbooks/hotfix.md`.
- Every Monday 09:00 UTC → GitHub Release draft (Hermes-style); Captain publishes; publish triggers npm `latest` + CHANGELOG auto-mirror.
- Pre-v1: weekly Build Notes cuts patch by default (`v0.1.3 → v0.1.4`). A Monday cut that lands an epic or significant capability can bump the minor (`v0.1.x → v0.2.0`). `v1.0.0` is reserved for far-future graduation (mainnet / exit-testnet / Phase 2), not `jinn-mono-uy6v`.

### Daily entry point

`eng-day` skill (in `.claude/skills/eng-day/`) is the canonical daily brief; it reads the Issue Type and the Blocked on / Effort / Priority Project fields. Fallback: `gh issue list --search 'is:open no:assignee'` + `gh pr list --search 'is:open draft:false'` (the fallback does not see the Project-layer routing fields).

## Repository Structure

```
legacy/jinn-cli-agents-reference/  Git subtree — historical Jinn agent repo, retained as
                 read-only reference (IMPORTANT: see below)

operator/          TypeScript daemon — the main runnable component
  src/
    main.ts              Production entry point (`jinn run` from the published package)
    config.ts            Config loader (file > env > defaults)
    index.ts             Library exports
    adapters/
      adapter.ts         ExecutionAdapter interface
      local/adapter.ts   In-memory adapter for testing
      mech/              OLAS Mech Marketplace + JinnRouter adapter
        adapter.ts       MechAdapter (production adapter)
        contracts.ts     Contract call helpers (submitRestorationJob, claimDelivery, etc.)
        types.ts         ABIs, config types, JINN_ROUTER_ABI
        claim-policy.ts  Request claim strategies
        ipfs.ts          IPFS upload/download via Autonolas gateway
        safe.ts          Safe wallet creation + viem clients
    daemon/
      daemon.ts          Orchestrates the long-running loops (see ARCHITECTURE.md §6)
      loop-heartbeat.ts  LOOP_REGISTRY — loop names, intervals, admission class
      creator.ts         Posts desired states via adapter
    runner/
      runner.ts          Runner interface
      claude.ts          Spawns Claude CLI via MCP for restoration/evaluation
      simple.ts          Callback-based runner for testing
    earning/
      bootstrap.ts       11-step state machine (wallet → Safe → staking → mech)
      contracts.ts       Chain config, ABIs, Base addresses
      safe-adapter.ts    Safe deployment + batch tx execution
      store.ts           Earning state persistence (~/.jinn-client/earning/)
      types.ts           EarningState Zod schema
    store/store.ts       SQLite persistence (activity, artifacts, recovery)
    api/
      server.ts          Hono HTTP API for artifact search/publish
    auth/erc8128.ts      ERC-8128 HTTP message signatures
    discovery-client/    Neutral HTTP-indexer slice (R3b, four methods)
    plugin-registry/     Plugin publication reads (R3a)
    archive/             Projector-backed task-post counts / status chips
    mcp/server.ts        MCP tools exposed to Claude subprocess
    x402/                Payment-gated artifact access
    types/               DesiredState, errors, core types
  scripts/
    e2e-validate.ts      Self-contained e2e test on Anvil fork
    staking-validate.ts  Earning bootstrap validation
    mock-agent.ts        Mock agent for testing (replaces Claude)
  fixtures/
    config.example.json  Example config file
    local-config.json    Local adapter test config
  test/                  Vitest tests (see docs/runbooks/testing.md)

contracts/       Solidity smart contracts (Hardhat)
  src/
    claiming/
      ClaimRegistry.sol        On-chain claim coordination
      AcceptAllChecker.sol     Phase 0 eligibility (accept all)
      IEligibilityChecker.sol  Checker interface
    staking/
      RestorationActivityChecker.sol  OLAS activity checker
  test/                        Hardhat tests
  scripts/                     Deployment scripts

spec/            Dated specification proposals
docs/            Design specs and implementation plans
```

## jinn-cli-agents-reference

**Always check `legacy/jinn-cli-agents-reference/` when working on OLAS integration, staking, tokenomics, or Phase 1 contracts.** This subtree (from github.com/oaksprout/jinn-gemini) contains a wealth of relevant context. It is retained deliberately as reference material — the `-reference` suffix marks it consulted-but-never-built: it carries no `package.json`, is in no workspace, and nothing in the repository imports from it. Paths below are relative to that directory:

- `contracts/staking/` — JinnRouter.sol (the deployed router), DeliveryActivityChecker, WhitelistedRequesterActivityChecker, deployment JSONs with all on-chain addresses
- `docs/context/olas-protocol.md` — Full OLAS architecture: governance (veOLAS, Governor, Timelock), registries, tokenomics (Treasury, Dispenser, Depository, Tokenomics epochs)
- `docs/context/olas-integration.md` — Wallet/key storage, service lifecycle, operating modes
- `docs/reference/jinn-staking.md` — All deployed staking contracts (V1-V3), parameters, reward economics, veOLAS lock strategy, nominee mechanics
- `docs/reference/olas-contracts.md` — Base mainnet contract addresses, MechMarketplace ABI
- `docs/reference/blood-written-rules.md` — Hard-won operational lessons (RPC limits, IPFS, polling, etc.)
- `docs/runbooks/` — Setup, deployment, recovery, troubleshooting guides
- `CLAUDE.md` — System architecture overview for the agent orchestration layer

## Running the Client

### Prerequisites

- Node.js 22 (`corepack enable` once so Yarn matches each package’s `packageManager` field)
- Foundry (`anvil` for local fork, `cast` for funding)
- Claude Code CLI (`claude` in PATH — the daemon spawns it as a subprocess)

### Quick validation (Anvil fork, no real funds)

```bash
cd operator
yarn install
yarn typecheck   # should be zero errors
yarn test        # vitest suite, all pass
yarn e2e         # full loop on Anvil fork of Base
```

The e2e script spawns Anvil, bootstraps from scratch, runs create → restore → evaluate, and verifies staking rewards. Needs internet (Base RPC + IPFS).

### How the daemon is meant to be launched

The operator daemon is published as `@jinn-network/operator`. The intended operator
flow is:

1. `npm install -g @jinn-network/operator@latest` (or `yarn global add …`).
2. `jinn run` — the binary in the published package executes the compiled
   `dist/` tree. The human surface is the operator console (`apps/operator-console`).

The CLI auto-generates a keystore password on first run and reads it from
`~/.jinn-operator/keystore-password` thereafter (read-fallback from a populated
`~/.jinn-client` when the new directory is empty); set `JINN_PASSWORD` only if
you need to manage the password yourself (CI, secrets manager).

```bash
jinn run                                   # default config at ~/.jinn-operator/config.json
jinn run --config ./my-config.json         # alternate config file
JINN_PASSWORD=your-secret jinn run         # supply password via env (no on-disk file)
```

The daemon will:
1. Run the earning bootstrap (wallet → Safe → service → staking → mech)
2. Pause at `awaiting_funding` if the wallet needs ETH/OLAS — fund and re-run
3. Start the daemon's long-running loops — which ones depends on vertical mode and config; see [`operator/ARCHITECTURE.md`](operator/ARCHITECTURE.md) §6

### Repo contributors only

When iterating inside this repo, run the *built* binary so you get the same
headless daemon the published package ships. The human surface is the operator
console (`apps/operator-console`), not a bundle served from the daemon:

```bash
cd operator
yarn build
node dist/bin/jinn.js run
```

In another terminal:

```bash
cd apps/operator-console
yarn dev
```

`yarn jinn run` (tsx + src) works for daemon-side iteration. The daemon origin
has no human surface (`GET /` returns `{ "error": "no_human_surface" }`).

### Running against Anvil fork (local dev)

```bash
# Terminal 1: start Anvil
anvil --fork-url https://mainnet.base.org --port 8545

# Terminal 2: create config and run
mkdir -p ~/.jinn-client
cat > ~/.jinn-client/config.json << 'EOF'
{
  "rpcUrl": "http://127.0.0.1:8545",
  "claudeModel": "claude-haiku-4-5-20251001",
  "tasks": [
    {
      "id": "test-1",
      "description": "The service is healthy and responding.",
      "solverType": "prediction.v0",
      "role": "restoration",
      "spec": {}
    }
  ]
}
EOF

JINN_PASSWORD=test jinn run
# Will pause at awaiting_funding — fund via cast, then re-run
```

Funding on Anvil (use pre-funded account):
```bash
# Fund EOA with ETH
cast send <EOA_ADDRESS> --value 0.01ether \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://127.0.0.1:8545

# Fund Safe with OLAS (impersonate a whale)
cast rpc anvil_impersonateAccount <OLAS_WHALE> --rpc-url http://127.0.0.1:8545
cast send 0x54330d28ca3357F294334BDC454a032e7f353416 \
  "transfer(address,uint256)" <SAFE_ADDRESS> 5000000000000000000000 \
  --from <OLAS_WHALE> --rpc-url http://127.0.0.1:8545 --unlocked
```

## Config

Config file first, env var override. File at `~/.jinn-client/config.json` or `--config <path>`.

| Config key       | Env override             | Default                           |
|------------------|--------------------------|-----------------------------------|
| rpcUrl           | BASE_RPC_URL/JINN_RPC_URL| mainnet (default fallback chain): `["https://mainnet.base.org", …4 more]` · testnet (default fallback chain): `["https://base-sepolia.publicnode.com", …3 more, "https://sepolia.base.org"]` (≥5 free providers per chain, #911) |
| claudeModel      | JINN_CLAUDE_MODEL        | claude-haiku-4-5-20251001         |
| hermesModel      | JINN_HERMES_MODEL        | per-SolverNet config (env wins over SolverNet config) |
| hermesProvider   | JINN_HERMES_PROVIDER     | per-SolverNet config (env wins; ignored when a base_url/custom endpoint is set) |
| claudePath       | JINN_CLAUDE_PATH         | claude                            |
| pollIntervalMs   | JINN_POLL_INTERVAL_MS    | 5000                              |
| apiPort          | JINN_API_PORT            | 7331                              |
| dbPath           | JINN_DB_PATH             | ~/.jinn-client/jinn.db            |
| earningDir       | JINN_EARNING_DIR         | ~/.jinn-client/earning            |
| peers            | JINN_PEERS               | [] — parseable but unused after Wave-4 D4 (peer-sync retired) |
| tasks            | JINN_TASKS               | []                                |
| discovery.mode   | JINN_DISCOVERY_MODE      | kept parseable (R3b survivors, corpus HTTP, MCP); Wave-4 D4 deleted the `discovery/` factory |
| discovery.url    | JINN_DISCOVERY_URL       | testnet only: `DEFAULT_TESTNET_DISCOVERY_URL` (Ponder indexer); mainnet: unset — `createHttpCorpusDiscovery` and `discovery-client` |
| discovery.fallbackToOnchain | JINN_DISCOVERY_FALLBACK | parseable but unused after Wave-4 D4 (`with-fallback` retired) |
| ipfsRegistryUrl  | JINN_IPFS_REGISTRY_URL   | https://registry.autonolas.tech   |
| ipfsGatewayUrl   | JINN_IPFS_GATEWAY_URL    | https://gateway.autonolas.tech    |
| engine.workingDirRoot | JINN_ENGINE_WORKING_DIR_ROOT | ~/.jinn-client/engine/work   |
| engine.implStateDirRoot | JINN_ENGINE_IMPL_STATE_DIR_ROOT | ~/.jinn-client/engine/impl-state |
| engine.knowledgeAutoload | JINN_ENGINE_KNOWLEDGE_AUTOLOAD | true — before each restoration harness spawn, auto-load the top-3 corpus solution records for the task's solverType into `task.context.corpusKnowledge` (higher evidence tiers preferred: attested > committed > self-signed; full content acquirable via MCP `inspect_record` / `acquire_artifact`). Corpus failure never blocks the solve path (#1393). |
| watchdogAutoRestart | JINN_WATCHDOG_AUTO_RESTART | false — loop watchdog (#1043). Off: a stale loop is detected, loud-logged, and emits a `loop_watchdog_stale` event. On: a stale loop also triggers a non-zero `process.exit` so Railway's ON_FAILURE policy restarts the daemon through its existing idempotent boot path. |
| faucetDailyTopupCap | JINN_FAUCET_DAILY_TOPUP_CAP | 10 — max faucet drips one "Top up from faucet" click issues in a batch, and the per-24h ceiling per wallet (#560) |
| faucetTopupCooldownMs | JINN_FAUCET_TOPUP_COOLDOWN_MS | 86400000 (24h) — once the daily cap is reached, the top-up action stays disabled until this window elapses since the first call of that batch (#560) |
| _(none — env-only)_  | JINN_EVAL_DISK_FLOOR_GB | 20 (free-disk floor in GB before each swe-rebench-v2 eval round; below it the runner prunes Docker and aborts the run cleanly if still short) |
| _(none — env-only)_  | JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS | 300000 (5 min) — wall-clock bound per short-lived CLI shell-out in the swe-rebench-v2 stack (`docker image inspect`, `docker rmi`, the `docker … prune` family, `git rev-parse`). On expiry the child is SIGTERMed (SIGKILL after 10s) and the call rejects with a typed `CommandTimeoutError`, distinct from a real non-zero Docker exit. Set `0` to disable; empty means unset, not disabled. Without it a wedged Docker daemon hangs a run indefinitely — and because the per-round prune runs in a `finally`, it blocked the grade job before its attempt record was written. |
| _(none — env-only)_  | JINN_SWE_REBENCH_DOCKER_PULL_TIMEOUT_MS | 1800000 (30 min) — separate, far larger bound for `docker pull`; multi-GB eval images legitimately take many minutes on a cold cache. Same expiry semantics as above; `0` disables. |
| _(none — env-only)_  | JINN_NATIVE_IPFS_FETCH_TIMEOUT_MS | 8000 (8s) — bound per native public-record IPFS `block/get` fetch (`createBaseSepoliaRecordTransport`, #30). Short by design: a locally-pinned block resolves in ms, and an unpinned CID's kubo DHT lookup (which never returns) must be abandoned fast so the eval-spec resolver's #2559 HTTP-locator fallback engages on the timeout the same way it does on a clean miss. Well below the 30s fleet worker lease TTL. A timeout REJECTS (miss/error, never valid empty bytes) so the digest check still guards any bytes that arrive. `0` disables the bound (unbounded); unset/invalid → default. |
| _(none — env-only)_  | JINN_NATIVE_HTTP_FETCH_TIMEOUT_MS | 20000 (20s) — bound per native public-record HTTP `byLocation` fetch (#30). Larger than the IPFS bound because a legitimately large record served over HTTP can take longer; still below the lease TTL. Same reject/`0`-disables semantics. |
| _(none — env-only)_  | JINN_AUTOPILOT_CLEANUP_ENABLED | enabled in active mode (default on). Opt out with `false`. Each active cycle sweeps dead attempt worktrees under `~/.jinn-operator/autopilot/attempts/v2/` (legacy `~/.jinn-client/...` is still read when that dir is populated and the new path is empty). |
| _(none — env-only)_  | JINN_AUTOPILOT_ATTEMPT_GRACE_MS | 1800000 (30 minutes). Dead dirty/ahead/preparing attempts are removed after this grace; clean+pushed attempts are removed immediately. |
| _(none — env-only)_  | JINN_AUTOPILOT_DISK_FLOOR_GB | 10. Below this free-disk floor on the attempts directory, autopilot force-evicts oldest dead attempts and pauses new worktree-creating claims until space recovers. |
| _(none — env-only)_  | JINN_EVAL_COMPUTE_USD_PER_HOUR | 0.20 — USD/hr compute rate; evaluator_cost_usd = monotonic grade() elapsed time × rate. Unset → default; invalid/zero or a non-finite computed cost → 0 with a warning. Never blocks an eval. |
| _(none — env-only)_  | JINN_NET_LIVENESS_WEBHOOK_URL | unset — generic incoming-webhook URL (Slack-compatible) for the cron-driven net-liveness probe (#1044, `yarn net-liveness`, `docs/runbooks/net-liveness.md`). Unset → NO-OP: the probe still classifies and logs, it just never posts. |
| _(none — env-only)_  | JINN_NET_LIVENESS_THRESHOLD_MINUTES | 30 — staleness threshold (minutes) for the net-liveness probe; converted to Base block-space at 30 blocks/min. |
| _(none — env-only)_  | JINN_VERSION_CHECK | enabled (default). Gates the start-time npm-registry check (#641) that logs one line when a newer `@jinn-network/operator` has been published and backs the dashboard's `update_available` banner. Opt out with `0` / `false` / `no` / empty. Best-effort — a registry outage degrades silently, never gates boot. |
| _(none — flag/env-only)_  | JINN_NATIVE_CONFIG_PATH | unset — path to the native-v1 structured config file for `jinn run --native-config <path>` (issue #2378). Resolution order: `--native-config` flag > this env var > default `~/.jinn-operator/native-config.json`. Deliberately never the legacy `config.json` — the legacy loader's shape-v2 migration and native's strict schema are mutually unsatisfiable on one file, so native gets its own file, own resolver, own loader (`operator/src/daemon/native-config-path.ts`), never routed through `loadConfig`/`migrateConfigShapeV2`. Naming a native config that resolves to effective mode `legacy` (an omitted or explicit `operator.verticalMode: "legacy"`) is `invalid_invocation`, never a silent legacy boot. |

`JINN_PASSWORD` is env-only — never in config files.

### RPC fallback chain (issue #592)

The `rpcUrl`, `ethereumRpcUrl`, `archiveRpcUrl`, `l2ProofRpcUrl`, and
`ethereumArchiveRpcUrl` config keys all accept **either a single string OR
an array of URLs**. Comma-separated env values (`BASE_SEPOLIA_RPC_URL=a,b`,
`JINN_RPC_URL=a,b`, `JINN_ETHEREUM_RPC_URL=a,b`) are split on commas. The
loader builds a viem `fallback({ rank: false })` transport under the hood:
primary is tried first, secondary on network error or HTTP 429 / 5xx,
capped at 6 providers (5 vetted free defaults + 1 operator-prepended paid
primary). `rank: false` is deliberate — operator slot order is preserved
(the issue's "Tenderly stays in slot 3" constraint). When every slot fails
the daemon throws `AllRpcsFailedError`.

Each supported chain ships a default of ≥5 distinct free RPC providers
(issue #911): Base Sepolia (84532) and Ethereum Sepolia (11155111) on
testnet, Base mainnet (8453) and Ethereum mainnet (1) on mainnet. The Base
Sepolia default leads with `https://base-sepolia.publicnode.com` (no-auth,
50k-block `getLogs` cap) and ends with `https://sepolia.base.org` (free
public Coinbase endpoint, 2k-block cap, last-resort backup). Operators with
paid keys (Alchemy / Tenderly) should **prepend** their URL to keep the free
chain as automatic backup (the prepended primary plus the 5 defaults fit
inside the 6-slot cap after dedup):

```json
{
  "rpcUrl": [
    "https://my-alchemy-key.example",
    "https://base-sepolia.publicnode.com",
    "https://sepolia.base.org"
  ]
}
```

On boot the daemon emits one line per slot
(`[rpc] L2 <host> ok latency=Nms` or `warn 429`) followed by the summary
`[rpc] L2 transport: fallback chain (N providers) — primary=<host>`. The
probe is log-only — secondary-slot 429s never gate startup; only
`checkRpcNetwork`'s chain-id mismatch against the head URL is fail-loud.

This is the JSON-RPC transport layer. It is **distinct from** the indexer
HTTP read path (`discovery.url` / `JINN_DISCOVERY_URL`), which
`createHttpCorpusDiscovery` and `operator/src/discovery-client/http.ts`
still consult. The RPC fallback chain operates beneath both.

`discovery.url` / `discovery.mode` / `JINN_DISCOVERY_URL` stay (R3b
survivors, evidence CLI, `jinn tasks watch`, MCP env, corpus HTTP).
Wave-4 D4 deleted `operator/src/discovery/` (factory, on-chain floor, HTTP
fat client, `with-fallback`); `fallbackToOnchain` remains parseable but
is not consulted. When the indexer is unreachable those HTTP readers
raise `DiscoveryUnavailableError` — there is no silent `eth_getLogs`
fall-through.

## On-Chain Addresses (Base)

| Component              | Address                                      |
|------------------------|----------------------------------------------|
| JinnRouter             | `0xfFa7118A3D820cd4E820010837D65FAfF463181B` |
| Activity checker proxy | `0x477C41Cccc8bd08027e40CEF80c25918C595a24d` |
| Mech marketplace       | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |
| Staking contract       | `0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54` |
| OLAS token             | `0x54330d28ca3357F294334BDC454a032e7f353416` |

## Architecture

Per DR-2026-06-30 (tokenless, OLAS-native), Jinn has no DAO token, no treasury emissions, and no bespoke distribution contracts. **OLAS (Base) is the economic layer** — it supplies stake, staking emissions, veOLAS nomination, and the stOLAS zero-capital onboarding rail. Jinn's own on-chain surface is deliberately tiny: **one activity checker + one thin recorder**, everything else OLAS-native and unmodified.

1. **Economic layer (OLAS, Base)** — OLAS is the unit of both stake and reward. OLAS staking emissions (directed by Jinn's veOLAS nominee) are the bootstrap subsidy; the launcher-escrowed per-task marketplace delivery fee is the demand economy. Zero-capital onboarding via the stOLAS `ExternalStakingDistributor` (bond lent; operator recorded as curating agent, keeps ≈85%).
2. **Jinn-custom on-chain surface (Base)** — one **activity checker** (counts completed-loop activity toward OLAS staking liveness) + one thin **recorder** (`TaskCoordinator`/`JinnRouterV3`, trimmed: anchors each `(task, solution, verdict)` tuple, enforces self-eval prevention, sequences solver credit; gates no payout). Retains the launcher delivery-fee escrow.
3. **Execution layer (Base)** — OLAS Mech Marketplace (request/delivery, first-delivery-wins), OLAS service/mech/Safe infra, ERC-8004 (knowledge discovery). Knowledge is recorded on-chain now, priced later.

### How the daemon works

See [`operator/ARCHITECTURE.md`](operator/ARCHITECTURE.md) for the integrating narrative — operator app, CLI, daemon loops, task lifecycle, and extension points. There is no fixed daemon shape: **every loop is conditional**, so the running set depends on the vertical mode (`legacy` or `native-v1`) and config. Today that set is `work` and `evaluator` (the native solve and evaluate paths), `posting`, `projector`, `evidence-driver`, and the support/earning loops (`reward-claim`, `balance-topup`, `eviction-check`, `checkpoint`, `harvest`). Startup runs one-shot in-flight recovery before any loop takes work. `LOOP_REGISTRY` in `operator/src/daemon/loop-heartbeat.ts` is the single source of loop names, heartbeat intervals, and admission class; the started set is computed in `Daemon.start()` (search `started.add(`). Wave-4 D1 retired `engine-watcher` and `engine-tick` with the TaskEngine, D2 retired `delivery-watcher`, D3 retired `creator`, and D4 retired `peer-sync`; Wave-4 D6 removed all five leftover `LOOP_REGISTRY` rows. Remaining ten: `posting`, `reward-claim`, `balance-topup`, `eviction-check`, `checkpoint`, `harvest`, `projector`, `evidence-driver`, `work`, `evaluator`. Per DR-2026-06-30 the reward-claim loop is the sole reward path (stOLAS `RewardClaimLoop`); the former L2→L1 jinn-claim loop was removed with the JINN token. Each loop's tx calls increment on-chain activity counters that the OLAS staking contract reads at checkpoints to determine reward eligibility.

Generators are **launched-record-driven**, not config-flag-driven (per `spec/2026-05-05-solvernet-creation-and-launch.md` §11). On startup the daemon walks `~/.jinn-client/solvernets/launched/` for records this operator owns; for each record where `status === 'launched'` and `generatorEnabled === true`, it spawns the matching SolverType-specific generator. The legacy `taskGenerator.enabled` config flag and the predecessor Launcher mode's `roles.includes('launching')` gate are gone — gating is "do I have a launched record where I'm the owner." Joining a SolverNet as an operator (writing a `joinedSolverNets[<manifestCid>]` config entry, see §12) never starts a generator; that's launcher-only.

Operator participation is keyed by `manifestCid`, not by SolverNet name. The operator's local config has the shape `joinedSolverNets[<manifestCid>] = { name, manifestCid, roles, harness, plugins, model }` — one entry per launched SolverNet the operator has joined. Edits to this shape are restart-required; the daemon does not hot-reload SolverNet config. Claim eligibility filters on these entries: a daemon with no joined SolverNets does not claim *any* tasks, and tasks whose `solverNetManifestCid` is not in `joinedSolverNets` are ignored regardless of contract type. Each `harness` reads its own auth store (the daemon only forwards an allowlisted env set); for the per-harness auth store + rotate command, and why `operator/.env` is repo-dev-only, see [`docs/operator/rotating-harness-keys.md`](docs/operator/rotating-harness-keys.md).

### Earning bootstrap

The `EarningBootstrapper` walks through 11 idempotent steps:
1. wallet — create agent EOA + encrypted keystore
2. safe_predicted — predict Safe address
3. awaiting_funding — gate until EOA has ETH + Safe has OLAS
4. safe_deployed — deploy Safe via factory
5. service_created — register service on-chain
6. service_activated — approve OLAS bond + activate
7. agents_registered — register agent in service
8. service_deployed — deploy service
9. service_staked — stake service in staking contract
10. mech_deployed — deploy mech via marketplace
11. complete

State persists to `~/.jinn-client/earning/earning_state.json`. Safe to interrupt and re-run.

## Key Roles

- **Creator** — defines desired states and funds restoration
- **Restorer** — attempts to make desired states true
- **Evaluator** — independently verifies restoration success

## Phased Rollout

- **Phase 0** (complete): Prove on OLAS ecosystem, single chain (Base), OLAS Mech Marketplace + JinnRouter, optimistic evidence, no JINN token
- **Phase 1a** (complete; token stack superseded): Forked OLAS contracts and deployed a JINN token + Treasury + distribution on Sepolia/Base Sepolia with multisig governance. The JINN-token deliverable is dropped by DR-2026-06-30 (tokenless, OLAS-native); the OLAS staking / mech / Safe infra proven here carries forward.
- **Phase A** (in progress): Knowledge-market substrate framing per DR-2026-04-30. A.1 operational loop (corpus library + gating leak fix + manifest hygiene + cache + MCP rewiring) shipped; A.2 plug-in surface and A.3 campaign infra shipped; A.4 campaign-launch / SolverNet creation + launch experience shipped on testnet (`spec/2026-05-05-solvernet-creation-and-launch.md` v0.2 — Launcher SPA, manifest-anchored registry, operator join flow, manifest-cid claim eligibility). See `spec/2026-04-30-phase-a-umbrella.md`. Subsumes the original Phase 1b roadmap; anti-farming decay + ve-JINN already shipped, residual challenge mechanism re-homed to Phase B.2.
- **Phase B** (parallel after A.1): Trust infrastructure — B.1 verifiability tier activation, B.2 evaluator economics + signal-design (includes challenge mechanism)
- **Phase C** (gated by community formation): Flagship marketplace API — the canonical app the team ships in-house
- **Phase 2**: Mainnet — run the tokenless, OLAS-native model on Base mainnet, where real OLAS emissions, veOLAS nomination, and the stOLAS pool exist (per DR-2026-06-30). No fair-launch token and no bespoke multi-chain distribution.
- **Phase 3**: Autonomous — the launcher-funded demand stream (marketplace delivery fees) sustains the network beyond the OLAS staking subsidy; knowledge-pricing turns the corpus into the get-better incentive.

## Testing

See [`docs/runbooks/testing.md`](docs/runbooks/testing.md) for the test SOP: pyramid,
where tests go, the mock policy, shared helpers. Design rationale lives in
[`docs/superpowers/specs/2026-04-24-test-architecture-design.md`](docs/superpowers/specs/2026-04-24-test-architecture-design.md).

## Development Commands

```bash
# Client
cd operator
yarn install         # install deps (CI: yarn install --immutable)
yarn build           # tsc compile + bundle SPA into dist/dashboard
yarn test            # vitest run
yarn e2e             # end-to-end on Anvil fork
yarn staking         # earning bootstrap validation on Anvil
node dist/bin/jinn.js run    # contributor daemon launch (after `yarn build`)

# Daemon + real harness + Anvil settlement loop e2e (jinn-mono-wyy6)
yarn e2e:daemon-harness   # production Daemon + real harness + Anvil settlement loop
                          # JINN_E2E_HARNESS=prediction-v1-baseline (default) | hermes-agent | claude-code | codex
                          # skips cleanly when the harness's API key is absent
                          # exercises: Anvil fork of Base, real FleetBootstrapper,
                          # locally-deployed JinnRouterV3 stack + mock IPFS,
                          # production Daemon class, claim → execute → deliver →
                          # activity-counter increment

# Contracts
cd contracts
yarn install
yarn test            # Hardhat tests
```

## Adding SolverTypes

To add a new **in-repo** SolverType (typed `spec`, `jinn tasks submit --spec-file`, optional auto-generators, and Harness/evaluator pairing), follow [`docs/runbooks/add-solver-type.md`](docs/runbooks/add-solver-type.md). SolverType definitions live under `operator/src/solver-types/`; Task documents live under `operator/src/tasks/`; Harness selection is owned by SolverNet config and `operator/src/harnesses/impls/index.ts` (`buildHarnesses`).

## Spec Conventions

Spec files are named `YYYY-MM-DD-<topic>.md` and placed in `spec/`. Each has a version, date, and author in the header.

## Frontends

All frontends in this repo follow the rules below. They exist so that any operator, contributor, or agent can reason about a frontend by reading its spec and the canonical design docs — without spelunking the component tree.

### Every frontend ships with a spec

Place the spec under `spec/` (or, for a frontend that already has a dedicated subtree, alongside its source — e.g. [`apps/operator-console/OPERATOR-APP-SPEC.md`](apps/operator-console/OPERATOR-APP-SPEC.md) or [`packages/indexer/explorer/EXPLORER-APP-SPEC.md`](packages/indexer/explorer/EXPLORER-APP-SPEC.md)) using the `YYYY-MM-DD-<topic>.md` convention from §Spec Conventions. The spec is the source of truth for the frontend's domain model, surfaces, and behavior. UI changes that alter the model or the action surface land *with* a spec update in the same PR.

### Spec must include a domain model

The domain model enumerates every component the frontend exposes (in the product sense — "Wallet", "Daemon", "SolverNet", not the React-component sense). Each component is described along four axes:

- **State** — point-in-time values about the component. E.g. *daemon status: running | not running*; *wallet balance: 12.4 OLAS*; *staking epoch: 38*. State is read-only, derivable from the underlying data source, and rendered as-is.
- **State messages** — information about the component's state that requires human attention. E.g. *"Node requires restart to pick up new config"*; *"Safe is under-funded for the next checkpoint"*. Each state message MAY map to one or more **optional actions** (see Actions below) that resolve or acknowledge it. Messages without actions are purely informational and must say so.
- **Collections** — lists of data items owned by or pertaining to the component. E.g. *wallet transactions*, *recent tasks*, *peer list*, *delivery history*. Each collection declares its item shape, ordering, and any pagination/filtering rules.
- **Actions** — verbs a human can invoke against the component. E.g. *node → restart*; *task → cancel*; *wallet → withdraw*. Each action declares its **action states/events** — the lifecycle the UI must render. Example for *restart*: `idle → restarting → restarted` (with `failed` as a terminal alternative). Actions that mutate on-chain state or move funds must list their confirmation and error states explicitly.

A component may have zero entries on any axis (e.g. a read-only component has no actions), but the spec must say so — silence is ambiguous.

### Stack: Next.js + shadcn/ui exclusively

- All new frontends use Next.js (App Router unless the spec calls out otherwise).
- All UI primitives come from [shadcn/ui](https://ui.shadcn.com). Compose, don't reinvent.
- **No custom components without attempting shadcn first.** Before authoring a custom component, search the shadcn catalog and document the attempt in the PR description.
- If no suitable shadcn component exists, request **"snowflake" approval** from a human maintainer before writing the custom component. The request must include:
  - Why no shadcn primitive (or composition of primitives) fits.
  - The ongoing **maintenance costs** of owning the snowflake: who maintains it, what it depends on, what breaks if shadcn ships an equivalent later, what the migration path back to shadcn looks like.
  - The smallest possible surface — snowflakes stay narrow.

Snowflake approvals are recorded in the PR thread; recurring patterns should graduate to a shared internal package rather than living as one-offs per app.

### Show, don't narrate — no helper-text cruft

**A frontend shows data; it does not narrate it.** Do not add caption, subtitle, legend, or footnote text whose only job is to describe, restate, or hedge what the UI already displays. A label plus its value is enough. This is a standing rule: remove such text on sight, and never add it.

"Helper-text cruft" is any of:

- **Restating the numbers as a sentence.** A card that already shows the stats does not also need "6 attempts contributed by 1 operator, in 2 clusters." Show the stats.
- **Narrating where the data lives or what a link does.** "Both links leave the explorer." / "the full payloads live in the IPFS envelope below." / "every trace: summary · steps · IPFS ref · anchor." The link and the section already say this.
- **Decorative status captions.** "launched · accepting tasks" under a running count; "newest first" is fine (it states the sort), but a mood caption is not.
- **Instructions for self-evident controls.** A Prev/Next pager needs no "click to page."

The test: if you deleted the sentence, would the user lose any *information they can't already see*? If no, delete it.

**If a term genuinely needs explaining, use a tooltip, not permanent caption text.** An `InfoTooltip` (or equivalent) puts the explanation one click away for the person who needs it and out of the way for everyone else. Reserve prose for empty states (which must say what fills them) and error states (which must say what failed and how to retry) — there, plain words are the content, not cruft.

### Design system

See §Design System below — `BRAND.md` for voice and posture, `DESIGN.md` / `DESIGN.json` for tokens, and the non-negotiables (no emoji, no decorative gradients, softened-brutalist corners).

## Design System

Voice and posture are canonical in [`BRAND.md`](BRAND.md) — read it before any user-facing artifact. The visual sidecar (tokens, spec) is below; folding it into `BRAND.md` is a separate spec.

**Root-level quick reference** (for `impeccable` and other skill consumers):
- [`BRAND.md`](BRAND.md) — voice, headless-brand posture, protocol-vs-narrative split, content non-negotiables. Canonical.
- [`DESIGN.md`](DESIGN.md) — visual spec in [Google Stitch format](https://stitch.withgoogle.com/docs/design-md/format/): YAML frontmatter with colours, typography, radii, spacing, and component tokens; six-section prose body (Overview, Colors, Typography, Elevation, Components, Do's and Don'ts).
- [`DESIGN.json`](DESIGN.json) — sidecar extending the frontmatter with tonal ramps, canonical OKLCH, shadow/motion/breakpoint tokens, and drop-in component HTML/CSS.

These three files are the root-level precipitate of `docs/design/jinn-design-system/`. If you're writing marketing copy, docs, slides, or product UI, start with `BRAND.md` (voice + posture) and `DESIGN.md` (visual). If you're extending the brand itself (new sigil, new palette variant, new surface treatment), continue to the long-form source below.

---

Jinn's design system lives at [`docs/design/jinn-design-system/`](docs/design/jinn-design-system/). **Read it before building any UI, slide, mock, docs page, marketing surface, or other user-facing artifact** — it's the source of truth for colors, type, voice, iconography, and surface rules.

Entry points, in order:
- [`BRAND.md`](BRAND.md) — voice and headless-brand posture (grounded in Other Internet's [*Headless Brands*](https://otherinter.net/research/headless-brands/)); which parts are protocol vs. narrative. Canonical.
- [`docs/design/jinn-design-system/project/README.md`](docs/design/jinn-design-system/project/README.md) — brand posture, voice/lexicon, visual foundations (colors, type, spacing, borders, shadows, radii, motion, layout), iconography
- [`docs/design/jinn-design-system/project/SKILL.md`](docs/design/jinn-design-system/project/SKILL.md) — short operational manifest and non-negotiables
- [`docs/design/jinn-design-system/project/colors_and_type.css`](docs/design/jinn-design-system/project/colors_and_type.css) + [`foundations.css`](docs/design/jinn-design-system/project/foundations.css) — copy these into any new HTML artifact; treat the CSS variables as the canonical tokens
- [`docs/design/jinn-design-system/project/assets/`](docs/design/jinn-design-system/project/assets/) — sigils and wordmark SVGs; reuse, don't redraw
- [`docs/design/jinn-design-system/project/preview/`](docs/design/jinn-design-system/project/preview/) — reference cards for every token (colors, type, buttons, chips, cards, shadows, textures, sigils, voice)
- [`docs/design/jinn-design-system/project/ui_kits/explorer/`](docs/design/jinn-design-system/project/ui_kits/explorer/) and [`slides/`](docs/design/jinn-design-system/project/slides/) — reference implementations; match visual output, not internal structure
- [`docs/design/jinn-design-system/chats/chat1.md`](docs/design/jinn-design-system/chats/chat1.md) — design chat transcript where decisions (blue+gold palette, softened-brutalism radii, rederived semantic colors) were made

**Non-negotiables** (from `SKILL.md`, with one correction):
- Never use emoji in product, marketing, or docs.
- Never use gradients as decoration (protection gradients over imagery are the only exception).
- Never invent new vow-language (`summon / bind / vow / vessel / wish / smoke / seer / wane`) without marking it as a proposal.
- Drop the metaphor and speak plainly whenever money, safety, or legal consent is on the line.
- **Corners are softened-brutalist, not square.** `SKILL.md` still says "never rounded"; the README supersedes it — use `--radius-1` (4px chips/inputs), `--radius-2` (6px default for buttons, small cards), `--radius-3` (10px panels/large cards), `--radius-pill` for status chips only.

### Brand posture — "headless" in the Other Internet sense

Jinn's brand is **headless** in the specific sense defined by Other Internet's [*Headless Brands*](https://otherinter.net/research/headless-brands/) (read it before doing brand work). That means:

1. **No central brand authority.** No one owns Jinn's narrative. The design system is a Schelling point for coordination, not a corporate style guide. Participants — creators, vessels, seers, BD, node operators — are expected to fork, remix, and re-skin.
2. **Immutable protocol foundations.** The parts that *don't* move are the protocol-level commitments: the loop (Creation → Execution → Evaluation → Knowledge), the lexicon (*summon, bind, vow, vessel, wish, smoke, seer, wane*), the content non-negotiables (no emoji, plain speech on money/safety/legal). These are the "21M supply + proof-of-work" of the brand — fixed so narratives can layer on top.
3. **Narratives layer on top.** Palette, typography, sigils, surface treatment — all of it is narrative, and narrative is allowed (expected) to fork per surface, operator, product, or community. Multiple visual dialects of Jinn can coexist on the same protocol.
4. **Brand lives in participants' minds.** Consistency emerges from convergent narratives on shared protocol primitives, not from enforcement. A node operator's dashboard and a creator's pitch deck can look nothing alike and both still be Jinn — as long as they share the words and the loop.
5. **User-stakeholders are brand workers.** Anyone with a stake in the network (tokens, reputation, deployed vessels) has standing to propose brand direction. Contribution to the brand is a first-class form of participation, not marketing overhead.

**Operational rule, restated:** **keep the words, loosen the visuals.** The lexicon and non-negotiables are the protocol; everything else is narrative. If you're about to invent new vow-language, that's a protocol change — mark it as a proposal. If you're about to change a color or swap a sigil, that's a narrative move — just document what you changed.

The received design bundle (palette, sigils, type pairing) is one narrative — a well-reasoned starting point, not the canonical Jinn. Treat it as such.

## External Communication

Rules for any external-facing artifact about Jinn — press releases, blog posts, threads, talks, slides, public-channel announcements, anything a non-contributor will read.

Read first:
- [`PRINCIPLES.md`](PRINCIPLES.md) — every public claim must satisfy Legibility (independently verifiable, on-chain where possible) and stay coherent with Neutral, Learning Maximised, Governance Minimal, Permissionless, Prestige.
- [`BRAND.md`](BRAND.md) — voice, headless-brand posture, protocol-vs-narrative split, content non-negotiables.

Operate the workflow through the `create-press-release` skill (`.claude/skills/create-press-release/SKILL.md`) when the artifact is release-shaped; the skill composes `distil-writing` and enforces these rules.

### Framing and structure

- **Frame Jinn as "an open agentic knowledge economy."** Use this exact phrase in About-blocks, boilerplate, and headline framings of what Jinn *is*. Older phrasings ("decentralised training protocol", "agentic intent network") are superseded.
- **There is no "team", no "co-founder", no "executive".** Do not use these words in any external artifact. Jinn is headless in the Other Internet sense (see `BRAND.md`); there is no corporate structure for the brand to point at.
- **Attribution is role-only by default.** Quote attribution: `— Jinn contributor`. Named attribution only on explicit sign-off from the contributor concerned, and prefer affiliation over name unless naming is independently load-bearing.

### Verbs

- **Never use `paid` / `pays` / `payment for` / `compensation`** in protocol-action context. The contract does not pay anyone. Use, in order of preference:
  - `mints to` — when the contract is literally minting (most accurate for JinnDistributor)
  - `emits tokens to` — when describing the protocol pattern abstractly
  - `settles with` / `settles for` — for the cross-chain settlement frame
  - `distributes to` / `issues to` — for governance / treasury framings
- `Earned` (operator-side, active voice) is acceptable and matches the dashboard label `TESTNET JINN EARNED`. Avoid `earned` for the protocol's action ("the protocol earned the operator…" — wrong).

### Claim discipline (Legibility)

- **Every claim about Jinn must be independently verifiable**, on chain where possible. Cite the address, the tx hash, the indexer endpoint, the canonical-doc line. If a claim isn't on-chain-verifiable, say so explicitly and name what closes the gap.
- **Distinct vs independent.** The chain proves *distinctness* (different addresses, different transactions). It does not prove *independence* (different real-world parties). Use `distinct` in the body; only use `independent` where it's the actual news, and back-stop it with a caveats section that names the trust step.
- **Always include a "What this does not yet prove" section** for any milestone release. Name the mock components, the testnet status, the social assertions that aren't yet on-chain-provable. Naming the gap is more Legible than papering over it.

### PII

- **No dateline city.** Use the date alone: `**25 May 2026** —`. No city, no country.
- **No personal locations, schedules, family details, or other identifying material.** This applies even if the contributor is publicly identifiable elsewhere; the artifact should not add identifying surface.
- **Multisig and wallet addresses are pseudonymous, not PII.** Public on-chain addresses are slashable and discoverable; they are valid receipts. Names attached to addresses are PII; keep them separate unless consent is explicit.

### Where releases live

- `docs/press/YYYY-MM-DD-<slug>.md` — standalone press releases.
- The release file is the canonical source; X threads / Discussion posts / blog versions derive from it.
