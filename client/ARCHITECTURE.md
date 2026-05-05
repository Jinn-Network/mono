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

Full-screen takeover that narrates the [11-step fleet bootstrap state machine](../docs/superpowers/specs/2026-04-09-hd-wallet-fleet-design.md) as four operator-meaningful phases:

1. **Sign in to Claude** — `jinn auth` equivalent, gated until Claude is authenticated. The daemon refuses to start without it because Harnesses spawn `claude` subprocesses.
2. **Provisioning your wallet** — `wallet`, `safe_predicted` substeps. Generates the encrypted keystore + predicts the Safe address.
3. **Fund your wallet** — `awaiting_funding`. The blocking step. The daemon polls every 15s and surfaces the funding gate via `/v1/bootstrap`; the panel renders the address card. On testnet, the daemon can drain the Coinbase Developer Platform faucet automatically; on mainnet, the operator funds manually.
4. **Joining Jinn** — everything from `safe_deployed` through `mech_deployed`, `agent_registered`, `safe_binding_pending`. Non-blocking; the panel shows progress.

When bootstrap reaches `complete`, the daemon flips into running mode and the SPA transitions to Operating. There is no Phase 5 — onboarding is one-time, not a permanent dashboard region.

### 3.2 Operating — bootstrap complete

Steady-state dashboard with four regions, fed by polling and SSE:

- **Status** — at-a-glance state for an operator who already knows what they're looking at. Daemon health, in-flight Tasks, recent verdicts, earnings, fleet state, master gas runway, recent activity. Source: `GET /v1/status` (see `src/api/gather-status.ts`), polled at the configured interval.
- **Visibility** — the "what is the daemon doing right now" surface. A live event stream over SSE on `/v1/events`, populated from a daemon-side ring buffer of structured events. Filterable, pinnable, with a collapsible raw-log tail.
- **Setup** — the same 11-step state machine, but in steady-state mode it surfaces only what changes after bootstrap (re-keying, fleet scale, identity binding retries).
- **Agent** — an embedded Claude Code session running in Auto Mode, attached to the operator MCP server so the AI can read daemon state and perform a small set of write operations (submit Task, enable SolverNet, claim rewards) without leaving the panel. Implementation is the agent WebSocket bridge at `src/agent/agent-ws.ts` attached to the same Hono server that serves the SPA.

The two-mode design — onboarding takeover, then operating dashboard — is intentional: a new operator's screen is dominated by what they need to do *now*, not by metrics that mean nothing yet.

### 3.3 Auth and binding

The SPA is loopback-only by default. On startup the daemon prints a one-shot handshake URL with a random `?k=<key>` query param; the launcher opens it and the SPA exchanges the key for a `jinn_ui_token` cookie via `/auth/handshake`. Cost-mutating routes additionally require a bearer token (`DAEMON_API_TOKEN`, generated per-process unless the operator pins one). Details: `src/api/handshake.ts`, `src/api/ui-token.ts`, the SPA dev README at [`src/dashboard/spa/README.md`](src/dashboard/spa/README.md).

## 4. The CLI substrate

The CLI is the substrate the app drives and the contract external automation writes against. The full verb set + JSON shapes + error envelopes are canonical at [`spec/2026-04-14-client-surface.md`](../spec/2026-04-14-client-surface.md). Verbs cluster into five groups:

| Group | Verbs | Role |
|---|---|---|
| Lifecycle | `auth`, `init`, `doctor`, `fund-requirements`, `bootstrap`, `run`, `stop`, `version`, `update` | First-30-minutes path; idempotent. `jinn run` subsumes init + funding check + bootstrap + foreground daemon. |
| Monitoring | `status`, `fleet`, `balance`, `history`, `rewards`, `logs` | Read-only. Default to JSON; `--human` for terminal pretty-print. |
| Action | `tasks submit`, `claim-rewards`, `fleet scale`, `fleet retire`, `withdraw`, `keys backup`, `keys change-password` | Tx-emitting; require `--yes` or TTY confirmation, support `--dry-run`. |
| Extension | `solver-nets`, `harnesses`, `solver-plugins`, `integrations` | Manage the SolverNet/Harness/Plugin surface and AI-host wiring. |
| Surface | `mcp`, `ui` | `jinn mcp` runs the operator MCP over stdio; `jinn ui` opens a panel for an already-running daemon. |

The CLI dispatcher is `src/cli/index.ts`; each verb is a `CommandModule` under `src/cli/commands/<verb>.ts`. New operators only need three: `jinn auth`, `jinn run`, and (when something is wrong) `jinn doctor`.

## 5. Runtime layers

A `jinn run` process is layered top-to-bottom roughly like this:

```
  ┌────────────────────────────────────────────────────────────┐
  │ Operator surfaces                                          │
  │   SPA · CLI dispatcher · Operator MCP · Agent WS bridge    │
  │   src/dashboard/spa  src/cli  src/mcp/operator-server      │
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
  │   CreatorLoop · engine-watcher · engine-tick ·             │
  │   DeliveryWatcher · RewardClaim · BalanceTopup ·           │
  │   JinnClaim (L1↔L2) · PeerSync                             │
  │   src/daemon/daemon.ts + src/daemon/*-loop.ts              │
  ├────────────────────────────────────────────────────────────┤
  │ Task engine                                                │
  │   canAcceptTask · observe · process state machine ·        │
  │   recoverInFlight · runTickLoop                            │
  │   src/harnesses/engine/engine.ts                           │
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

The daemon orchestrator (`src/daemon/daemon.ts`) starts and supervises a fixed set of long-running loops. The README's "three concurrent loops" model is out of date; the current shape is eight, plus one-shot recovery on startup.

| Loop | File | Job |
|---|---|---|
| `recoverInFlight` (one-shot) | `harnesses/engine/engine.ts` | On startup, walks SQLite for tasks left mid-state by a previous crash and re-enters their state machines. |
| Creator | `daemon/creator.ts` | Pulls Tasks from configured `TaskSource`s and posts each via `JinnRouter.createTask`. Idempotent per `(creatorMultisig, desiredStateId)`. |
| Engine-watcher | `daemon/daemon.ts` (`_runEngineWatcherLoop`) | Consumes `adapter.watchForTasks()` async iterator, calls `engine.canAcceptTask`, claims via `adapter.claimTask`, then `engine.observe` + fire-and-forget `engine.process`. |
| Engine-tick | `harnesses/engine/engine.ts` (`runTickLoop`) | Every `pollIntervalMs`, drives in-flight Tasks whose state transitions are time-based rather than event-driven. |
| Delivery-watcher | `daemon/delivery-watcher.ts` | Watches for delivered Solutions, calls `JinnRouter.claimDelivery` to settle them, and (for restoration role) creates the paired evaluation job. |
| Reward-claim | `daemon/reward-claim-loop.ts` | Periodically pulls pending stOLAS distributor rewards for the master EOA. Disabled when `rewardClaimIntervalMs <= 0`. |
| Balance-topup | `daemon/balance-topup-loop.ts` | Refills agent EOA gas + Safe ETH from the master wallet when balances cross configured thresholds. |
| JinnClaim (L1↔L2) | `daemon/jinn-claim-loop.ts` | Cross-chain JINN claim path — emits `ClaimTicket` on L2, waits for L2→L1 finality (canonical) or plants a fixture (mock), submits the L1 distributor claim. Disabled unless `JINN_ETHEREUM_RPC_URL` and the JINN MVI artifacts are configured. |
| Peer-sync | `api/peers.ts` (`PeerSync`) | When peers are configured, periodically syncs artifacts and node metadata from peer endpoints. Optional. |

Each loop runs as a background Promise; failures emit a structured error event but do not crash the process. `daemon.stop()` signals each loop, drains in-flight work with a configurable timeout, and closes resources.

## 7. Task lifecycle, end-to-end

This is the path a single Task takes from operator intent to settled reward. The semantic-level lifecycle is canonical at [`spec/2026-05-02-task-coordinator-one-to-many.md`](../spec/2026-05-02-task-coordinator-one-to-many.md); below is how the client implements it.

```
operator                  daemon process              chain / network
────────                  ──────────────              ───────────────
1. jinn tasks submit  ──► CreatorLoop
   (or app · MCP)        │
                         └► adapter.submitTask  ────► JinnRouter.createTask
                                                      (Mech Marketplace announces)

2.                          engine-watcher  ◄──────── adapter.watchForTasks
                            │                         (claims arrive)
                            ├► engine.canAcceptTask
                            ├► adapter.claimTask  ──► JinnRouter (claim fee)
                            ├► engine.observe (record provenance)
                            └► engine.process
                                │
                                ├► SolverNet.resolve(solverType)
                                ├► Harness.run(ctx)
                                │   ├► runner-scoped MCP (acquire_artifact, …)
                                │   ├► corpus / subgraph / x402 reads
                                │   └► ClaudeRunner spawns `claude` subprocess
                                ├► packaging (artifact → SQLite served_artifacts)
                                ├► envelope assembly (manifest → IPFS)
                                ├► IdentityPublisher.setMetadata  ─► ERC-8004 IdentityRegistry
                                └► adapter.deliverToMarketplace ──► Mech Marketplace
                                                                    JinnRouter.claimDelivery

3.                          delivery-watcher  ◄────── delivery events
                            ├► JinnRouter.claimDelivery (operator-side)
                            └► (restoration role) creates evaluation Task
                                back to step 1 with role='evaluation'

4.                          (evaluation Harness runs as in step 2)
                            └► after evaluator's claimDelivery:
                                ReputationRegistry.giveFeedback ─► ERC-8004 ReputationRegistry
                                                                    (rates the harness's agent NFT)

5.                          reward-claim-loop  ──────► stOLAS distributor
                            └► (Phase 2) JinnClaim loop ─► JinnDistributor on L1
```

The boundaries between steps are persisted in SQLite, so a crash anywhere is recoverable: `recoverInFlight` re-enters the state machine for any task left mid-flight, and the loops are idempotent.

A few non-obvious points:

- **The agent EOA private key never leaves the daemon process.** The runner subprocess (Claude CLI) and the operator MCP both reach signing operations through the daemon's HTTP API, which holds the key in memory.
- **Artifact bytes live in the operator's SQLite + HTTP server**, not on IPFS; only the manifest envelope goes to IPFS. Evaluators fetch artifacts from the operator's `publicEndpoint` under x402 payment gating per [`spec/2026-04-30-phase-a-umbrella.md`](../spec/2026-04-30-phase-a-umbrella.md) §1.
- **ERC-8004 anchoring is gated** on the bootstrap having minted an agent NFT for the active service. When `agent_id` is null on the active service, `IdentityPublisher` and `ReputationFeedback` are disabled with a clear log line.

## 8. Extension points

The architecture is designed for the protocol team to ship a usable default and for outside builders to extend without forking. The full extension architecture is canonical at [`spec/2026-05-01-harness-pack-architecture.md`](../spec/2026-05-01-harness-pack-architecture.md); below is the in-code surface.

### Harnesses (the executor layer)

A **Harness** is the implementation that runs inside the engine for a given task. Default Harnesses are built into the client and registered via `buildHarnesses(...)` in `src/harnesses/impls/index.ts`. The registry (`src/harnesses/engine/registry.ts`) maps `solverType` → harness name, with config-level overrides:

- `harnesses.default` — fallback Harness when no SolverNet selection applies.
- `harnesses.disabled` — names to skip during registration. Default disabled list lives in the registry.
- `harnesses.externalImpls[]` — operator-supplied npm packages loaded via `src/harnesses/external-impls/`. Each entry is verified against `trustedImplSigners` before its factory runs. Failed loads are logged and skipped, not fatal. The Path 2 contract is documented at [`client/docs/path-2/`](docs/path-2/).

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

Plugin authoring is documented at [`client/docs/solver-plugins.md`](docs/solver-plugins.md). The `enable` flow is an idempotent state machine; rerun until `"status": "ready"` or `waiting_for_external_action`.

### Operator MCP integrations

`jinn integrations install` detects supported AI hosts (Claude Code, Claude Desktop, Cursor, VS Code, Gemini CLI, Antigravity, Codex) and installs the `jinn mcp` MCP server plus a copy of the `jinn-operator` skill. Implementation lives at `src/cli/commands/integrations.ts`; bundled plugins live under [`client/plugins/`](plugins/).

### Peers and corpus

When `subgraphUrl` is configured, the daemon backfills artifact metadata and node endpoints from the Jinn ERC-8004 subgraph at startup, and the runtime corpus (`src/corpus/`) is wired so MCP tools (`search_artifacts`, `acquire_artifact`) can serve cross-operator queries. When `peers` is configured, `PeerSync` (`src/api/peers.ts`) periodically pulls artifact lists from each peer's HTTP endpoint.

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
| Adding a Harness (external npm) | [`client/docs/path-2/`](docs/path-2/) |
| Authoring a SolverPlugin | [`client/docs/solver-plugins.md`](docs/solver-plugins.md) |
| Bootstrap state machine | `src/earning/bootstrap.ts`, `src/earning/types.ts` |
| Engine state machine | `src/harnesses/engine/engine.ts` |
| Marketplace adapter calls | `src/adapters/mech/contracts.ts`, `src/adapters/mech/adapter.ts` |
| Storage schema | `src/store/store.ts` |
| Operator MCP tools | `src/mcp/operator-server.ts` |
| Runner-scoped MCP tools | `src/mcp/server.ts` |
| Operator SPA | `src/dashboard/spa/` (see its [README](src/dashboard/spa/README.md)) |
| Tests | `client/test/` (see [`docs/runbooks/testing.md`](../docs/runbooks/testing.md)) |

## 10. Canonical references

This doc integrates and links into:

- [`SPEC.md`](../SPEC.md) — protocol spec
- [`spec/2026-04-14-client-surface.md`](../spec/2026-04-14-client-surface.md) — stable CLI/JSON contract
- [`spec/2026-04-28-restorer-architecture.md`](../spec/2026-04-28-restorer-architecture.md) — substrate-first vs specialists-first ADR
- [`spec/2026-05-01-harness-pack-architecture.md`](../spec/2026-05-01-harness-pack-architecture.md) — Harness / SolverNet / SolverPlugin extension architecture
- [`spec/2026-05-02-task-coordinator-one-to-many.md`](../spec/2026-05-02-task-coordinator-one-to-many.md) — Task lifecycle semantics
- [`spec/2026-04-30-phase-a-umbrella.md`](../spec/2026-04-30-phase-a-umbrella.md) — corpus library, manifest hygiene, x402 gating
- [`docs/superpowers/specs/2026-05-01-operator-local-app-design.md`](../docs/superpowers/specs/2026-05-01-operator-local-app-design.md) — operator app design
- [`docs/superpowers/specs/2026-04-09-hd-wallet-fleet-design.md`](../docs/superpowers/specs/2026-04-09-hd-wallet-fleet-design.md) — fleet bootstrap state machine
- [`docs/superpowers/specs/2026-04-09-testnet-mech-marketplace-design.md`](../docs/superpowers/specs/2026-04-09-testnet-mech-marketplace-design.md) — Mech marketplace + daemon design
- [`docs/operator-testnet.md`](../docs/operator-testnet.md) — operator runbook
- [`client/README.md`](README.md) — install + first-run + verbs
- [`client/CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup
