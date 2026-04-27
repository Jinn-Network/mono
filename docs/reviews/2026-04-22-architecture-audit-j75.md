# Architecture Audit — Post Jinn CLI / Operator Flow (jinn-mono-j75)

> Version: 1
> Date: 2026-04-22
> Author: ritsukai
> Status: Audit — recommendations, no code changes
> Related: `jinn-mono-7zz`, `jinn-mono-y6w`, `jinn-mono-7ee`, `jinn-mono-cnp`
> Reads: `spec/2026-04-14-client-surface.md`, `spec/2026-04-17-portfolio-v0-design.md`,
>        `spec/2026-04-22-prediction-apy-v0-design.md`, `spec/2026-04-21-agentic-data-substrate.md`

---

## 1. Current-state diagram

```
                            ┌─────────────────────┐
                            │  OPERATOR / AI AGENT│
                            │ (Claude / Codex / … │
                            │   via MCP + CLI)    │
                            └──────────┬──────────┘
                                       │  jinn <verb>
                                       ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ jinn CLI  (client/src/cli)                                                │
│  • init / bootstrap / run / stop / doctor / status                        │
│  • submit-intent  ── loads spec-file ── resolves sentinels ──▶ Adapter    │
│  • intents list/status/enable/disable ── buildIntentsCliRegistry()        │
│  • plugin install/remove/list   (MCP + skill into host AI tool)           │
│  • fleet / balance / withdraw / rewards / claim-rewards / logs / history  │
└──────────────┬───────────────────┬─────────────────────────┬──────────────┘
               │                   │                         │
   writes config              reads/writes               spawns
   ~/.jinn-client/             SQLite                   daemon process
   config.json          ~/.jinn-client/jinn.db          (yarn start)
               │                   │                         │
               ▼                   ▼                         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ Daemon  (client/src/daemon/daemon.ts)                                     │
│  ┌────────────────────┐  ┌─────────────────────┐  ┌────────────────────┐  │
│  │  CreatorLoop       │  │ _runEngineWatcher   │  │ DeliveryWatcher    │  │
│  │  • static states   │  │  adapter.watch      │  │  adapter.watch     │  │
│  │  • IntentGenerator │  │  → engine.observe   │  │  (creator side)    │  │
│  └────────┬───────────┘  └─────────┬───────────┘  └────────┬───────────┘  │
│           │                         │                        │            │
│           │        ┌────────────────▼──────────────┐         │            │
│           │        │ RestorationEngine (state m/c) │         │            │
│           │        │ DISCOVERED → CLAIMED → WAITING │         │            │
│           │        │ → PRE_SNAP → RUNNING →         │         │            │
│           │        │ POST_SNAP → PACKAGING →        │         │            │
│           │        │ DELIVERING → COMPLETE / FAILED │         │            │
│           │        │ (restorer/engine/engine.ts)    │         │            │
│           │        └──┬─────────────────────────┬───┘         │            │
│           │           │ resolves impl           │ packages    │            │
│           │           ▼                         ▼             │            │
│           │  ┌──────────────────────┐  ┌─────────────────┐    │            │
│           │  │ RestorerImplRegistry │  │ packaging +     │    │            │
│           │  │ byKind + default +   │  │ manifest-sign + │    │            │
│           │  │ disabled[] filter    │  │ delivery        │    │            │
│           │  │ (restorer/engine/    │  └─────────────────┘    │            │
│           │  │  registry.ts)        │                         │            │
│           │  └──────────┬───────────┘                         │            │
│           │             │ dispatch(ctx)                       │            │
│           │             ▼                                     │            │
│           │  ┌─────────────────────────────────────────────┐  │            │
│           │  │ RestorerImpl modules (restorer/impls/*)     │  │            │
│           │  │  legacy-claude, claude-mcp-hyperliquid,     │  │            │
│           │  │  claude-mcp-prediction,                     │  │            │
│           │  │  claude-mcp-prediction-apy,                 │  │            │
│           │  │  prediction-v0-baseline,                    │  │            │
│           │  │  prediction-apy-v0-baseline,                │  │            │
│           │  │  portfolio-v0-evaluator,                    │  │            │
│           │  │  prediction-v0-evaluator,                   │  │            │
│           │  │  prediction-apy-v0-evaluator                │  │            │
│           │  └─────────────────────────────────────────────┘  │            │
│           │                                                   │            │
│  ┌────────┴─────────┐   ┌───────────────────┐   ┌─────────────┴────────┐   │
│  │ RewardClaimLoop  │   │ BalanceTopupLoop  │   │ HTTP API (Hono)      │   │
│  └──────────────────┘   └───────────────────┘   │ + PeerSync           │   │
│                                                 └──────────────────────┘   │
└──────┬──────────────────────┬──────────────────────┬─────────────────┬─────┘
       │                      │                      │                 │
       ▼                      ▼                      ▼                 ▼
┌──────────────┐    ┌────────────────────┐   ┌────────────────┐  ┌──────────────┐
│ IPFS         │    │ Chain (Base[-Sep]) │   │ ClaimRegistry  │  │ ERC-8004     │
│ Autonolas    │    │ JinnRouter         │   │ (two-layer     │  │ Identity +   │
│ registry +   │◀──▶│ MechMarketplace    │◀─▶│  claim)        │  │ The Graph    │
│ gateway      │    │ Mech (per service) │   └────────────────┘  │ subgraph     │
│              │    │ StOlas / staking   │                       │ (backfill)   │
└──────────────┘    └────────────────────┘                       └──────────────┘
```

Boxes = processes / stores; solid arrows = synchronous calls or event streams;
dashed semantics = persistence / IPC. The `CLI → Daemon` edge is indirect:
both processes share `~/.jinn-client/` (config, keystore, SQLite, fleet state
JSON) and the daemon's HTTP API on `127.0.0.1:${apiPort}`.

---

## 2. Intent data model

### 2.1 Canonical type

Every intent in the system is a `DesiredState` (`client/src/types/desired-state.ts`).
Everything else — on-chain request, DB row, manifest — is a projection.

```ts
interface DesiredState {
  id: string;                              // stable, operator-chosen or UUID
  description: string;                     // human-readable
  context?: Record<string, unknown>;       // opaque passthrough
  type?: 'restoration' | 'evaluation';     // default 'restoration'
  attemptId?: string;                      // "${id}/${attemptNumber}"
  attemptNumber?: number;
  restorationRequestId?: string;           // back-pointer for eval jobs

  window?: { startTs: number; endTs: number };     // §3 spec
  spec?:   { kind: string } & Record<string, unknown>;  // dispatcher key
  eligibility?: Record<string, unknown>;
}
```

Typed refinements live alongside (`types/prediction.ts`, `types/portfolio.ts`,
`types/prediction-apy.ts`) as Zod schemas. They are **not** unified under one
`spec.kind` registry — today each kind's schema module is imported directly by
the impls that care.

### 2.2 Lifecycle and ownership


| Stage                      | Where it lives                                                                                                                      | Who writes                                   | Mutable?                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| Template                   | `fixtures/*.example.json`, operator files                                                                                           | operator / agent                             | yes (prior to submit)                       |
| Sentinel-resolved template | in-memory in `jinn submit-intent`                                                                                                   | CLI                                          | once                                        |
| Posted intent              | **IPFS** (canonical bytes) + **chain event** (`restorationDataHex` digest on `JinnRouter`)                                          | creator Safe via `submitRestorationJob`      | immutable after tx mined                    |
| `restorationRequestId`     | `MechMarketplace` storage + `RestorationJobCreated` log                                                                             | MechMarketplace                              | immutable                                   |
| Creator-side cache         | SQLite `config_values` keyed `created_intent:{safe}:{id}`                                                                           | CreatorLoop / submit-intent                  | append-only; survives restart               |
| Restorer-side row          | SQLite `restoration_intents` (request_id PK, DesiredState JSON, window, state, snapshots, artifact CIDs, manifest CID, delivery tx) | RestorationEngine (`observe` + `transition`) | advances along state machine                |
| Working dir                | `/tmp/jinn-engine-working/{requestId}/intent.json + env/ + sessions/`                                                               | engine `takePreSnapshot`                     | ephemeral; recreated on recover             |
| Impl state dir             | `/tmp/jinn-engine-impl-state/{implName}/`                                                                                           | impl's own code                              | persistent across intents                   |
| Result manifest            | **IPFS** (`portfolio.v0.manifest.v1` / equivalent per kind)                                                                         | engine `pack` (signed by agent EOA)          | immutable, CID recorded in `DELIVERING` row |
| Delivery                   | `MechMarketplace.deliverToMarketplace` + `JinnRouter.claimDelivery`                                                                 | engine `deliver`                             | immutable                                   |
| Evaluation job             | separate restoration of `type='evaluation'` posted by original creator's mech loop, referencing `restorationRequestId`              | MechAdapter                                  | follows same state machine                  |
| Verdict manifest           | IPFS (`*.eval.manifest.v1`) delivered like a restoration                                                                            | evaluator impl                               | immutable                                   |
| Public artifacts           | ERC-8004 Identity Registry — `setMetadata(operatorAgentId, "<kind>:<cid>", payload)` per published artifact, where `payload` carries (tier, manifestHash, attestationQuoteCid, sourceMeasurement). One agent NFT per operator Safe; CIDs are metadata keys, not separate entities. See `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md`. | `IdentityRegistryClient` at delivery time    | append-only via `MetadataSet` events        |


### 2.3 Source of truth

- **For an intent's content**: the IPFS bytes keyed by `intentCid`
(`f01551220…`). The chain only stores the digest. Everything else is derived
or cached.
- **For progress**: the local SQLite `restoration_intents` row for the node
that's handling it. The chain holds the terminal record (delivery +
activity counters). No single globally-authoritative progress ledger exists
— if my node dies mid-flight and someone else claims, both may produce
manifests.
- **For "has this node already done this?"**: two independent caches —
CreatorLoop `config_values` on the creator side, `restoration_intents`
PK(request_id) on the restorer side.

### 2.4 Provenance fields

`RestorationRequest` adds `intentCid`, `onchainCreationTx`, `onchainCreationBlock`
at `MechAdapter.watchForRequests` time (decoded from `MarketplaceRequest` logs).
These flow to `engine.observe → persistence` and ultimately into every signed
manifest under `intent.{cid, onchainCreationTx, onchainCreationBlock, requestId}`
so evaluators can verify the restorer and evaluator acted against the same
bytes.

---

## 3. How restorer / implementation selection works today

### 3.1 Interface

`RestorerImpl` (`client/src/restorer/types.ts`):

```ts
interface RestorerImpl {
  name: string; version: string;
  supports({ kind, type }): boolean;
  canAttempt?(intent): Promise<{ok: true}|{ok: false, reason}>;
  run(ctx: RestorationContext): Promise<RestorationOutput>;
  isReady?(): Promise<ReadyStatus>;
  enableMetadata?(): IntentEnableMetadata;
  onEnable?(args): Promise<EnableResult>;
  onDisable?(): Promise<void>;
}
```

`RestorationContext` supplies: the `DesiredState`, `intentCid`, a per-intent
`workingDir`, a per-impl `implStateDir`, a structured `log` sink, and an
`AbortSignal` tied to `window.endTs`. Impls return a `RestorationOutput` —
snapshots, fills, `gating`/`informational` claims, artifact list, rationale.
Shape of `gating`/`informational` is *defined per spec.kind* (see the Zod
schemas in `types/`*), but the interface itself does not enforce it; the
schema check happens inside each impl or inside the matching evaluator.

### 3.2 Registration

There are two registry builds, **and they do not share a single source of truth**:

1. `client/src/main.ts` — the production daemon. Hard-codes the full list
  of impls inline, constructs each with live deps (agent EOA pk, safe
   address, rpc URLs, claudePath, etc.), registers them onto a
   `RestorerImplRegistry`, and hands that to `RestorationEngine`.
2. `client/src/cli/intent-registry-access.ts::buildIntentsCliRegistry` —
  used by `jinn intents list/status/enable/disable`. Registers the same
   impls with **stub credentials** (`evaluatorPk = 0x00…00`, zero-address
   safe) so they can answer `isReady()` and `onEnable()` without a live
   fleet.

The shared ground truth between the two is `DEFAULT_DISABLED_IMPLS` and
`DEFAULT_BY_KIND` in `cli/intent-registry-access.ts`. Impl construction and
registration order, however, is duplicated across both files.

### 3.3 Dispatch

`RestorerImplRegistry.findFor({ kind, type })`:

1. `config.byKind[kind]` — operator's explicit mapping wins (if the named impl
  exists, is enabled, and `supports(ctx)`).
2. `config.default` (defaults to `legacy-claude`) — fallback named impl.
3. First impl whose `supports()` returns true, excluding `config.disabled[]`.

Config is loaded from `~/.jinn-client/config.json` under `restorers.{byKind, default, disabled}`. `jinn intents enable|disable <kind>` mutates this file.

### 3.4 Invocation path

```
MechAdapter.watchForRequests()  (decodes MarketplaceRequest logs)
  → Daemon._runEngineWatcherLoop
    → engine.observe(persistedIntentInput)
      → SQLite row (state=DISCOVERED)
    → engine.process(requestId)   (later, via tick() or inline)
      → claim()     [two-layer: ClaimRegistry + Marketplace, gated by
                     impl.findFor + impl.isReady]
      → WAITING → PRE_SNAPSHOT → RUNNING
        → runImpl(): implRegistry.findFor().run(ctx)
      → POST_SNAPSHOT → PACKAGING
        → walkArtifacts → uploadArtifacts → assembleAndSignManifest → register8004
      → DELIVERING
        → mech.deliverToMarketplace → router.claimDelivery
      → COMPLETE
```

The engine has a **second, parallel legacy path** (`RestorerLoop` in
`daemon/restorer.ts`) that predates the state machine and runs any
`ExecutionAdapter.watchForRequests()` stream through `Runner.run()` directly.
`main.ts` unconditionally wires the engine path; the legacy loop still
exists as the fallback in `Daemon.start()` when `restorationEngine` is
not configured. Only test harnesses currently hit that branch.

---

## 4. The output contract a fulfiller sees (per intent class)

Worked example: `portfolio.v0` (most complete schema in the repo today).


| Layer                           | What the fulfiller must produce                                                                                                                                                                                                                                                                                    | Consumer                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `RestorerImpl.run` return value | `RestorationOutput` with a `gating` object shaped by `PortfolioV0Spec` (`equityReturnPct`, `maxDrawdownPct`, `closedTradesCount`, `tradedNotionalMultiple`), optional `informational`, `OutputArtifact[]` with `path` + `role`, optional `RationaleEntry[]`.                                                       | engine packaging step                                                          |
| Files written to `workingDir`   | whatever `OutputArtifact.path` points at; artifacts get SHA-256'd, uploaded to IPFS, and recorded in the manifest.                                                                                                                                                                                                 | packaging + ERC-8004 artifact registration                                     |
| Signed restoration manifest     | `portfolio.v0.manifest.v1` — `schemaVersion`, `generatedAt`, `intent` provenance, `restorer: {safeAddress, agentEoa}`, `window`, `preSnapshot`, `postSnapshot`, `fills[]`, `gating` (strict schema), `informational`, `artifacts[]`, `rationale?`, `signature: {algo, signer, hash, sig}` signed by the agent EOA. | evaluator impl; anyone downloading the CID; subgraph indexer                   |
| On-chain delivery               | `mech.deliverToMarketplace(requestId, manifestCid-digest)` followed by `JinnRouter.claimDelivery(requestId, manifestCid-digest, evidenceHash)` where `evidenceHash = keccak256(canonicalManifestBytes)`.                                                                                                           | `RestorationActivityChecker` (unlocks staking rewards); evaluator job creation |
| Evaluator pair                  | A matching `*.eval.manifest.v1` — re-derives `preSnapshot/postSnapshot/fills/gating`, diffs against claimed values, emits `verdict ∈ {PASS, FAIL, REJECTED, INDETERMINATE}` + `score` + per-check pass/fail list. Signed by evaluator EOA.                                                                         | router evidence + future challenge mech; knowledge layer                       |
| Minimum viable evidence         | restorer manifest + evidence hash on-chain. Evaluator manifest is required only for evaluation-type jobs; the restoration delivery itself is accepted optimistically today.                                                                                                                                        | —                                                                              |
| Nice-to-have                    | `rationale[]` entries, `informational.`* metrics, extra `artifacts[]` (logs / sessions) — all referenced by the manifest, discoverable via ERC-8004, optionally x402-gated.                                                                                                                                        | —                                                                              |


The pattern is identical for `prediction.v0` (`PredictionSubmissionManifest` +
`PredictionVerdictManifest`) and `prediction.apy.v0`. Each kind defines its
own `gating` shape and manifest `schemaVersion`; the engine itself is
kind-agnostic.

---

## 5. Extension guide (draft — describes current state, not target)

The existing surface works; it is also noisy and partly duplicated. This
section is normative for "how do I add a kind today" — the [Recommendations]
section proposes the cleanup.

### 5.1 Add a new intent kind (e.g. `lending.health.v0`)

1. Create the typed spec in `client/src/types/lending-health.ts`: Zod
  schemas for `LendingHealthV0Spec`, `LendingHealthV0Eligibility`, the full
   `LendingHealthV0Intent`, a restoration manifest schema (`…manifest.v1`),
   and a verdict manifest schema. Follow `types/prediction.ts` as a template.
2. Export the new symbols from `client/src/types/index.ts`.
3. If the intent needs sentinel resolution (`"current"`, `startTs:0`), add
  `client/src/intents/lending-health-v0-template.ts` mirroring
   `prediction-v0-template.ts` and wire it into
   `cli/commands/submit-intent.ts`'s `if (kind === …)` branch. **This branch
   is a cascading if/else today and will keep growing until a resolver
   registry lands (see [Gap: resolver dispatch]).**
4. Ship an example intent in `client/fixtures/lending-health-v0-intent.example.json`.
5. If operators should be able to auto-generate them, add
  `client/src/intents/lending-health-v0-auto.ts` with a `makeXGenerator`
   factory matching the `IntentGenerator` type.
6. In `client/src/main.ts`, push that generator onto the `intentGenerators`
  array under the matching network gate.

### 5.2 Add a new restorer impl (first-party, in-repo)

1. `mkdir client/src/restorer/impls/<your-impl>` and write `index.ts`
  exporting a class implementing `RestorerImpl`. Follow
   `prediction-v0-baseline/index.ts` for the minimal shape, or
   `claude-mcp-hyperliquid/index.ts` for a long-running Claude-driven impl.
2. Your `supports(ctx)` must narrow by `ctx.kind` and `ctx.type`.
3. Register it in **both** places:
  - `client/src/main.ts` — with live creds (agent pk, safe address, RPC).
  - `client/src/cli/intent-registry-access.ts::buildIntentsCliRegistry` —
  with stub creds (enough to answer `isReady`/`onEnable`).
4. If you want it default-on for a kind, add the kind → name mapping to
  `DEFAULT_BY_KIND` in `cli/intent-registry-access.ts`. If it needs
   opt-in (external deps), add the name to `DEFAULT_DISABLED_IMPLS`.
5. Write `isReady`, `enableMetadata`, `onEnable`, `onDisable` if the impl
  has external dependencies. The CLI surfaces these through
   `jinn intents list/status/enable/disable`.
6. Add an evaluator counterpart that returns `supports({type:'evaluation'})`
  — without one, deliveries can't be verified and the impl is useless for
   rewards.
7. Add vitest coverage under `client/test/impl-<name>.test.ts`.

### 5.3 Add a third-party / external impl

**There is no supported path for this today.** The interface is plain
TypeScript; any ESM module that exports a class implementing `RestorerImpl`
could in principle be loaded by dynamic import, but:

- `main.ts` hard-codes the registration list.
- `cli/intent-registry-access.ts` hard-codes the same list.
- Config has no `restorers.plugins[]` or similar surface.
- There is no packaging, signature, or sandbox story; any impl runs in the
daemon's process with full keystore / RPC / Safe access.

Concrete jinn-mono-7zz and jinn-mono-y6w are filed for this gap.

---

## 6. Gap list (ranked)


| #   | Severity | Gap                                                                                                                                                                                                                                                                      | Evidence                                                                                 | Existing issue                   |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | P1       | **No single impl registry.** Impl construction + registration is duplicated in `main.ts` and `buildIntentsCliRegistry`; `DEFAULT_BY_KIND` is the only shared truth. Drift is inevitable — e.g. stub credentials hide real readiness failures from the CLI.               | `main.ts` lines 316–385; `cli/intent-registry-access.ts` lines 54–95.                    | new                              |
| 2   | P1       | **No third-party plug-in story.** `RestorerImpl` is a clean interface but there is no registration surface (config, package manifest, dynamic import, MCP) and no trust boundary. Adding a restorer means editing the daemon.                                            | Extension guide §5.3.                                                                    | `jinn-mono-7zz`, `jinn-mono-y6w` |
| 3   | P1       | **Intent kind dispatch is a growing switch.** `submit-intent.ts`, creator-side sentinel resolution, typed-spec imports, and auto-generators are each cascading if-trees keyed on `spec.kind`. Adding a new kind means editing ≥4 files.                                  | `cli/commands/submit-intent.ts` lines 100–161; `main.ts` lines 436–454.                  | new                              |
| 4   | P2       | **Two parallel execution paths.** Legacy `RestorerLoop` (`daemon/restorer.ts`) still ships alongside `RestorationEngine`. Production always uses the engine; tests still hit the legacy path. Dead code risk + cognitive load.                                           | `daemon/daemon.ts` lines 182–199.                                                        | `jinn-mono-7ee`                  |
| 5   | P2       | **No intent schema version contract.** Each impl imports its own Zod schema directly; there's no `intent.schema`, no compatibility policy, no "which schemas are supported by this build." Old intents that a new build can't parse are silent failures.                 | `types/prediction.ts` etc. have no version discriminator beyond `kind: 'prediction.v0'`. | new                              |
| 6   | P2       | **Working dirs hardcoded to `/tmp`.** Both engine `paths.{workingDirRoot,implStateDirRoot}` and legacy `workingDirectory` default to `/tmp/…`. Crash-recovery depends on those dirs surviving a reboot; on many systems `/tmp` is tmpfs.                                 | `main.ts` lines 497–499; `daemon.ts` RestorerLoop default.                               | new                              |
| 7   | P2       | **Evaluator stubs in CLI registry.** `buildIntentsCliRegistry` registers evaluators with `evaluatorPk = 0x0…0` + zero-address safe. `isReady()` on an evaluator impl can return `true` even though the production path would fail.                                       | `cli/intent-registry-access.ts` lines 62–75.                                             | new                              |
| 8   | P3       | **Artifact discovery is fragmented.** Local SQLite (`own_activity`, `restoration_intents`), chain events, ERC-8004 registry, and optional subgraph each hold partial views. No single `jinn intents history` today aggregates them per-intent.                           | `api/gather-status.ts`, `store/store.ts`, `discovery/`*.                                 | new                              |
| 9   | P3       | `**legacy-claude` is a special case in the engine.** The engine's `runImpl` has a narrowly-scoped try/catch that silently turns claude-unavailable errors into `{skipped: true}` outputs only for `impl.name === 'legacy-claude'`. This couples engine to impl identity. | `restorer/engine/engine.ts` lines 530–556, 916–945.                                      | new                              |
| 10  | P3       | **Intent naming has drift risk.** `kind: portfolio.v0 / prediction.v0 / prediction.apy.v0` looks like semver but there's no policy for what ".v1" promises — breaking change? additive field? Without one, forks will diverge.                                           | `types/*.ts` schemas.                                                                    | new                              |


---

## 7. Recommendations

### 7.1 Short-term (fits current code; 1–2 issues each)

1. **Collapse the two registry builds.** Move impl construction to a single
  `client/src/restorer/impls/index.ts::buildRestorerImpls(env: RestorerEnv)`
   factory that takes everything needed (pk, safe, rpcs, claudePath, etc.).
   `main.ts` and `buildIntentsCliRegistry` both call it — the latter passes
   `RestorerEnv.stub = true` so impls can still answer enable/ready metadata
   without live creds, and evaluator readiness reports `reason: 'requires  live daemon'` honestly.
2. **Formalise a `SpecKind` manifest.** Add
  `client/src/intents/kinds/index.ts` exporting one entry per kind:
   `submit-intent` and auto-generators dispatch on this map instead of
   cascading ifs. Adding a kind becomes: add one entry + one module.
3. **Move working dirs under `~/.jinn-client/engine/`.** Configurable via
  `config.engine.{workingDirRoot,implStateDirRoot}`. Keeps crash-recovery
   durable across reboots on tmpfs hosts.
4. **Fold `legacy-claude`'s unavailability handling into its own `run`.**
  Engine should not name-check impls. Let the impl throw a `SkippableError`
   the engine knows how to treat as "skipped".
5. **Document the extension guide.** Promote §5 of this doc into
  `docs/runbooks/add-intent-kind.md` + `docs/runbooks/add-restorer-impl.md`
   and link from `CLAUDE.md`.
6. **Delete the legacy `RestorerLoop` path**, or at minimum quarantine it
  behind a `ENABLE_LEGACY_RESTORER_LOOP` env var and plan removal in the
   next release.

### 7.2 Longer-term (design work before code)

1. **Decision: how does a third party ship a RestorerImpl?** This is the
  pluggability question and owns issues `7zz` + `y6w`. Three candidates
   (details in §8):
  - **A. In-repo directory.** Stay as-is; open PRs.
  - **B. Config-declared dynamic import.** `restorers.plugins: [{ name, package, entry }]`; operator installs the npm package; daemon
  `import()`s at startup.
  - **C. Out-of-process MCP/HTTP impl.** Impl runs as its own MCP server
  (or signed HTTP endpoint); daemon calls it over IPC. Sandboxed for free.
   **Audit recommends B for v0 with an eye to C for v1.** B keeps the
   extension authentic TypeScript (IDE support, schema reuse), postpones
   sandboxing to when we have concrete threat models, and gives us a real
   distribution channel (npm, CID-pinned versions). C becomes the story
   once we need to run untrusted impls or multi-language impls.
2. **Intent & impl versioning policy.** Write a short spec (e.g.
  `spec/2026-05-schema-versioning.md`) defining:
  - `kind` follows `<domain>.<subkind>.v<major>`; `vN` is a breaking change;
  additive fields bump manifest `schemaVersion` minor.
  - Clients advertise `supportedKinds: ['prediction.v0>=1.0.0']` via
  `jinn version --json` (builds on `client-surface.md`).
  - Subgraph and evaluators use the advertised range to decide compat.
3. **Registry vs directory — decide explicitly.** Recommendation:
  stay **directory-of-first-party impls + config-declared plug-ins**;
   do *not* go on-chain for discovery in the Phase 1 horizon. On-chain
   discovery is a Phase 2+ concern tied to ERC-8004 node identity; record
   this decision in a spec so future drift is visible.
4. **Trust boundary.** Today every impl runs in the daemon with full
  keystore access. For (B) and especially (C), define:
  - what the daemon hands an impl (scoped signer? full pk? RPC session?);
  - what the impl must not be able to touch (master wallet; config file);
  - how we attest impl provenance (IPFS CID of the package, signed by a
  known key, verified at install time).

---

## 8. Explicit decisions to surface (not decided here)


| #   | Decision               | Options                                                                                                                            | Audit's lean                                                 |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | **Discovery of impls** | a. Directory scan only b. Manifest (`package.json` / `kinds/index.ts`) c. On-chain d. Remote registry                              | b. In-repo manifest now; (c)/(d) out of scope until Phase 2. |
| 2   | **Versioning**         | a. None (current) b. `schemaVersion` on every manifest/intent + semver policy c. Hash-pinned schemas                               | b, with an explicit policy document.                         |
| 3   | **Trust boundary**     | a. In-process, trusted (current) b. In-process, declared via config, signed package c. Out-of-process (MCP/HTTP) with scoped creds | b short-term; c for untrusted / multi-language impls later.  |


These three decisions should be named in the next planning cycle, even if
implementation lags, so the team can align on one extension model.

---

## 9. Success-criteria check

- "Where does my intent live?" — answerable from §2. Promote to runbook.
- "How do I add a restorer?" — answerable from §5. Promote to runbook;
acknowledge that the answer is still awkward (duplicate registries,
hard-coded list) and track cleanup as §7.1 (1).
- "What output contract does an intent impose?" — answerable from §4.
Generalise from the portfolio.v0 worked example into a short
"manifest anatomy" doc once schema versioning lands.
- Agreement on extension model for next milestone — surfaces
decisions §8.1–§8.3 to the team; audit's lean is B, but the call
is not made here.

---

## 10. Follow-up issues to file

Suggested bd issues (not yet created — confirm before filing):

1. `restorer: single source of truth for impl registry` (P1; §7.1.1; gap #1)
2. `intents: SpecKind manifest to collapse submit-intent / auto-gen switches` (P1; §7.1.2; gap #3)
3. `engine: move working dirs out of /tmp, honour config.engine.`* (P2; §7.1.3; gap #6)
4. `engine: remove legacy-claude name-check, use SkippableError` (P3; §7.1.4; gap #9)
5. `docs: extension runbooks (add-intent-kind, add-restorer-impl)` (P2; §7.1.5)
6. `daemon: remove legacy RestorerLoop path or gate behind flag` (P2; §7.1.6; gap #4 / links `7ee`)
7. `spec: intent + manifest schema versioning policy` (P2; §7.2.2; gap #5)
8. `engine: honest readiness for CLI-built registry (no stub creds)` (P2; §7.1.1; gap #7)
9. `intents: aggregated` jinn intents history  `across DB + chain + subgraph` (P3; gap #8)

Existing: `jinn-mono-7zz` + `jinn-mono-y6w` absorb the third-party plug-in
track (§7.2.1, gap #2). `jinn-mono-7ee` covers cleanup overlapping with §7.1.6.

**Naming (filed as a decision, not a work item):** `jinn-mono-juw` —
cross-layer naming alignment (client + contracts + spec) needs design
discussion with Oak before any implementation. Design doc:
`docs/proposals/2026-04-22-naming-alignment.md`. Blocks `jinn-mono-7zz`
because the plug-in surface publishes the external `Executor` vocabulary
we have to live with. Three paths on the table (rename all-at-once now
via contract proxy upgrade, defer to Phase 2 relaunch, or keep
"restoration" canonical) — see the design doc's cost comparison.

---

## 12. Close-out — `jinn-mono-7ee` (2026-04-22)

Engine + registry consolidation landed in the client workstream. The following
audit gaps are **addressed in code** (this section is a checklist, not a re-audit):

| Gap (§7) | Item | Outcome |
| --- | --- | --- |
| #1 | Duplicate impl construction (`main` vs `intents` CLI) | `buildRestorerImpls` in `client/src/restorer/impls/index.ts` is the single factory; both entrypoints use it. |
| #4 | Legacy `RestorerLoop` in daemon | Removed from `daemon.ts`; e2e Phases 5–8 and cross-operator use `E2eRestorerLoop` in `client/scripts/e2e-legacy-restorer.ts` only (adapter + runner; engine path remains Phase 11 + production daemon). |
| #6 | Engine working dirs under `/tmp` | `config.engine.workingDirRoot` / `implStateDirRoot` (defaults `~/.jinn-client/engine/…`); env `JINN_ENGINE_*`; docs in `CLAUDE.md` / `AGENTS.md`. |
| #7 | Stub readiness lying (`0x` keys) | Stub registry uses `REQUIRES_LIVE_DAEMON_READINESS` / honest `isReady()`; `jinn intents list` test asserts `requires live daemon`. |
| #9 | `legacy-claude` name check in engine | `SkippableError` from `legacy-claude.run`; engine catches by type, not `impl.name`. |

*Note:* §2.2 table rows for working dir still describe pre-7ee `/tmp` layout in the
archival audit; operators should read `config.engine` and the implementation in
`main.ts` / `RestorationEngine` for current paths.