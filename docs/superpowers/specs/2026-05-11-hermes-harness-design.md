---
title: Hermes harness integration — design
date: 2026-05-11
author: opus (drafted on jinn-mono-8psp.1)
status: draft — awaiting review
version: 0.1
---

**Sibling specs (load-bearing pre-reads):**

- `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` — SWE-rebench v2 SolverNet design; defines the `mode: 'train' | 'frozen'` Harness-interface contract, the `HarnessCheckpoint` artifact, and the layered trust stack (esp. §5.2, §6, §9). This spec adds Hermes as a third harness participating in the same SolverNet under the same freeze contract.
- `spec/2026-05-01-harness-pack-architecture.md` v0.9 — Harness / SolverPlugin / SolverNet vocabulary; protocol authority for SolverType wire shape sits in the in-tree contract registry.
- `spec/2026-05-05-solvernet-creation-and-launch.md` v0.2 — SolverNet identity model (`{contract.id, contract.version}` + `manifestCid`); operator join flow keyed by manifest CID.
- `spec/2026-04-30-phase-a-umbrella.md` — Phase A roadmap. Hermes integration ships post-v1 (sequenced after `jinn-mono-uy6v`).

**Bead lineage:**

- `jinn-mono-8psp` — Hermes harness integration epic.
- `jinn-mono-8psp.1` — this design bead.
- `jinn-mono-jnw9` — Phase A.5+ self-modifying learner epic. Confirmed orthogonal to Hermes by §6 of this spec.

---

## TL;DR

Add **NousResearch hermes-agent** (https://github.com/NousResearch/hermes-agent) as a third harness option on SWE-rebench v2, alongside Claude Code (default) and Codex. Hermes is a self-improving AI agent with its own built-in learning loop — skill creation, agent-curated memory, FTS5 session search, agentskills.io-compatible skill system, MCP integration. It does not fit the existing claude-code-learner shell because it provides phase orchestration natively; forcing the Jinn seven-phase pipeline on top would fight Hermes against its design.

The integration ships as a **sibling Harness package** at `client/src/harnesses/impls/hermes-agent/`, not as a third adapter on the existing learner shell. Hermes consumes the same **SolverPlugins** (`network-tools`, `swe-rebench-v2-runtime`) as Claude Code and Codex, but does *not* load the `claude-code-learner` orchestrator plugin — its built-in loop replaces it. The adapter translates each SolverPlugin's standard `.mcp.json` config into Hermes's `mcp_servers:` block, mounts each plugin's `skills/` dir into `skills.external_dirs`, and writes an explicit `platform_toolsets:` allowlist into a per-Task `$HERMES_HOME/config.yaml` (Hermes defaults are a strict superset of Claude Code's surface and include footgun toolsets like `messaging`, `cronjob`, `browser`, `computer_use` that we explicitly disable). Hermes runs under `HERMES_HOME = ctx.implStateDir` so the freeze contract is honored via the daemon hash-fence already prescribed by the SWE-rebench v2 design.

The naming refactor lands first: `client/src/harnesses/impls/claude-code-learner/` → `learner/`; `client/plugins/claude-code-learner/` → `client/plugins/learner/`. On-chain `Executor.implName` values (`claude-code`, `codex`, new `hermes-agent`) stay stable.

Hermes Agent ships as the SWE-rebench v2 **default** solver harness in v1 (revised 2026-05-12 — see §10; supersedes the original opt-in posture). The dashboard pre-selects it; operators may switch to Claude Code or Codex. The data-driven criteria that originally gated the default-swap are kept as a post-launch guardrail (flip the default back if Hermes underperforms on the live leaderboard), not a gate on shipping.

---

## 1. Purpose and scope

### 1.1 What this spec commits

1. A new sibling Harness package at `client/src/harnesses/impls/hermes-agent/` implementing the `Harness` SDK interface. Self-contained — does not extend `LearnerHarness` and does not load the `learner` plugin.
2. A naming refactor of the existing claude-code-learner directories (impl + plugin) to honest names, retaining on-chain `Executor.implName` stability via aliases (already present in `client/src/harnesses/names.ts`).
3. The `hermes-agent` Harness consumes the same `ctx.solverPluginRoots` as Claude Code and Codex, translating SolverPlugin manifests into Hermes's native config surface per Task.
4. Freeze-mode honored by mapping `ctx.implStateDir → $HERMES_HOME` and applying the daemon hash-fence from `agent-harness-solvernet-design` §6.3. No new freeze mechanism.
5. Operator selection UX: `/operator` join row gains `hermes-agent` as a third harness option. Runbook updated to surface the Hermes install one-liner and `hermes doctor` precheck.
6. Decision records documenting the major picks: no learner plugin for Hermes, sibling package over adapter swap, per-Task home dir for freeze contract, Hermes-as-default for SWE-rebench v2 (revised 2026-05-12).

### 1.2 In scope

- The `hermes-agent` Harness package: shell class, prompt builder, bootstrap, freeze-fence wiring, harvest.
- The SolverPlugin → Hermes config translator (`hermesConfigFromSolverPlugins`).
- Naming refactor of `claude-code-learner` impl dir and plugin dir.
- Hermes install-time UX: `hermes doctor` precheck surface in `/operator`; SolverNet join row addition.
- Test coverage: unit tests for the manifest translator and prompt builder; one e2e Task on Anvil against a stubbed Hermes binary, mirroring the Codex round-trip test.

### 1.3 Out of scope

- ~~The default-swap decision~~ — decided 2026-05-12: Hermes ships as the default (§10). Tracked as `jinn-mono-8psp.2` (closed).
- A Hermes-specific SolverPlugin (none needed — `network-tools` and `swe-rebench-v2-runtime` cover the surface).
- A Jinn-side learner port to agentskills.io format (Hermes drives orchestration; no learner skill needed on Hermes).
- Hermes-as-evaluator. v1 integration is Solver-role only. SWE-rebench v2 evaluator is deterministic Docker grading (`SweRebenchV2EvaluatorHarness`) and does not need a configurable agent harness.
- Hermes participation in `prediction.v1`. Hermes ships against SWE-rebench v2 for v1 of this epic; prediction.v1 participation is filed as future work if operator demand emerges.
- TEE-attested freeze enforcement (Phase B.1; covered by the SWE-rebench v2 design's §6.2 Layer 6).

### 1.4 Non-goals

- This spec does not redefine the Harness SDK interface. It uses the existing contract from `agent-harness-solvernet-design` §6 (`HarnessContext.mode`, freeze contract, hash-fence) unchanged.
- This spec does not change the `network-tools` or `swe-rebench-v2-runtime` SolverPlugins. Both are consumed as-is.
- This spec does not propose a Hermes-side Jinn skill pack. Hermes consumes Jinn tools via MCP only.

---

## 2. The three-plugin distinction — why Hermes skips one of them

Three distinct kinds of plugin live in the tree today. The Hermes integration only matters for one of them.

| Plugin | What it is | Loaded by |
|---|---|---|
| `client/plugins/claude-code-learner/` (will rename to `learner/`) | The Jinn-side seven-phase orchestrator. Owns the `learn` skill (Understand → Plan → Search corpus → Execute → Verify → Improve → Memory phases), the `session-start` hook. **Harness-side orchestration concern.** | Claude Code + Codex (via `LearnerHarness` shell, mounted into the spawned CLI's plugin/skill mechanism) |
| `client/plugins/network-tools/` | A SolverPlugin: manifest declaring MCP tools (`search_records`, `inspect_record`, `acquire_artifact`, `get_task`, `submit_typed_payload`) served by the daemon's `jinn-runtime` MCP server. No skills, no orchestrator. **SolverNet-side capability.** | Every harness, every SolverNet (universally required) |
| `client/plugins/swe-rebench-v2-runtime/` | A SolverPlugin: `skills/orient/SKILL.md` + `skills/plan/SKILL.md` — Solver-side guidance for SWE-rebench v2 code-issue Tasks. **SolverNet-side capability.** | Every harness participating in `swe-rebench-v2` |
| `client/plugins/jinn-prediction-plugin/` | SolverPlugin for `prediction.v1` (skills + schemas + MCP). | Every harness participating in `prediction.v1` |

The cut is clean:

- **The `learner` plugin is a *harness-side concern*** — phase orchestration that Claude Code and Codex need because they ship as generic agents with no Jinn-shaped loop. Hermes ships with its own loop (skill self-improvement, MEMORY/USER curation, FTS5 session search, Honcho user modeling). Loading the `learner` plugin on Hermes would either fight Hermes's own loop or have to disable it (which Hermes does not natively support per the documented surface). **Hermes does not load the `learner` plugin.**
- **SolverPlugins are *SolverNet-side capabilities*** — declared in the SolverNet contract's `defaultRuntimePlugins` list; the daemon resolves them and exposes them through `ctx.solverPluginRoots`. Every harness participating in a SolverNet must mount them. **Hermes loads them, same as Claude Code and Codex do.**

Concretely, for a Hermes operator running on SWE-rebench v2:

```
SolverPlugins mounted on Hermes:
  - network-tools           → daemon's jinn-runtime MCP server registered with Hermes's MCP client
  - swe-rebench-v2-runtime  → orient + plan skills added to Hermes's skills.external_dirs

NOT mounted on Hermes:
  - learner plugin (Hermes's built-in loop replaces what `learn` orchestrates)
```

This is the load-bearing architectural decision (DR-2026-05-11-c below). Everything else follows.

---

## 3. Hermes plug-in surface — config-driven, no manifest

Hermes does not have a third-party plugin manifest model like Claude Code (which discovers plugins from package roots) or Gemini CLI (which discovers `gemini-extension.json`). Hermes is **config-driven**: every plug-in surface is registered in `$HERMES_HOME/config.yaml`. Precedence is CLI args → config.yaml → `.env` → built-in defaults.

The adapter's job is to read each SolverPlugin's existing `.mcp.json` (the standard MCP config the plugin already ships for Claude Code and Codex), translate path templates, and emit the equivalent Hermes config. The three surfaces touched:

### 3.1 MCP servers — translated from `.mcp.json`

The SolverPlugin ships a standard `.mcp.json` alongside its `.claude-plugin/` and `.codex-plugin/` directories. Example, `client/plugins/network-tools/.mcp.json`:

```json
{
  "mcpServers": {
    "jinn-client": {
      "command": "node",
      "args": ["mcp/jinn-client-server.mjs"],
      "cwd": "."
    }
  }
}
```

The harness reads this and spawns `jinn-client-server.mjs` as a stdio MCP subprocess under itself. The MCP server handles its own backend calls (in our case, calls into the Jinn daemon's HTTP API for state); the harness sees only MCP protocol over stdio.

The Hermes adapter does the same translation but emits Hermes's `mcp_servers:` shape into `$HERMES_HOME/config.yaml`:

```yaml
mcp_servers:
  jinn-client:
    command: "node"
    args: ["/abs/path/to/network-tools/mcp/jinn-client-server.mjs"]
    cwd: "/abs/path/to/network-tools"
    env:
      JINN_NETWORK_TOOLS_CLIENT_ROOT: "/abs/path/to/jinn-client"
      STORE_PATH: "/path/to/jinn.db"
      DAEMON_API_URL: "http://127.0.0.1:7331"
      DAEMON_API_TOKEN: "***"
      JINN_CORPUS_SUBGRAPH_URL: "…"
      JINN_CORPUS_IPFS_GATEWAY_URL: "…"
      # … rest of corpus env
```

Translation steps:

1. Resolve template vars (`${CLAUDE_PLUGIN_ROOT}` if present) and relative paths against the SolverPlugin directory.
2. Copy any `command` / `args` / `cwd` keys through unchanged (standard MCP shape).
3. Layer in env vars the MCP server expects but the `.mcp.json` doesn't declare — `STORE_PATH`, `DAEMON_API_URL`, `DAEMON_API_TOKEN`, `JINN_CORPUS_*`. These come from the daemon's runtime, same as the codex adapter passes them today.

The `jinn.plugin.json` sidecar (and its informational `mcpServers.<name>.providedBy: jinn-client-runtime` label) is not consulted for MCP wiring. It is Jinn-side metadata for the daemon's plugin loader and SolverNet contract resolution, orthogonal to the harness↔MCP path.

### 3.2 Skills

`skills.external_dirs:` key in `$HERMES_HOME/config.yaml`. `~` and `${VAR}` expanded. Local `$HERMES_HOME/skills/` shadows external on name collision. SKILL.md format is agentskills.io-compatible, which our SolverPlugin SKILL.md files already are.

```yaml
skills:
  external_dirs:
    - "/abs/path/to/swe-rebench-v2-runtime/skills"
```

### 3.3 Toolsets — explicit allowlist (Hermes defaults are broader than Claude Code's)

A toolset in Hermes is a named bundle of built-in Hermes tools (e.g., `terminal` contains `terminal` + `process`; `file` contains `read, write, patch, search`). Hermes ships ~25 of them; configured via `hermes tools` interactively or `platform_toolsets:` in config.yaml. Toolsets are Hermes-internal — there is no third-party file-manifest registration path (Python-plugin registration exists but is out of scope for v1).

**Crucially, Hermes default-ON toolsets are a strict superset of Claude Code's surface** (verified from `hermes_cli/tools_config.py` against `CONFIGURABLE_TOOLSETS` minus `_DEFAULT_OFF_TOOLSETS`):

- Default ON: `web, browser, terminal, file, code_execution, vision, image_gen, tts, skills, todo, memory, session_search, clarify, delegation, cronjob, messaging, yuanbao, computer_use`
- Default OFF: `moa, homeassistant, rl, spotify, discord, discord_admin, video`

Several default-ON toolsets are footguns for unattended Solver Tasks — `messaging` would let the agent send messages, `cronjob` would let it schedule things, `computer_use` and `browser` are out of scope, `tts`/`vision`/`image_gen` are irrelevant for text-only code issues.

The adapter writes an **explicit toolset allowlist** for SWE-rebench v2 Solver Tasks under `platform_toolsets.hermes-cli:` in the per-Task config.yaml:

```yaml
platform_toolsets:
  hermes-cli:
    - terminal        # shell exec — apply patches, run pytest
    - file            # read/write/patch source files (Claude Code's Read/Write/Edit/MultiEdit/Grep/Glob equivalent)
    - web             # doc lookup, error-message search
    - skills          # SolverPlugin orient/plan skills + Hermes's own skill management
    - memory          # Hermes's continuous learning (train mode); rolled back in frozen mode by hash-fence
    - session_search  # Hermes's cross-session search; train/frozen treatment identical
    - todo            # planning aid
    - code_execution  # parallel to terminal; redundant in some configs, harmless to enable
```

Everything else is disabled by omission. Rationale per excluded category:

- `browser, computer_use, homeassistant, spotify, discord*, messaging, cronjob, yuanbao` — irrelevant to code-issue tasks; several are active footguns under unattended automation.
- `vision, image_gen, tts, video` — irrelevant for text-only code issues; cost without benefit.
- `clarify` — the agent has no human to clarify with during automated Solver runs; dead surface.
- `delegation` — token-cost implications of unbounded subagent spawning aren't understood for SWE-rebench v2 economics. Deferred to v1.x.
- `moa, rl` — research-oriented; not productive for Solver Tasks.

Operators can override the allowlist via per-SolverNet config (mirrors the existing `harness` selection pattern) — useful escape hatch for an operator who wants `browser` enabled for a task class where it genuinely helps. Override mechanism is filed as plan-time work.

---

## 4. Adapter design — `HermesHarnessAdapter`

### 4.1 Package layout

```
client/src/harnesses/impls/hermes-agent/
  index.ts                  → exports HermesHarness
  harness.ts                → class HermesHarness implements Harness
  adapter.ts                → spawns hermes chat -q, manages lifecycle
  config-builder.ts         → translates SolverPlugin manifests → Hermes config
  prompt.ts                 → buildInitialPrompt(inputs) — Jinn-task prompt template
  bootstrap.ts              → per-Task: HERMES_HOME setup, config write, env scrub
  freeze.ts                 → integrates daemon hash-fence on HERMES_HOME
  harvest.ts                → reads solution from workingDir (delegates to shared harvest)
  test-utils.ts             → stub spawn helpers for unit tests
```

Mirrors the `learner/` layout structurally without inheriting from it. The `Harness` interface is the only shared contract.

### 4.2 Per-Task flow

`HermesHarness.run(ctx)` executes:

1. Bootstrap.
   - Resolve `HERMES_HOME = ctx.implStateDir`. Ensure the directory exists; if empty, write Hermes-default `config.yaml` skeleton.
   - Build the per-Task Hermes config layered onto the persisted config (model, MCP servers from SolverPlugins, external skill dirs, terminal backend `local` with `cwd: ctx.workingDir`). Write to `$HERMES_HOME/config.yaml`.
   - Write Jinn-runtime credentials to `$HERMES_HOME/.env` (DAEMON_API_TOKEN, JINN_CORPUS_*).
2. Freeze setup.
   - If `ctx.mode === 'frozen'`: snapshot `HERMES_HOME` to a sibling temp dir; record pre-Task hash via `hashImplStateDir` from §6.3 of the SWE-rebench v2 design.
3. Spawn.
   - `hermes chat -q "<prompt>" --model <inputs.model> --provider <inputs.provider> -w <workingDir>`.
   - Toolset allowlist is in the config.yaml written in step 1; no `--toolsets` flag at the CLI (CLI flag would override saved config; we want config to be the source of truth so it's visible/auditable in the per-Task HERMES_HOME).
   - Pass `HERMES_HOME` env var (confirmed canonical — see §4.4).
   - Pipe stdout/stderr to `<workingDir>/.hermes-agent/{stdout,stderr}.log`.
4. Wait for exit. Forward `inputs.abort` to SIGTERM. Treat aborted-but-graceful as success (mirrors Codex adapter).
5. Freeze enforcement.
   - If `ctx.mode === 'frozen'`: re-hash `HERMES_HOME`; mismatch → rollback from snapshot, return violation result (envelope rejected upstream).
6. Harvest.
   - Read solution from `<workingDir>/.execute/solution-payload.json` (the canonical typed-payload path, same as Claude Code and Codex).

### 4.3 SolverPlugin → Hermes config translation

The pure function `hermesConfigFromSolverPlugins(roots, env)` walks `ctx.solverPluginRoots`, reads each plugin's standard `.mcp.json` and `skills/` directory, and emits the matching Hermes config sections:

```ts
interface HermesConfigSnippet {
  mcp_servers?: Record<string, McpServerConfig>;
  skills?: { external_dirs?: string[] };
}

function hermesConfigFromSolverPlugins(
  roots: readonly string[],
  env: {
    storePath?: string;
    daemonApiUrl: string;
    daemonApiToken: string;
    corpusEnv: { subgraphUrl?: string; ipfsGatewayUrl?: string; rpcUrl?: string; chainId?: number; identityRegistryAddress?: string; fromBlock?: number };
  },
): HermesConfigSnippet { /* ... */ }
```

Translation rules:

- For each plugin root, look for `.mcp.json`. If present:
  - For each entry in `mcpServers`: emit `mcp_servers.<name>` with `command`, `args`, `cwd` resolved to absolute paths (relative `args` and `cwd` are anchored at the plugin root).
  - Resolve any `${CLAUDE_PLUGIN_ROOT}` template var to the plugin root.
  - Layer in env vars the MCP server expects from runtime context: `STORE_PATH`, `DAEMON_API_URL`, `DAEMON_API_TOKEN`, `JINN_CORPUS_*` (mirrors the env block the codex adapter passes today).
- For each plugin root, if `skills/` exists, append its absolute path to `skills.external_dirs`.
- `jinn.plugin.json` is **not consulted** for MCP wiring or skill mounting. It is daemon-side metadata (capability documentation, SolverType support list) and stays out of the harness↔Hermes config path.

Unit tests cover both SolverPlugin manifests we ship (`network-tools`, `swe-rebench-v2-runtime`) plus one fixture for a hypothetical Path 2 SolverPlugin that ships an HTTP MCP server (verifies `url`/`headers` keys pass through unchanged).

### 4.4 Home-dir env var — resolved

`HERMES_HOME` is the canonical env var, confirmed against `scripts/install.sh:48`:

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
```

Used throughout the Hermes install script and source — `sessions/`, `logs/`, `memories/`, `skills/`, `.env`, `config.yaml` all live under `$HERMES_HOME`. The adapter sets it on the spawned subprocess env per Task. No fallback shenanigans needed.

Hermes also ships a first-class `profile` mechanism (`hermes profile create <name>` + `hermes -p <name> chat`) that wraps HERMES_HOME redirection for multi-instance isolation. The adapter could use profiles instead of direct HERMES_HOME redirection, but direct redirection is simpler and matches how we anchor per-operator implStateDir state today. Profiles are a fallback if integration testing surfaces friction with raw HERMES_HOME isolation (e.g., concurrency hazards inside Hermes's session DB layer).

### 4.5 Prompt template

`buildInitialPrompt(inputs)` produces the Jinn-task prompt analogous to the Codex adapter's `buildInitialPrompt`. Sections:

1. Frame: "You are executing a Jinn task. Complete it using the available tools and skills."
2. Delivery instruction: "Call `submit_typed_payload` to deliver. Do not write `<workingDir>/.execute/solution-payload.json` directly unless `submit_typed_payload` is unavailable; if fallback is required, the file must match the exact SolverNet schema."
3. SolverNet-specific guidance (reuses `sweRebenchV2Guidance(inputs)` from the codex adapter — repo clone instruction, donated-data search, patch format).
4. Session inputs block: `goal.id`, `goal.cid`, `workingDir`, `implStateDir` (= HERMES_HOME for transparency), deadline, `msUntilDeadline`, `mode`.
5. Full task body JSON.

The prompt mirrors what Claude Code and Codex receive; the only difference is that Jinn-side tools are reached via `mcp_jinn_runtime_*` prefixed names (per Hermes's MCP naming convention).

---

## 5. Freeze contract for Hermes

### 5.1 Mapping

`ctx.implStateDir → $HERMES_HOME`. Hermes's entire learning surface — MEMORY.md, USER.md, `skills/`, FTS5 session DB, Honcho user model, generated `config.yaml`, `.env` — lives under HERMES_HOME. Snapshotting that dir captures everything Hermes might mutate during a Task.

### 5.2 Modes

- **Train mode (default).** `HERMES_HOME` persists across Tasks for the operator (anchored to `~/.jinn-client/engine/impl-state/hermes-agent/<operator-key>/`). Hermes's loop compounds: skills self-improve, MEMORY.md accumulates, sessions are searchable across Tasks. This is the substrate-flow contributor mode and is exactly what makes Hermes worth integrating — its own continuous learning is preserved.
- **Frozen mode.** Before each Task: snapshot HERMES_HOME, record pre-Task hash. After each Task: re-hash. Mismatch → rollback from snapshot, reject envelope, emit reputation event. Hermes does not need to know it's frozen; we enforce externally.

### 5.3 Why this works

Hermes documents no per-session flag for disabling persistence. The freeze contract is enforced at the filesystem boundary, not inside Hermes. Hermes runs normally; the daemon discards any state Hermes writes during a frozen Task. The trust stack from `agent-harness-solvernet-design` §6.2 applies as-is:

- Layer 1 (daemon hash-fence): identical mechanism; HERMES_HOME is the hashed dir instead of a learner-managed implStateDir.
- Layer 2 (subgraph cross-envelope consistency): operator's claimed `mode=frozen` `codeDigest` (= HERMES_HOME Merkle hash) must be stable across the frozen window.
- Layer 3 (cross-operator forking validation): when a Hermes operator publishes a HarnessCheckpoint and another operator forks it, both should produce the same codeDigest under freeze.
- Layer 4 (source-bundle publication): the Hermes binary version + HERMES_HOME contents are the source bundle. A published checkpoint includes both.
- Layer 5 (reputation slashing): same.
- Layer 6 (TEE-attested): same (out of v1 scope).

No new freeze mechanism is needed for Hermes. The existing one applies unchanged.

### 5.4 HarnessCheckpoint shape for Hermes

A Hermes checkpoint is structurally identical to a Claude Code / Codex checkpoint per the manifest in `agent-harness-solvernet-design` §7.1. The differences are scoped to the `harnessPackage` and `implStateDirCid` fields:

- `harnessPackage.implName = 'hermes-agent'` (or a derivative like `'hermes-agent@team-xyz'`).
- `harnessPackage.clientGitSha` references the Jinn-client commit that ships the adapter; `harnessPackage.sourceBundleCid` is a tarball that records `hermes --version`, the exact git SHA of `$HERMES_HOME/hermes-agent/` (Hermes is git-installed), and the adapter's git commit.
- `harnessPackage.hermesGitSha` (added field) — the Hermes commit SHA the publishing operator was running. **Required**, because `hermes update` pulls `origin/main` without version-target support; we cannot rely on a release-tag handle for reproducibility.
- `implStateDirCid` is the IPFS-pinned snapshot of HERMES_HOME at freeze time.

A forking operator's restore flow:

1. `jinn checkpoint install <cid>` — fetches the source bundle and implStateDir snapshot.
2. `cd $HERMES_HOME/hermes-agent && git fetch && git checkout <hermesGitSha>` — pins the Hermes binary to the publisher's commit. (The `hermes update` CLI does not expose a `--version` flag; direct git checkout is the workaround.)
3. Restore HERMES_HOME from the snapshot.
4. Run frozen against the canonical slate.

This is heavier than the Claude Code / Codex path (where binary versions are versioned packages), but workable. The verified-frozen tier of the leaderboard publishes both the `clientGitSha` and the `hermesGitSha` for cross-operator forking validation.

Future-proofing: if Hermes upstream adds `hermes update --version <tag>` (filed as an upstream request in the implementation plan's external-deps section), the manifest field changes to `hermesReleaseTag` and the restore flow simplifies.

---

## 6. Composition with Hermes's built-in learning loop

### 6.1 The composition question, resolved

Hermes ships with: autonomous skill creation after complex tasks, agent-curated memory (MEMORY.md) with periodic nudges, skill self-improvement during use, FTS5 session search with LLM summarization, Honcho dialectic user modeling. The Jinn-side claude-code-learner plugin ships with: a seven-phase pipeline (Understand → Plan → Search corpus → Execute → Verify → Improve → Memory) that drives Claude Code and Codex through the same loop shape.

Two learning loops in the same Task is structurally adversarial. Either:

- (a) The Jinn pipeline drives and Hermes's loop is disabled — but Hermes does not natively support disabling its loop, and forcing it to behave as a stateless agent throws away the value proposition of integrating Hermes in the first place.
- (b) Hermes's loop drives and the Jinn pipeline is not loaded — but then we have no Jinn-side learning artifact, no per-operator implStateDir mutation visible to the seven-phase corpus consumer (`Search corpus` step) on Claude Code / Codex.

(b) is the right answer once you realize: **the corpus is read-side, not write-side.** Hermes-produced trajectories enter the corpus the same way Claude Code and Codex trajectories do — via the standard envelope pipeline (Solution + Verdict + trajectory_cid pinned to IPFS, advertised through donation envelopes). Claude Code and Codex operators reading the corpus on future Tasks see Hermes-produced trajectories alongside theirs. The substrate's producer-consumer overlap fires across all three harnesses uniformly.

What Hermes does *not* contribute is a Jinn-format learner-side implStateDir that another Jinn-format learner could fork. That's fine — Hermes operators contribute trajectories and frozen HarnessCheckpoints. The HarnessCheckpoint forking story works (§5.4 above). The "fork another operator's learner-side implStateDir" story is Claude Code / Codex-specific and not load-bearing for the substrate.

### 6.2 Relationship to `jinn-mono-jnw9` (Phase A.5+ self-modifying learner)

`jnw9` is the epic for the Claude Code learner's self-modification mechanism — "modifies its own code from solver-net activity," supervised-diff via PRs in Phase A.5+. That work is **orthogonal to Hermes integration**: Hermes is its own self-modifying learner via its built-in skill self-improvement; the Jinn-level learner-self-modification work applies to Claude Code / Codex via the `learner` plugin's Improve phase.

In substrate terms:

- The `learner` plugin's Improve phase mutates Claude Code's / Codex's `implStateDir` (Jinn-side seven-phase learner state).
- Hermes's built-in loop mutates `HERMES_HOME` (Hermes-side skill + memory state).
- Both contribute trajectories to the corpus. Both produce freezable HarnessCheckpoints. Both compete on the frozen-mode leaderboard.

No work in this Hermes epic affects `jnw9`, and no work in `jnw9` affects Hermes.

---

## 7. Naming refactor — learner package + sibling hermes-agent package

### 7.1 Current state (misleading)

Both Claude Code and Codex use the same shell (`ClaudeCodeLearnerImpl`) and the same plugin (`client/plugins/claude-code-learner/`). The shell class and the plugin are both named after Claude Code despite serving Codex equally. The Hermes integration would compound the misdirection if it followed the same pattern.

### 7.2 Refactor

```
Before                                                After
─────────────────────────────────────────────────────────────────────────────
client/src/harnesses/impls/                           client/src/harnesses/impls/
  claude-code-learner/                                  learner/
    harness.ts (ClaudeCodeLearnerImpl)                   harness.ts (LearnerHarness)
    adapters/claude-code.ts                              adapters/claude-code.ts
    adapters/codex-code.ts                               adapters/codex-code.ts
    harvest.ts, types.ts, plugin-path.ts                 harvest.ts, types.ts, plugin-path.ts
                                                       hermes-agent/                   ← NEW
                                                         harness.ts (HermesHarness)
                                                         adapter.ts
                                                         config-builder.ts
                                                         prompt.ts, bootstrap.ts
                                                         freeze.ts, harvest.ts

client/plugins/                                       client/plugins/
  claude-code-learner/                                  learner/
    skills/learn/SKILL.md, hooks/session-start           skills/learn/SKILL.md, hooks/session-start
  network-tools/                                        network-tools/             (unchanged)
  swe-rebench-v2-runtime/                               swe-rebench-v2-runtime/    (unchanged)
  jinn-prediction-plugin/                               jinn-prediction-plugin/    (unchanged)
```

### 7.3 On-chain identity stability

Canonical `Executor.implName` values stay the same. `client/src/harnesses/names.ts` already supports aliases for older names (`claude-code-learner` → `claude-code`, `codex-code-learner` → `codex`). The refactor:

- Keeps `CLAUDE_CODE_HARNESS = 'claude-code'` and `CODEX_HARNESS = 'codex'` as before.
- Adds `HERMES_AGENT_HARNESS = 'hermes-agent'`.
- Updates `harnessStateDirName()` to map canonical names → state dir names (`claude-code → 'learner'`, `codex → 'learner'`, `hermes-agent → 'hermes-agent'`). Existing operators' on-disk state dirs stay readable because the alias path is preserved.

No on-chain migration required. No operator-side state migration required (the old `claude-code-learner/` and `codex-code-learner/` state dirs continue to work via the existing alias logic).

### 7.4 Scope of the rename

Mechanical: directory move, import-path fixups across the codebase (~20–30 files), test path updates. Public APIs and on-chain identifiers unchanged. The rename lands as a precondition PR to the Hermes adapter work — separate PR, clean diff, easy review.

---

## 8. Operator selection UX

### 8.1 `/operator` join row

The SolverNet join row on the operator dashboard's `/operator` page gains a third harness option:

```
SWE-rebench v2 — solver harness:
  [•] Claude Code        (default)
  [ ] Codex
  [ ] Hermes Agent       (NEW)
```

Operator selection determines the `harness` field in the saved `joinedSolverNets[<manifestCid>]` config entry. Restart-required, same as Codex selection today.

### 8.2 Install precheck

Hermes is not bundled with `@jinn-network/client`. Operators install it separately via the one-liner from the Hermes README:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

The `/operator` join flow gates the Hermes selection on a precheck: if `which hermes` fails or `hermes doctor` returns non-zero, the join save surfaces an install-required state with the one-liner copy-paste and a "I have installed Hermes" retry button. This mirrors how the dashboard already gates Docker on the evaluator role (per the SWE-rebench v2 runbook).

### 8.3 Model and provider configuration

After install, Hermes requires a provider choice (Nous Portal, OpenRouter, NVIDIA NIM, OpenAI, etc.) and a model selection. The operator runs `hermes model` once interactively (or `hermes setup` for the full wizard); this configures `~/.hermes/config.yaml`. The Jinn adapter inherits that operator-level model selection unless the SolverNet config explicitly overrides via `--model` / `--provider` flags on spawn.

### 8.4 Runbook addition

`docs/runbooks/swe-rebench-v2-public-testnet.md` adds a section after the existing Claude Code / Codex selection paragraph:

```
Operators may also select Hermes Agent (`hermes-agent`) as the solver harness.
Hermes is a self-improving agent with its own learning loop, supporting 200+
models via OpenRouter and additional providers including Nous Portal, NVIDIA
NIM, and others. Install via the Hermes one-liner; the daemon's join flow
prechecks `hermes doctor` before allowing the join to save.
```

---

## 9. Model-routing boundary

### 9.1 Precedence

Same as Codex's existing path. Per-Task model resolution order, highest priority first:

1. `inputs.model` — per-SolverNet override in `joinedSolverNets[<manifestCid>].model`.
2. `env.hermesModel` / `env.hermesProvider` — daemon-level default from `~/.jinn-client/config.json`.
3. `~/.hermes/config.yaml` operator-level default (Hermes's own resolution).

The adapter passes `--model <X> --provider <Y>` on every `hermes chat -q` spawn when (1) or (2) is set; otherwise Hermes falls back to (3).

### 9.2 What we do not delegate

We do **not** invoke `hermes model` (the interactive picker) from the adapter. The model decision is made before spawn, written to the spawn args. This preserves Hermes's "use any model you want" property without making it interactive-only.

### 9.3 Config additions

`client/src/config.ts` adds:

| Config key | Env override | Default |
|---|---|---|
| `hermesPath` | `JINN_HERMES_PATH` | `hermes` (PATH-resolved) |
| `hermesModel` | `JINN_HERMES_MODEL` | (unset; Hermes operator-level default applies) |
| `hermesProvider` | `JINN_HERMES_PROVIDER` | (unset) |
| `hermesDoctorTimeoutMs` | `JINN_HERMES_DOCTOR_TIMEOUT_MS` | `30000` |

Mirrors `codexPath` / `codexModel` from the existing schema.

---

## 10. Default harness

### 10.1 Decision (revised 2026-05-12 — supersedes the original "opt-in" posture)

**Hermes Agent ships as the SWE-rebench v2 default solver harness in v1.** The dashboard pre-selects it (`compatibleHarnesses[0]` for the `swe-rebench-v2` catalog entry); the runbook documents it as the default; operators may switch to Claude Code or Codex. The dashboard pins `anthropic/claude-opus-4.6` (OpenRouter-routed) as the default Hermes model; operators can pick another or leave the join's `model` field unset to inherit their `hermes model` configuration.

This reverses the original draft posture (below, retained for context), which held the default-swap until ≥3 operators reported comparable-or-better frozen-mode HarnessCheckpoint scores. Captain decision (jinn-mono-8psp.2): commit to Hermes as the default now and prove it through the v1 acceptance run, rather than ship it opt-in and wait for field data that a not-yet-default harness is unlikely to accumulate. Trade-off accepted: every operator joining as a solver needs Hermes installed (an external `curl | bash` dependency); the `/operator` precheck (`hermes doctor`) makes the install gate explicit and recoverable.

`DR-2026-05-11-g` is superseded by `DR-2026-05-12-a` (this section).

### 10.2 Original draft posture (superseded — retained for context)

The original design held Hermes as **opt-in through v1.x** with Claude Code staying the default, on the reasoning that switching the recommended harness on a live SolverNet has operator-trust and recruitment-narrative costs. The data-driven swap criteria were:

> Default-swap from Claude Code to Hermes Agent is approved when **all** of: (1) ≥ 3 operators have published verified HarnessCheckpoints with `harnessPackage.implName = 'hermes-agent'`; (2) mean `swe-rebench-v2-network-result.meanResolved` across them, over the most recent 30-day window, ≥ the `claude-code` mean over the same window; (3) per-language `byLanguage` shows no language regressing by > 5 percentage points; (4) no outstanding P0/P1 bd issues against the Hermes adapter or `network-tools` MCP wiring.

These criteria remain a useful health check post-launch — if Hermes-as-default turns out to underperform Claude Code on the live leaderboard, the runbook can flip the default back. The criteria are no longer a *gate* on shipping Hermes as the default; they're a *guardrail* for keeping it there.

---

## 11. Implementation surface and engineering scope

### 11.1 Component breakdown

| Component | Files / scope | Lift |
|---|---|---|
| **Naming refactor (precondition PR)** | Move `claude-code-learner/` → `learner/` (impl dir + plugin dir); update ~20–30 imports + tests; verify alias paths in `names.ts` | ~1 day |
| **HermesHarness shell + Harness interface** | `harness.ts`, `index.ts` | ~1 day |
| **HermesHarnessAdapter** | `adapter.ts` — spawn, lifecycle, abort, logging | ~2 days |
| **SolverPlugin manifest translator** | `config-builder.ts` — `hermesConfigFromSolverPlugins()` + unit tests | ~1–2 days |
| **Per-Task bootstrap** | `bootstrap.ts` — HERMES_HOME setup, config write, env scrub | ~1 day |
| **Freeze-fence integration** | `freeze.ts` — wraps the shared hash-fence around HERMES_HOME | ~half-day |
| **Prompt builder** | `prompt.ts` — reuse the SWE-rebench v2 guidance from codex adapter | ~half-day |
| **Harvest** | `harvest.ts` — delegate to shared harvest (no Hermes-specific format) | ~half-day |
| **Home-dir env-var resolution** | Implementation-plan question; test against Hermes binary | ~1 day (research + verify) |
| **Operator dashboard UX** | `/operator` join row third option; `hermes doctor` precheck | ~1–2 days |
| **Runbook update** | `docs/runbooks/swe-rebench-v2-public-testnet.md` adds Hermes section | ~half-day |
| **Config schema** | `client/src/config.ts` adds `hermesPath` / `hermesModel` / `hermesProvider` | ~half-day |
| **Tests** | Unit (manifest translator, prompt builder); integration (adapter against stubbed Hermes bin); one e2e on Anvil mirroring codex round-trip | ~2–3 days |
| **Total** | | **~12–15 days, ~2.5–3 weeks** |

### 11.2 v1 acceptance criteria

The Hermes harness ships when:

1. The naming refactor PR has landed cleanly; on-chain `Executor.implName` values are unchanged; existing Claude Code and Codex operators continue to work without state migration.
2. `client/src/harnesses/impls/hermes-agent/` exists with the full adapter; `HermesHarness` is registered in `buildHarnesses()`.
3. `hermesConfigFromSolverPlugins()` unit tests pass against fixture manifests for `network-tools` and `swe-rebench-v2-runtime`.
4. An e2e test on Anvil completes a SWE-rebench v2 Task end-to-end against a real Hermes binary (or a stubbed equivalent in CI) with a verified Solution envelope.
5. Freeze-mode e2e test confirms a deliberate-violation Task fixture (Hermes writes to a known sentinel under HERMES_HOME) triggers hash-fence rejection and rollback.
6. The `/operator` dashboard surfaces Hermes Agent as a third radio option on the SWE-rebench v2 join row; `hermes doctor` precheck gates the save.
7. The runbook documents Hermes selection, install, model/provider configuration.
8. `bd remember`-grade docs cover the home-dir env-var resolution that landed in the implementation.

### 11.3 v1.x to v2 future work

- Hermes as evaluator on judge-graded SolverNets (out of scope for SWE-rebench v2 since its evaluator is deterministic Docker grading).
- Hermes-agent on `prediction.v1` (filed if operator demand emerges).
- Cross-checkpoint comparison metrics specific to Hermes — Hermes's built-in skill self-improvement may produce a distinct improvement-curve shape from claude-code-learner's seven-phase Improve. Worth surfacing on the dashboard once data exists.
- ~~The default-swap decision~~ — decided 2026-05-12 (§10); Hermes is the default. Post-launch guardrail per §10.2.

---

## 12. Open implementation details

All design-blocking research items resolved (see commit history of this spec). Remaining plan-time items, none gating:

1. **`hermes doctor` exit-code semantics.** Source at `hermes_cli/doctor.py`; user docs are vague on per-check exit codes. Plan-time: read the source and confirm whether "no provider configured" returns non-zero. Fallback for the dashboard precheck is to run a tighter custom check (`which hermes` plus a config-presence check on `$HERMES_HOME/config.yaml`'s `model:` block).
2. **Concurrent Hermes processes on isolated HERMES_HOMEs.** No global lockfile / fcntl flock matches in the Hermes source, suggesting per-HERMES_HOME isolation should be safe. Plan-time: run a multi-Hermes-process integration test on the e2e fixture to confirm. Fallback is `hermes profile` per-Task instead of direct HERMES_HOME redirection.
3. **Upstream feature request: `hermes update --version <tag>`.** Hermes ships weekly named releases but `hermes update` only pulls `origin/main`. v1 ships with the git-checkout-by-SHA workaround (§5.4). File an upstream issue / PR to add `--version` flag; switch the HarnessCheckpoint manifest to `hermesReleaseTag` when it lands.
4. **Operator override of the toolset allowlist.** §3.3 commits to an explicit toolset list with operator-override capability. The override surface (per-SolverNet config? per-operator env? both?) is plan-time.

---

## 13. Decision records

The following DRs are filed alongside this spec at `log/decisions/2026-05-11-…`:

- **DR-2026-05-11-c — No `learner` plugin for Hermes.** Hermes provides phase orchestration natively (skill self-improvement, MEMORY/USER curation, FTS5 session search, Honcho user modeling). Loading the Jinn-side seven-phase `learner` plugin would either fight Hermes's own loop or have to disable it (which Hermes does not support per the documented surface). Hermes consumes SolverPlugins (`network-tools`, `swe-rebench-v2-runtime`) like every other harness, but skips the `learner` plugin. The cut is harness-side concern (orchestration) vs SolverNet-side concern (capability).
- **DR-2026-05-11-d — Sibling Harness package, not adapter swap.** Hermes is structurally different from Claude Code and Codex (config-driven plug-in model, native learning loop, native MCP client). A third adapter on `LearnerHarness` would have to bypass the plugin-mount step and the `learn` skill orchestration, leaving the shell doing little but spawning a subprocess. Cleaner to make `hermes-agent` a sibling Harness package, sharing only the `Harness` interface contract.
- **DR-2026-05-11-e — Freeze contract via HERMES_HOME = implStateDir.** Hermes does not support per-session disabling of memory writes or skill creation. Mapping `ctx.implStateDir → $HERMES_HOME` and applying the existing daemon hash-fence (`agent-harness-solvernet-design` §6.3) enforces the freeze contract at the filesystem boundary without modifying Hermes. The full six-layer trust stack applies as-is.
- **DR-2026-05-11-f — Naming refactor preconditional to Hermes work.** Renaming `claude-code-learner/` to `learner/` (impl dir + plugin dir) is a precondition PR. Lands separately from the Hermes work; mechanical diff; no on-chain identity change (alias paths in `names.ts` already handle the canonical mapping).
- **DR-2026-05-11-g — Default-swap held until data-driven.** ~~Superseded by DR-2026-05-12-a.~~ Original: Hermes ships opt-in for v1.x; default-swap requires ≥3 operators publishing verified Hermes HarnessCheckpoints with mean `meanResolved` ≥ Claude Code's, no language regressing > 5pp, no outstanding P0/P1.
- **DR-2026-05-12-a — Hermes Agent is the SWE-rebench v2 default solver harness in v1.** Supersedes DR-2026-05-11-g. Captain decision (jinn-mono-8psp.2): commit to Hermes as the default and prove it through the v1 acceptance run rather than ship it opt-in and wait for field data a non-default harness won't accumulate. Implemented via `compatibleHarnesses[0] = hermes-agent` in the `swe-rebench-v2` catalog (dashboard pre-selects it), runbook prose, and `HERMES_MODELS` (dashboard default model `anthropic/claude-opus-4.6`, OpenRouter-routed). Trade-off: every solver operator needs Hermes installed; the `/operator` `hermes doctor` precheck makes the install gate explicit. The §10.2 criteria are retained as a post-launch guardrail (flip the default back if Hermes underperforms on the live leaderboard), not a ship gate.
- **DR-2026-05-11-h — Hermes self-modification orthogonal to `jnw9`.** Hermes's built-in skill self-improvement is its own self-modifying-learner mechanism. The Phase A.5+ Jinn-side self-modifying learner (`jinn-mono-jnw9`) applies to Claude Code / Codex via the `learner` plugin's Improve phase and does not need to special-case Hermes. The two epics are orthogonal.
- **DR-2026-05-11-i — Explicit toolset allowlist; Hermes defaults are not trusted.** Verified from `hermes_cli/tools_config.py` that Hermes's default-ON toolsets are a strict superset of Claude Code's built-in surface and include footguns under unattended automation (`messaging` can send messages; `cronjob` can schedule things; `browser`, `computer_use`, `tts`, `vision`, `image_gen` are at best irrelevant to text-only code issues). The adapter writes an explicit `platform_toolsets.hermes-cli:` allowlist (`terminal, file, web, skills, memory, session_search, todo, code_execution`) into per-Task config; everything else is disabled by omission. Operators can override per-SolverNet. Rejects "trust Hermes defaults" (broader surface than Claude Code, with explicit footguns) and "match Claude Code exactly" (loses `memory` / `session_search` which are load-bearing for Hermes's continuous-learning value proposition).

---

## 14. References

- NousResearch hermes-agent: https://github.com/NousResearch/hermes-agent — MIT, self-improving agent built by Nous Research; CLI + gateway + ACP; agentskills.io-compatible skill system; MCP integration via `mcp_servers:` in `~/.hermes/config.yaml`; weekly named release cadence.
- Hermes docs: https://hermes-agent.nousresearch.com/docs/ — CLI usage, configuration, skills, memory, MCP integration, architecture.
- agentskills.io — open standard for agent skills; SKILL.md format with YAML frontmatter; the SolverPlugin skills (`swe-rebench-v2-runtime/skills/orient`, `/plan`) already conform.
- `docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md` — SWE-rebench v2 SolverNet design; `mode` contract, freeze hash-fence (§6), HarnessCheckpoint manifest (§7), trust stack (§6.2).
- `client/src/harnesses/names.ts` — canonical-name and alias logic; preserved as-is for the refactor.
- `client/plugins/network-tools/jinn.plugin.json` — SolverPlugin manifest format reference (MCP-tools surface).
- `client/plugins/swe-rebench-v2-runtime/jinn.plugin.json` — SolverPlugin manifest format reference (skills surface).
- `client/src/harnesses/impls/claude-code-learner/adapters/codex-code.ts` — adapter pattern reference; HermesHarnessAdapter mirrors its lifecycle, abort handling, and log piping.
- `bd jinn-mono-8psp` (epic), `jinn-mono-8psp.1` (this design bead), `jinn-mono-jnw9` (orthogonal self-modifying learner epic).
