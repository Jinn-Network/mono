# Client Architecture

**What this doc is / is not.** This is the integrating narrative for `@jinn-network/client`: how the operator app, the CLI, and the daemon fit together, what each layer does, and where to look in the code. It is the entry point a new engineer or a curious operator should read before diving in. It is **not** a protocol spec (that's [`SPEC.md`](../SPEC.md)), a CLI contract (that's [`spec/2026-04-14-client-surface.md`](../spec/2026-04-14-client-surface.md)), an operator runbook (that's [`docs/operator-testnet.md`](../docs/operator-testnet.md)), or an extension architecture (that's [`spec/2026-05-01-harness-pack-architecture.md`](../spec/2026-05-01-harness-pack-architecture.md)). Each section here links into the canonical source for its slice; it does not restate them.

---

## 1. What the client is for

The client is a single Node process — `jinn run` — that turns a host machine into an **operator** in the Jinn protocol: it creates Tasks, claims and solves them through Harnesses, packages and delivers Solutions, evaluates other operators' work, and earns rewards for measured contribution. The protocol loop (Creation → Execution → Evaluation → Knowledge) lives in [`SPEC.md`](../SPEC.md); the client is one implementation of an operator that participates in it.

Two audiences run this code:

- **Operators** — humans (often paired with an AI agent) who want their machine earning. They live in the operator app and rarely read the source.
- **Engineers** — protocol developers, harness builders, integrators who extend or debug the daemon. They live in the source and use the app to verify behaviour.

The product surfaces are designed for the operator first; the architecture below is what the engineer reads when the app's "how does this work?" question becomes "show me the loop".

## 2. Two surfaces, one process

There are two ways to drive the client, and they share the same daemon process:

```
                ┌──────────────────────────────────────────────┐
                │                                              │
   browser  ───►│  Operator app (SPA)        http://127.0.0.1:7331/
                │  src/dashboard/spa/        served by the daemon
                │                                              │
   shell    ───►│  CLI:  jinn <verb>         src/cli/          │
                │                                              │
   AI host  ───►│  Operator MCP: jinn mcp    src/mcp/operator-server.ts
                │                                              │
                └──────────────┬───────────────────────────────┘
                               │
                               ▼
                ┌──────────────────────────────────────────────┐
                │  Daemon process (single Node binary)         │
                │  HTTP API · setup-mode controller · loops    │
                │  src/main.ts → src/daemon/daemon.ts          │
                └──────────────────────────────────────────────┘
```

The **operator app** is the canonical front door: a localhost SPA that opens automatically when `jinn run` boots, narrates bootstrap, surfaces live state, and docks an embedded Claude Code session for the long tail of operator actions. Its design is canonical at [`docs/superpowers/specs/2026-05-01-operator-local-app-design.md`](../docs/superpowers/specs/2026-05-01-operator-local-app-design.md).

The **CLI** is the substrate the app drives. Everything the panel does is reachable as a `jinn <verb>` invocation; `jinn run` is the only verb that *starts* the daemon and the panel. The stable verb set + JSON contract is canonical at [`spec/2026-04-14-client-surface.md`](../spec/2026-04-14-client-surface.md).

The **operator MCP** is the agent-facing surface: an MCP server (`jinn mcp`) that wraps a subset of CLI verbs as tools so AI hosts (Claude Code, Codex, Cursor, Gemini CLI, …) can drive the operator without shelling out. It is wired into hosts via `jinn integrations install`.

All three surfaces talk to the same in-process daemon. The app and the operator MCP both reach the daemon over its local HTTP API at `127.0.0.1:7331`; the CLI invokes the same code paths in-process for read verbs and through the daemon's API for verbs that need a running daemon.

## 3. The operator's journey through the app

The SPA at `src/dashboard/spa/` has two distinct modes, switched by `App.tsx` based on `/v1/bootstrap` state.

### 3.1 Onboarding — bootstrap not yet running

Full-screen takeover that narrates the [11-step fleet bootstrap state machine](../docs/superpowers/specs/2026-04-09-hd-wallet-fleet-design.md) as three operator-meaningful phases:

1. **Provisioning your wallet** — `wallet`, `safe_predicted` substeps. Generates the encrypted keystore + predicts the Safe address.
2. **Fund your wallet** — `awaiting_funding`. The blocking step. The daemon polls every 15s and surfaces the funding gate via `/v1/bootstrap`; the panel renders the address card. On testnet, the daemon can drain the Coinbase Developer Platform faucet automatically; on mainnet, the operator funds manually.
3. **Joining Jinn** — everything from `safe_deployed` through `mech_deployed`, `agent_registered`, `safe_binding_pending`. Non-blocking; the panel shows progress.

When bootstrap reaches `complete`, the daemon flips into running mode and the SPA transitions to Operating. There is no Phase 4 — onboarding is one-time, not a permanent dashboard region.

**Claude auth and the per-harness gate.** The daemon runs regardless of whether Claude is authenticated. Auth state is surfaced per-harness: each Harness that spawns a `claude` subprocess (currently `claude-code-learner`, `claude-mcp-prediction`, and `claude-mcp-prediction-apy`) implements `isReady()` via `probeClaudeAuth`. `HarnessReadinessRegistry` (`src/harnesses/readiness-registry.ts`) composes those probes on a refresh tick and serves them to `GET /v1/status` and the harness readiness / auth-status endpoints; the SPA's `HarnessReadinessStep` reads them and surfaces the appropriate `nextStep` action — install or sign-in. Readiness is **reporting, not a claim gate**: Wave-4 D1 retired the engine-watcher that skipped claiming on `ready: false`, and claim eligibility is now Settings → Claim policy & wiring ([`client/OPERATOR-APP-SPEC.md`](OPERATOR-APP-SPEC.md) §2.15). An unauthenticated harness therefore fails at execution time rather than being filtered before the claim.

### 3.2 Operating — bootstrap complete

Steady-state dashboard with four regions, fed by polling and SSE:

- **Status** — at-a-glance state for an operator who already knows what they're looking at. Daemon health, in-flight Tasks, recent verdicts, earnings, fleet state, master gas runway, recent activity. Source: `GET /v1/status` (see `src/api/gather-status.ts`), polled at the configured interval.
- **Visibility** — the "what is the daemon doing right now" surface. A live event stream over SSE on `/v1/events`, populated from a daemon-side ring buffer of structured events. Filterable, pinnable, with a collapsible raw-log tail.
- **Setup** — the same 11-step state machine, but in steady-state mode it surfaces only what changes after bootstrap (re-keying, fleet scale, identity binding retries).
- **Operator console** — a separate Next.js app (`apps/operator-console`) consumes the versioned read/control plane over HTTP. The daemon origin has no human surface.

The two-mode design — onboarding takeover, then operating dashboard — is intentional: a new operator's screen is dominated by what they need to do *now*, not by metrics that mean nothing yet.

### 3.3 Auth and binding

The operator console is a separate origin (headless §9). On startup the daemon prints a one-shot handshake URL with a random `?k=<key>` query param. Cost-mutating routes additionally require a bearer token (`DAEMON_API_TOKEN`, generated per-process unless the operator pins one). `GET /v1/status` is token-gated like every other operator-class route (spec §14.5); `GET /health`, `GET /ready`, and `GET /metrics` are the deliberate exception — shallow, unauthenticated-safe liveness/readiness/metrics endpoints for supervisors and scrapers (spec §6.1–§6.2). Details: `src/api/handshake.ts`, `src/api/ui-token.ts`, `src/api/health-endpoint.ts`, `src/api/metrics-endpoint.ts`.

## 4. The CLI substrate

The CLI is the substrate the app drives and the contract external automation writes against. The full verb set + JSON shapes + error envelopes are canonical at [`spec/2026-04-14-client-surface.md`](../spec/2026-04-14-client-surface.md). Verbs cluster into five groups:

| Group | Verbs | Role |
|---|---|---|
| Lifecycle | `auth`, `init`, `doctor`, `fund-requirements`, `bootstrap`, `run`, `stop`, `version`, `update` | First-30-minutes path; idempotent. `jinn run` subsumes init + funding check + bootstrap + foreground daemon. |
| Monitoring | `status`, `fleet`, `balance`, `history`, `rewards`, `logs` | Read-only. Default to JSON; `--human` for terminal pretty-print. |
| Action | `tasks submit`, `claim-rewards`, `fleet scale`, `fleet retire`, `withdraw`, `keys backup`, `keys change-password` | Tx-emitting; require `--yes` or TTY confirmation, support `--dry-run`. |
| Extension | `solver-nets`, `harnesses`, `solver-plugins`, `integrations` | Manage the SolverNet/Harness/Plugin surface and AI-host wiring. |
| Surface | `mcp`, `ui` | `jinn mcp` runs the operator MCP over stdio; `jinn ui` opens the operator console (default `http://127.0.0.1:3000`). |

The CLI dispatcher is `src/cli/index.ts`; each verb is a `CommandModule` under `src/cli/commands/<verb>.ts`. New operators only need three: `jinn auth`, `jinn run`, and (when something is wrong) `jinn doctor`.

## 5. Runtime layers

A `jinn run` process is layered top-to-bottom roughly like this:

```
  ┌────────────────────────────────────────────────────────────┐
  │ Operator surfaces                                          │
  │   Console (apps/operator-console) · CLI · Operator MCP     │
  │   src/cli  src/mcp/operator-server                         │
  ├────────────────────────────────────────────────────────────┤
  │ HTTP API + setup-mode controller                           │
  │   Hono server · /v1/* · /auth/* · /artifacts/*             │
  │   src/api/server.ts  src/setup-mode.ts                     │
  ├────────────────────────────────────────────────────────────┤
  │ Fleet bootstrap                                            │
  │   11-step state machine · keystore · service registry      │
  │   src/earning/bootstrap.ts  src/earning/store.ts           │
  ├────────────────────────────────────────────────────────────┤
  │ Daemon orchestrator                                        │
  │   work · evaluator · posting · projector ·                 │
  │   evidence-driver · reward-claim · balance-topup ·         │
  │   eviction-check · checkpoint · harvest · watchdog         │
  │   src/daemon/daemon.ts + src/daemon/*-loop.ts              │
  ├────────────────────────────────────────────────────────────┤
  │ Work pipeline + native coordinators                        │
  │   claim gate · engagement ledger · spend caps ·            │
  │   runPipeline: claim → submit → deliver → settle           │
  │   src/daemon/composition-root.ts  native-*-coordinator.ts  │
  ├────────────────────────────────────────────────────────────┤
  │ Harness registry + SolverNet registry + Plugins            │
  │   solverType → harness selection · canonical + extra       │
  │   plugins · external impls (Path 2)                        │
  │   src/harnesses/  src/solver-nets/  src/solver-types/      │
  ├────────────────────────────────────────────────────────────┤
  │ Execution adapter                                          │
  │   MechAdapter ↔ JinnRouter · Mech Marketplace · Safe txns  │
  │   src/adapters/mech/                                       │
  ├────────────────────────────────────────────────────────────┤
  │ Runner + runner-scoped MCP                                 │
  │   ClaudeRunner spawns claude · MCP server exposes tools    │
  │   like acquire_artifact, submit_restoration_result         │
  │   src/runner/claude.ts  src/mcp/server.ts                  │
  ├────────────────────────────────────────────────────────────┤
  │ Knowledge surfaces                                         │
  │   ERC-8004 IdentityPublisher + ReputationFeedback ·        │
  │   Corpus (subgraph + IPFS) · x402 payment-gated artifacts  │
  │   src/erc8004/  src/corpus/  src/x402/                     │
  ├────────────────────────────────────────────────────────────┤
  │ Storage                                                    │
  │   SQLite Store · FleetStateStore (file)                    │
  │   src/store/  src/earning/store.ts                         │
  └────────────────────────────────────────────────────────────┘
```

The boundaries are real: each layer's interface is a TypeScript module export, and dependencies point downward. The two notable exceptions are observability (`src/observability/`, `src/events/emitter.ts`), which every layer calls into, and config (`src/config.ts`), which is loaded once and threaded through.

## 6. Daemon loops

The daemon orchestrator (`src/daemon/daemon.ts`) starts and supervises the long-running loops. There is no fixed set — **every loop is conditional**, so the running shape is a function of the vertical mode (`legacy` or `native-v1`) and config. `Daemon.start()` computes the started set (search `started.add(` in `daemon.ts`); `LOOP_REGISTRY` in `daemon/loop-heartbeat.ts` is the single source of loop names, heartbeat intervals, and admission class.

**Admission class** comes from `LOOP_REGISTRY`. `always` loops run whatever the daemon's readiness; `ready-only` loops are held while readiness is `bootstrapping` or `degraded`, so a daemon that has not finished — or has fallen out of — bootstrap does not claim, post, or settle.

| Loop | File | Starts when | Job |
|---|---|---|---|
| Work | `daemon/work-loop.ts` | `composition` + `work` configured | The native solver loop. Per card announced by the projector's archive: gate on projector catch-up, map to `SubmissionFacts`, gate on the rolling-window AI-units / spend-cap accounting, admit a claim intent in the engagement ledger, then drive the pipeline claim → submit → deliver → settle. Also reconciles in-flight settlements every tick. |
| Evaluator | `daemon/evaluator-loop.ts` | `evaluator` configured | The evaluator counterpart of `work`: recover in-flight work → poll the signed opportunity source → acquire subject material → evaluate → deliver + settle a verdict. |
| Posting | `daemon/posting-loop.ts` | native mode + non-empty `posting[]` | The native counterpart of `creator` — drives the requester's `posting[]` config through the marketplace binding. |
| Projector | `daemon/projector-loop.ts` | `composition` configured | Reads venue chain events, reduces them into marketplace projection state, and publishes signed announcements into the local discovery archive the work loop reads. |
| Evidence-driver | `daemon/evidence-driver.ts` | `composition` configured | Drives `sync()` on the local evidence runtime, decides publication, and surfaces indexing failures for the `/v1/status` rollup and the `evidence_indexing_failed` notification. |
| Reward-claim | `daemon/reward-claim-loop.ts` | `rewardClaim.intervalMs > 0` | Periodically pulls pending stOLAS distributor rewards for all staked fleet services. |
| Balance-topup | `daemon/balance-topup-loop.ts` | `balanceTopup.intervalMs > 0` | Refills agent EOA gas + Safe ETH from the master wallet when balances cross configured thresholds. |
| Eviction-check | `daemon/eviction-loop.ts` | `evictionCheck.intervalMs > 0` | Polls each complete service's staking state; on `Evicted`, restakes it without needing a daemon restart. |
| Checkpoint | `daemon/checkpoint-loop.ts` | `checkpoint.intervalMs > 0` | Calls bare `checkpoint()` on each staking proxy hosting a fleet service, so `tsCheckpoint` advances on the operator's pace rather than waiting for someone else to invoke it. |
| Harvest | `daemon/harvest-loop.ts` | `harvest` enabled with repos or `sessions` | Commit-echo mining from configured local repos (task-creator v0). |

Startup also runs **one-shot in-flight recovery** before any loop takes new work: `NativeOperatorHost.start()` in `native-v1`, `WorkLoop.initialize()` otherwise, which re-drives admitted claims and unsettled solutions (`reconcileStartup`) and syncs discovery. The work loop repeats the same reconcile on a cadence thereafter.

Each loop runs as a background Promise; failures emit a structured error event but do not crash the process. The watchdog (`daemon/watchdog-loop.ts`) registers every started loop against its `LOOP_REGISTRY` heartbeat and exits non-zero when one goes stale, letting the supervisor restart through the idempotent boot path. `daemon.stop()` signals each loop, drains in-flight work with a configurable timeout, and closes resources.

> Wave-4 D6 removed `creator`, `engine-tick`, `engine-watcher`, `delivery-watcher`, and `peer-sync` from `LOOP_REGISTRY` after D1–D4 deleted those loops ([DR-2026-08-05](../log/decisions/2026-08-05-cutover-one-swap-collapse.md), addendum 2026-08-13). Remaining ten: `posting`, `reward-claim`, `balance-topup`, `eviction-check`, `checkpoint`, `harvest`, `projector`, `evidence-driver`, `work`, `evaluator`. Intervals and admission of the survivors are unchanged.

### 6.1 Generator ownership and the launched-record subsystem

A SolverNet's **generator** (the Creator-loop input that synthesizes new Tasks for that SolverNet — e.g. `prediction-v1-auto.ts` polling Polymarket) is gated by **launched-record ownership**, not by a config flag. The semantic-level gate is canonical at [`spec/2026-05-05-solvernet-creation-and-launch.md`](../spec/2026-05-05-solvernet-creation-and-launch.md) §11; below is how the daemon implements it.

On startup, `src/main.ts` walks the launched-record store at `~/.jinn-client/solvernets/launched/` for records this operator owns. For each record where `status === 'launched'` and `generatorEnabled === true`, the daemon constructs the matching SolverType-specific generator and wires it as a `TaskSource` on the Creator loop. Generator-config edits (cadence / allowlist / blocklist) hot-apply: the launcher SPA's PATCH writes both the on-disk record *and* an in-memory mirror inside the running generator's closure, so cadence changes take effect within one generator tick (no daemon restart). This was a P0 bug in the predecessor Launcher mode (`jinn-mono-p1t4.2`) and is regression-tested.

Operator-side participation is the dual surface: a `joinedSolverNets[<manifestCid>]` config entry records which launched SolverNets this operator participates in. Wave-4 D1 retired the join/leave write path and the `canAcceptTask` claim gate that read it, so these entries no longer gate claiming — claim eligibility is Settings → Claim policy & wiring ([`client/OPERATOR-APP-SPEC.md`](OPERATOR-APP-SPEC.md) §2.15), and `/operator/memberships` is a read-only view until cutover stage 5. What the entries still do is scope discovery: at boot `main.ts` derives `taskDiscoveryManifestCids` from the entries holding the `solver` role and `evaluatorEnabled` from those holding `evaluator`, so a daemon with no joined SolverNets discovers no task or evaluation opportunities. Both are read once at startup — edits are restart-required, not hot-applied. Membership never starts a generator; that's launcher-only.

The legacy `taskGenerator.enabled` config flag and the predecessor Launcher mode's `roles.includes('launching')` gate are gone. Internal harness dispatch may still alias `solverType = `${contractId}.${contractVersion}`` for one migration cycle (per spec §15); new code does not introduce dependencies on it.

### 6.2 SolverNet launch publish — IdentityRegistry-anchored manifests over IPFS

Wave-4 D4 retired the ERC-8004 registry *reader* (`registry-client.ts`, `GET /v1/solvernets/registry*`). Catalog reads go through `discovery-client.listLaunchedSolverNets`. The launch path still pins a canonical manifest to IPFS and broadcasts `IdentityRegistry.setMetadata` via `operator/src/solvernets/launch-publisher.ts` (helpers carved out of the retired client so launch recovery keeps working):

- **Pin + broadcast** — canonicalize the manifest (RFC 8785 JCS), pin the JSON to IPFS via `operator/src/adapters/mech/ipfs.ts`, then `IdentityRegistry.setMetadata(launcherAgentId, "solvernet-manifest:<cid>", { schemaVersion: 'solvernet.lifecycle.v1', status, at, hash })`. This piggybacks the existing `IdentityPublisher` pattern (`operator/src/erc8004/identity.ts`) — no new contract.
- **Lifecycle vocabulary** — `encodeLifecyclePayload` / `SOLVERNET_MANIFEST_KEY_PREFIX` stay; Wave-4 D3 retired the lifecycle *producer*, not the on-wire shape. Authenticity still flows from `msg.sender == launcher's agent wallet`.
- **Most-recent-wins** — `operator/src/solvernets/most-recent-wins.ts` remains for launch recovery (mempool-drop detection), not as a catalog reader.

There is no hosted SolverNet registry contract and no launcher follow-list. Spec §13's client interface is gone from this process; the indexer GraphQL catalog (`discovery-client`) is the remaining list/resolve path.

## 7. Task lifecycle, end-to-end

This is the path a single Task takes from operator intent to settled reward. The semantic-level lifecycle is canonical at [`spec/2026-05-02-task-coordinator-one-to-many.md`](../spec/2026-05-02-task-coordinator-one-to-many.md); below is how the client implements it.

```
operator                  daemon process              chain / network
────────                  ──────────────              ───────────────
1. jinn tasks submit  ──► CreatorLoop
   (or app · MCP)        │
                         └► adapter.submitTask  ────► JinnRouter.createTask
                                                      (Mech Marketplace announces)

2.                          projector  ◄────────────── venue chain events
                            └► signed announcements → local discovery archive
                            work loop  ◄── announced cards from that archive
                            ├► ClaimGate (is the projector caught up?)
                            ├► SubmissionFacts + AI-units / spend-cap gate
                            ├► ledger.admitClaimIntent (before any broadcast)
                            └► runPipeline
                                ├► claim  ─────────────► JinnRouter (claim fee)
                                ├► backend.submit → Harness.run(ctx)
                                │   ├► runner-scoped MCP (acquire_artifact, …)
                                │   ├► corpus / subgraph / x402 reads
                                │   └► ClaudeRunner spawns `claude` subprocess
                                ├► packaging (artifact → SQLite served_artifacts)
                                ├► envelope assembly (manifest → IPFS)
                                ├► IdentityPublisher.setMetadata  ─► ERC-8004 IdentityRegistry
                                └► deliver + settle ────► Mech Marketplace
                                                          JinnRouter.claimDelivery

3.                          evaluator loop
                            ├► poll the signed opportunity source
                            ├► acquire subject material
                            ├► evaluate, then deliver + settle a verdict
                            └► ReputationRegistry.giveFeedback ─► ERC-8004 ReputationRegistry
                                                                  (rates the harness's agent NFT)

4.                          reward-claim loop  ──────► stOLAS distributor
```

The boundaries between steps are persisted in SQLite, so a crash anywhere is recoverable: startup recovery (`NativeOperatorHost.start()` / `WorkLoop.initialize()`) re-drives admitted claims and unsettled solutions, and the loops are idempotent.

A few non-obvious points:

- **The agent EOA private key never leaves the daemon process.** The runner subprocess (Claude CLI) and the operator MCP both reach signing operations through the daemon's HTTP API, which holds the key in memory.
- **Artifact bytes live in the operator's SQLite + HTTP server**, not on IPFS; only the manifest envelope goes to IPFS. Evaluators fetch artifacts from the operator's `publicEndpoint` under x402 payment gating per [`spec/2026-04-30-phase-a-umbrella.md`](../spec/2026-04-30-phase-a-umbrella.md) §1.
- **ERC-8004 anchoring is gated** on the bootstrap having minted an agent NFT for the active service. When `agent_id` is null on the active service, `IdentityPublisher` and `ReputationFeedback` are disabled with a clear log line.
- **Tasks carry `solverNetManifestCid` as a BINDING field** (per [`spec/2026-05-05-solvernet-creation-and-launch.md`](../spec/2026-05-05-solvernet-creation-and-launch.md) §14). The on-chain `TaskCoordinator` task digest is `manifestDigest = keccak256(manifestCid)` — manifest-bound, not solverType-bound. This makes operator eligibility per-launch, not per-protocol: an operator participating in launcher A's Prediction is not automatically eligible to claim launcher B's Prediction tasks even though both share the same SolverNet contract. The Task document also carries `contractId` + `contractVersion` (e.g. `prediction` + `v1`) for harness dispatch; daemon-internal code may still use a derived `solverType = `${contractId}.${contractVersion}`` alias for one migration cycle but new code resolves the contract by `{ id, version }`.
- **Manifest resolution is local + indexer-mediated.** Task validation reads the launched-record / IPFS manifest for `taskDoc.solverNetManifestCid`, then dispatches via `manifest.contract.id + manifest.contract.version`. Wave-4 D4 deleted the in-process ERC-8004 registry client; catalog list/resolve goes through `discovery-client` (see §6.2).

## 8. Extension points

The architecture is designed for the protocol team to ship a usable default and for outside builders to extend without forking. The full extension architecture is canonical at [`spec/2026-05-01-harness-pack-architecture.md`](../spec/2026-05-01-harness-pack-architecture.md); below is the in-code surface.

### Harnesses (the executor layer)

A **Harness** is the implementation that runs inside the engine for a given task. Default Harnesses are built into the client and registered via `buildHarnesses(...)` in `src/harnesses/impls/index.ts`. The registry (`src/harnesses/engine/registry.ts`) maps `solverType` → harness name, with config-level overrides:

- `harnesses.default` — fallback Harness when no SolverNet selection applies.
- `harnesses.disabled` — names to skip during registration. Default disabled list lives in the registry.
- `harnesses.externalImpls[]` — operator-supplied npm packages loaded via `src/harnesses/external-impls/`. Each entry is verified against `trustedImplSigners` before its factory runs. Failed loads are logged and skipped, not fatal. The Path 2 contract is documented at [`operator/docs/path-2/`](docs/path-2/).

### SolverPlugins (the configuration layer)

A **SolverPlugin** packages solverType-specific schemas, Claude Code plugins, MCP servers, and skills for a Harness to load while solving Tasks. Plugins are attached to **SolverNets**, not Harnesses — switching a SolverNet's Harness preserves its plugin set.

CLI surface:

```bash
jinn solver-nets list
jinn solver-nets show <name>
jinn solver-nets enable <name> --harness <harness>
jinn solver-nets set-harness <name> <harness>
jinn solver-nets add-plugin <name> bundled:<plugin>
jinn solver-nets disable <name>
jinn solver-nets doctor <name>
```

Plugin authoring is documented at [`operator/docs/solver-plugins.md`](docs/solver-plugins.md). The `enable` flow is an idempotent state machine; rerun until `"status": "ready"` or `waiting_for_external_action`.

### Operator MCP integrations

`jinn integrations install` detects supported AI hosts (Claude Code, Claude Desktop, Cursor, VS Code, Gemini CLI, Antigravity, Codex) and installs the `jinn mcp` MCP server plus a copy of the `jinn-operator` skill. Implementation lives at `src/cli/commands/integrations.ts`; bundled plugins live under [`operator/plugins/`](plugins/).

### Peers and corpus

When `subgraphUrl` is configured, the daemon backfills artifact metadata and node endpoints from the Jinn ERC-8004 subgraph at startup, and the runtime corpus (`src/corpus/`) is wired so MCP tools (`search_artifacts`, `acquire_artifact`) can serve cross-operator queries. Wave-4 D4 retired the peer-sync loop; `peers` / `JINN_PEERS` remain parseable but unused.

### Local API extensions

The Hono server at `src/api/server.ts` is the place to add new HTTP endpoints. Existing endpoint groups: `/v1/status`, `/v1/events` (SSE), `/v1/bootstrap`, `/v1/artifacts/*`, `/auth/handshake`, `/api/admin/*` (UI-token-gated), `/api/agent/ws`, plus per-domain endpoints (`/v1/portfolio-v0/*`, `/v1/prediction-v1/*`). Cost-mutating routes require the `DAEMON_API_TOKEN` bearer.

## 9. Where to look in code

A short pointer table for engineers diving in:

| Concern | Start here |
|---|---|
| Daemon entrypoint | `src/main.ts` |
| Adding a CLI verb | `src/cli/index.ts` + a new `src/cli/commands/<verb>.ts` |
| Adding an HTTP endpoint | `src/api/server.ts` + a new `src/api/<topic>-endpoints.ts` |
| Adding a SolverType | [`docs/runbooks/add-solver-type.md`](../docs/runbooks/add-solver-type.md) |
| Adding a Harness (in-repo) | `src/harnesses/impls/` + register in `buildHarnesses` |
| Adding a Harness (external npm) | [`operator/docs/path-2/`](docs/path-2/) |
| Authoring a SolverPlugin | [`operator/docs/solver-plugins.md`](docs/solver-plugins.md) |
| Bootstrap state machine | `src/earning/bootstrap.ts`, `src/earning/types.ts` |
| Daemon loops + admission | `src/daemon/daemon.ts`, `src/daemon/loop-heartbeat.ts` |
| Native work pipeline | `src/daemon/work-loop.ts`, `src/daemon/composition-root.ts` |
| Marketplace adapter calls | `src/adapters/mech/contracts.ts`, `src/adapters/mech/adapter.ts` |
| Storage schema | `src/store/store.ts` |
| Launched-record store + draft store | `src/solvernets/store.ts`, `src/solvernets/launch-state-machine.ts`, `src/solvernets/lifecycle-transitions.ts` |
| SolverNet registry client | `src/solvernets/registry-client.ts` (interface) + `src/solvernets/registry-client-erc8004.ts` (IdentityRegistry-backed impl) |
| Operator MCP tools | `src/mcp/operator-server.ts` |
| Runner-scoped MCP tools | `src/mcp/server.ts` |
| Operator SPA | `src/dashboard/spa/` (see its [README](src/dashboard/spa/README.md)) |
| Launcher pages | `src/dashboard/spa/src/pages/Launcher.tsx`, `LauncherCreate.tsx`, `LauncherLaunched.tsx` |
| Operator memberships (read-only) | `src/dashboard/spa/src/pages/operator/MembershipsTab.tsx`, `src/dashboard/spa/src/pages/operator-catalog/RegistryCatalog.tsx` |
| Tests | `operator/test/` (see [`docs/runbooks/testing.md`](../docs/runbooks/testing.md)) |

## 10. Canonical references

This doc integrates and links into:

- [`SPEC.md`](../SPEC.md) — protocol spec
- [`spec/2026-04-14-client-surface.md`](../spec/2026-04-14-client-surface.md) — stable CLI/JSON contract
- [`spec/2026-04-28-restorer-architecture.md`](../spec/2026-04-28-restorer-architecture.md) — substrate-first vs specialists-first ADR
- [`spec/2026-05-01-harness-pack-architecture.md`](../spec/2026-05-01-harness-pack-architecture.md) — Harness / SolverNet / SolverPlugin extension architecture
- [`spec/2026-05-02-task-coordinator-one-to-many.md`](../spec/2026-05-02-task-coordinator-one-to-many.md) — Task lifecycle semantics
- [`spec/2026-05-05-solvernet-creation-and-launch.md`](../spec/2026-05-05-solvernet-creation-and-launch.md) v0.2 — **canonical authority** for SolverNet creation + launch flow, manifest shape, generator ownership (§11), operator join (§12), registry interface (§13), and manifest-bound task attribution (§14)
- [`spec/2026-04-30-phase-a-umbrella.md`](../spec/2026-04-30-phase-a-umbrella.md) — corpus library, manifest hygiene, x402 gating
- [`docs/superpowers/specs/2026-05-01-operator-local-app-design.md`](../docs/superpowers/specs/2026-05-01-operator-local-app-design.md) — operator app design
- [`docs/superpowers/specs/2026-04-09-hd-wallet-fleet-design.md`](../docs/superpowers/specs/2026-04-09-hd-wallet-fleet-design.md) — fleet bootstrap state machine
- [`docs/superpowers/specs/2026-04-09-testnet-mech-marketplace-design.md`](../docs/superpowers/specs/2026-04-09-testnet-mech-marketplace-design.md) — Mech marketplace + daemon design
- [`docs/operator-testnet.md`](../docs/operator-testnet.md) — operator runbook
- [`operator/README.md`](README.md) — install + first-run + verbs
- [`client/CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup
