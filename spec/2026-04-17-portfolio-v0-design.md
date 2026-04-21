# portfolio.v0 — design spec

**Version:** 1
**Date:** 2026-04-17
**Author:** ritsukai
**Status:** locked design; pre-implementation
**Related:** `docs/planning/2026-04-jinn-e2e-portfolio-map.md` (historical mapping pass)

## 1. Summary

`portfolio.v0` is the first non-trivial Jinn intent kind. It asks restorers to grow a Hyperliquid (HL) account over a 24-hour window subject to a drawdown bound and minimum-trading-activity eligibility, then has an independent evaluator deterministically verify the outcome by re-querying public HL state.

The work introduces three generic Jinn primitives alongside the kind-specific portfolio.v0 logic:

- A typed-spec extension to `DesiredState` (`spec.kind` + `eligibility` + generic `window`)
- A pluggable restorer-engine architecture: an agnostic engine that runs swappable per-kind restorer impls
- A deterministic evaluator framework with a verdict taxonomy, score field, and tolerance rules

These primitives are built FOR portfolio.v0 but are designed to host future intent kinds (`codegen.v0`, `lp.v0`, etc.) without further changes to the engine.

The narrative differentiation against existing AI-trading benchmarks (Virtuals Degen Claw, Nof1 Alpha Arena): **same competition substrate, but with a deterministic verifier and the generated trading systems themselves as monetizable knowledge artifacts.**

## 2. Architecture overview

```
┌──────────────────────────────────────────────────────────────────┐
│ Operator                                                          │
│   intent JSON → posted via JinnRouter.createRestorationJob       │
└──────┬───────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│ Restorer engine (daemon-provided, kind-agnostic)                  │
│  - watches RestorationJobCreated events                           │
│  - dispatches by spec.kind to a registered impl                   │
│  - owns: ClaimRegistry, marketplace claim, workingDir, timing,    │
│          AbortSignal at endTs, packaging, IPFS upload, signing,   │
│          mech delivery, crash recovery                            │
└──────┬─────────────────────────────────────────┬─────────────────┘
       │                                          │
       ▼                                          ▼
┌─────────────────────┐                 ┌─────────────────────────┐
│ Restorer impl       │                 │ Evaluator impl          │
│ (per spec.kind)     │                 │ (per spec.kind)         │
│                     │                 │                         │
│ portfolio.v0:       │                 │ portfolio.v0.eval:      │
│  claude-mcp +       │                 │  re-fetches HL state,   │
│  HL trading tools   │                 │  recomputes metrics,    │
│                     │                 │  emits structured       │
│ Owns venue creds,   │                 │  verdict + checks +     │
│ trading code,       │                 │  score                  │
│ session lifecycle   │                 │                         │
└─────────────────────┘                 └─────────────────────────┘
```

The engine is venue-agnostic and intent-agnostic. Adding a new venue or intent kind = shipping new impls. The engine doesn't change.

## 3. DesiredState (generic intent shape)

Located at `client/src/types/desired-state.ts`. This is the canonical IPFS payload for any Jinn intent.

```ts
{
  id:          string,
  description: string,                                // human prose

  window?: {                                           // generic lifecycle
    startTs: number,                                   // ms epoch; ≥ block.timestamp(creationTx)
    endTs:   number,                                   // ms epoch; > startTs
  },

  spec?: {                                             // typed intent specification
    kind: string,                                      // dispatcher, e.g. "portfolio.v0"
    // ...kind-specific fields
  },

  eligibility?: Record<string, unknown>,               // pre-claim and post-hoc qualifying rules;
                                                       // shape governed by spec.kind by convention
}
```

### Backwards compatibility

All four new fields (`window`, `spec`, `eligibility`) are optional. Existing intents like the default health-check (`{ id, description }`) parse and execute as before. An impl that doesn't recognize `spec.kind` (or sees no `spec`) falls through to the legacy generic Claude restorer.

### Dispatch

`spec.kind` is the single dispatch key for both restorer and evaluator impl selection. The engine queries its `RestorerImplRegistry` for any impl whose `supports({ kind })` returns true; first match wins (operator config can override).

## 4. portfolio.v0 specifics

### 4.1 Concrete intent shape

```ts
{
  id:          "...",
  description: "Increase HL portfolio over 24h with bounded drawdown.",

  window: {
    startTs: number,                                   // ≥ block.timestamp(creationTx)
    endTs:   number,                                   // v0: must equal startTs + 86_400_000 (24h)
  },

  spec: {
    kind:    "portfolio.v0",
    account: {
      venue:         "hyperliquid-testnet" | "hyperliquid-mainnet",
      masterAddress: `0x${string}`,                    // HL master account being traded
    },
    target: {
      metric:        "equity_return_pct",
      minReturnPct:  number,                           // e.g. 5.0
    },
    constraint: {
      maxDrawdownPct: number,                          // e.g. 10.0 — peak-to-trough over window
    },
  },

  eligibility: {
    minClosedTrades:           20,                     // default 20
    minTradedNotionalMultiple: 5.0,                    // default 5.0× starting equity
    // future: allowedRestorers?: string[]
  },
}
```

### 4.2 Window semantics

- `startTs` is operator-declared (allows scheduling), constrained on chain by `startTs ≥ block.timestamp(creationTx)`.
- `endTs - startTs` must equal exactly 24h in v0. Future revisions may relax.
- Operator may post intent before `startTs` (pre-scheduled); restorer claims, waits until `startTs`, takes pre-snapshot, runs sessions, takes post-snapshot at `endTs`, delivers manifest after.

### 4.3 Subject = HL account

`spec.subject.account.masterAddress` is the public HL address all evaluation queries are keyed off. This address is exposed in the intent (public). The HL "API wallet" (separate keypair authorized to trade on the master's behalf) is provisioned and held by the restorer impl, not in the intent.

### 4.4 Eligibility fields

For portfolio.v0:
- **Post-hoc qualification** (evaluated by the evaluator from the manifest):
  - `minClosedTrades` — number of fills with `closedPnl != "0.0"`
  - `minTradedNotionalMultiple` — `sum(|sz_i * px_i|) / preEquity ≥ this value`
- **Pre-claim** (none in v0; future: allowlists, required stake)

Defaults are 20 closed trades and 5.0× notional turnover. Operator-overridable.

## 5. Evidence manifests

Two schemas: the restoration manifest (produced by the restorer impl, signed by the restorer's agent EOA) and the evaluation verdict manifest (produced by the evaluator impl, signed by the evaluator's agent EOA).

### 5.1 Restoration manifest — `portfolio.v0.manifest.v1`

```ts
{
  schemaVersion: "portfolio.v0.manifest.v1",
  generatedAt:   number,                                  // ms epoch

  intent: {
    cid:                 string,                          // IPFS CID of the DesiredState
    onchainCreationTx:   `0x${string}`,
    onchainCreationBlock: number,
    requestId:           `0x${string}`,                   // mech requestId
  },
  restorer: {
    safeAddress: `0x${string}`,
    agentEoa:    `0x${string}`,
  },
  window: { startTs: number, endTs: number },             // echoed for self-containment

  // Verbatim HL clearinghouseState payloads
  preSnapshot:  { capturedAt: number, hlTime: number, payload: <raw HL response> },
  postSnapshot: { capturedAt: number, hlTime: number, payload: <raw HL response> },

  // Verbatim HL userFills filtered to [startTs, endTs]
  fills: Array<HLFill>,

  // Restorer's claimed metrics — evaluator independently re-derives + compares
  gating: {
    equityReturnPct:           string,                    // computed per canonical spec (§7.5)
    maxDrawdownPct:            string,
    closedTradesCount:         number,
    tradedNotionalMultiple:    string,
  },
  informational?: {
    sharpe?: string, sortino?: string, calmar?: string,
    profitFactor?: string, expectancy?: string, winRate?: string,
    holdTimeMs?: { mean, median, p95 },
    leverageHistogram?: Record<string, number>,
    longShortMix?: { longCount, shortCount },
  },

  // Sub-artifacts (each lives at its own IPFS CID)
  artifacts: Array<{
    cid:       string,
    role:      string,                                    // open string; conventions §5.3
    sha256?:   string,
    metadata?: Record<string, unknown>,
    tags?:     string[],
    access?:   { kind: "open"|"x402-gated", endpoint?: string, priceUsdc?: string },
  }>,

  rationale?: Array<{ ts, sessionId, note, relatedFillTids? }>,

  signature: {
    algo:   "secp256k1",
    signer: `0x${string}`,                                // == restorer.agentEoa
    hash:   `0x${string}`,                                // keccak256 of canonical JSON minus `signature`
    sig:    `0x${string}`,
  },
}
```

### 5.2 Verdict manifest — `portfolio.v0.eval.manifest.v1`

```ts
{
  schemaVersion: "portfolio.v0.eval.manifest.v1",

  // ── Signed content (covered by the canonical-bytes hash) ──────────────────
  intent:    { /* eval intent provenance, see §6.4 */ },
  evaluator: { safeAddress: `0x${string}`, agentEoa: `0x${string}` },
  window:    { startTs, endTs },                          // eval window (1h v0; see §7.6)

  verdict:      "PASS" | "FAIL" | "REJECTED" | "INDETERMINATE",
  score:        string,                                   // fixed-point 1e18 scale; 0 if not PASS
  scoreBasis:   string,                                   // e.g. "calmar.v1"
  scoreVersion: string,

  rederived: {                                            // evaluator's independent fetch+recompute
    preSnapshot:  { capturedAt, payload },
    postSnapshot: { capturedAt, payload },
    fills:        Array<HLFill>,
    gating:       Record<string, unknown>,
  },
  claimed: {                                              // mirror of restorer's claims for diff
    preSnapshot, postSnapshot, fillsHash, fillsCount, gating,
  },

  checks: Array<{
    name:    string,                                      // dotted code, see §7.4
    status:  "PASS" | "FAIL" | "SKIP",
    detail?: string | Record<string, unknown>,
  }>,

  // ── Unsigned metadata (NOT covered by the canonical-bytes hash) ───────────
  // generatedAt is wall-clock time and intentionally excluded from the signed
  // envelope so that two evaluations of identical inputs always produce the
  // same hash, enabling challenge verification.
  generatedAt: number,                                    // ms epoch; set after signing

  signature: { algo: "secp256k1", signer, hash, sig },
}
```

**Canonical bytes:** the `signature` object and the `generatedAt` field are both excluded from the signed content. The hash covers the canonical JSON (sorted keys, no whitespace) of the remaining fields only.

### 5.3 Artifact role conventions

The `artifacts[]` array is uniform across all manifests. Roles are open strings; conventions for `portfolio.v0`:

| `role`                | Required? | `metadata` shape |
|-----------------------|-----------|------------------|
| `session_transcript`  | ≥1        | `{ sessionId, startedAt, endedAt, modelId, initiatedFillTids: number[] }` |
| `tool_call_log`       | optional  | `{ sessionId }` |
| `execution_log`       | optional  | `{ format: "jsonl" }` |
| `system_snapshot`     | optional  | `{ description?: string }` (full workingDir tarball) |
| `generated_file`      | optional  | `{ name, sha256 }` |
| `context_snapshot`    | optional  | `{ ts, kind, source? }` |

Future role to anticipate (not v0): `strategy_recipe` — distilled, reusable strategy artifact for monetization.

### 5.4 Inlined vs CID'd

- **Inlined** (small, verdict-bearing): pre/post snapshots, fills, gating, intent provenance, signature.
- **CID'd via `artifacts[]`** (potentially large, optional for verdict): transcripts, logs, generated files.

Inlined data is required because HL `userFills` retention can't be assumed indefinite (it is ≥10k, sufficient for 25h-old verification per current findings, but the manifest survives beyond that).

### 5.5 Signing

The manifest's canonical JSON (sorted keys, no whitespace, signature field excluded) is keccak256-hashed and signed by the restorer's agent EOA via secp256k1. Signature verifies the manifest came from the same key that submitted the on-chain mech delivery.

## 6. Restorer engine

Located at (planned) `client/src/restorer/engine/`. Generic, kind-agnostic, daemon-provided.

### 6.1 Responsibilities (engine-side)

- Observe `RestorationJobCreated` events on chain
- Dispatch by `spec.kind` to a registered impl that `supports()` it
- Claim the request via:
  - `MechMarketplace` (priority-mech selection within 5-min `responseTimeout`)
  - `ClaimRegistry.claimJob` with `claimTTL = window.endTs - now + grace` (work coordination layer; our contract, our TTL)
- Provision `workingDir` (per-intent, ephemeral) and `implStateDir` (per-impl, persistent)
- Wait until `window.startTs` if in future
- Spawn impl with `RestorationContext`
- Fire `AbortSignal` at `window.endTs`
- Receive `RestorationOutput` from impl
- Walk `workingDir` for declared artifacts; upload each to IPFS; register each with parent-manifest back-pointer via `Daemon.registerArtifact`
- Assemble manifest = impl-claimed fields + engine-controlled provenance fields
- Sign manifest with agent EOA; upload to IPFS
- Submit manifest CID via `mech.deliverToMarketplace`
- Persist state at every transition; resume from last state on daemon restart

### 6.2 What the engine does NOT do (impl-side)

- Take venue snapshots (impl owns)
- Pull venue fills (impl owns)
- Compute gating or informational metrics (impl owns)
- Hold venue credentials (impl owns; engine never sees them)
- Make any venue-specific decisions

The engine validates the impl's `RestorationOutput` for **structural** correctness only (required fields present, no path escape in `artifacts[].path`). It does not validate values — that's the evaluator's job downstream.

### 6.3 State machine

```
DISCOVERED → CLAIMED → WAITING → PRE_SNAPSHOT → RUNNING → POST_SNAPSHOT
                                                                  │
                                                                  ▼
                                                            PACKAGING → DELIVERING → COMPLETE

(any state) → FAILED  (terminal; persists failureReason)
```

Each transition obeys two principles:

- **Persist-before-invoke** — record the intended next state before initiating any external side-effect (RPC, IPFS, fs)
- **Idempotent-on-resume** — re-running a transition produces identical results (artifact uploads are sha256-keyed so re-uploads yield same CID; chain queries verify "already claimed/already delivered" before re-attempting)

### 6.4 Persistence schema

SQLite, in the existing `client/src/store/store.ts`:

```sql
CREATE TABLE restoration_intents (
  request_id              TEXT PRIMARY KEY,
  intent_cid              TEXT NOT NULL,
  onchain_creation_tx     TEXT NOT NULL,
  onchain_creation_block  INTEGER NOT NULL,
  spec_kind               TEXT,
  impl_name               TEXT,

  state                   TEXT NOT NULL,
  state_updated_at        INTEGER NOT NULL,

  working_dir             TEXT,
  impl_state_dir          TEXT,

  window_start_ts         INTEGER NOT NULL,
  window_end_ts           INTEGER NOT NULL,

  pre_snapshot_captured_at  INTEGER,
  pre_snapshot_payload      TEXT,                         -- JSON
  post_snapshot_captured_at INTEGER,
  post_snapshot_payload     TEXT,
  fills_payload             TEXT,                         -- JSON
  gating_claim              TEXT,
  informational_claim       TEXT,

  artifact_cids           TEXT,                           -- JSON: { path: cid }
  manifest_cid            TEXT,
  delivery_tx_hash        TEXT,

  failure_reason          TEXT,
  failure_at              INTEGER
);

CREATE INDEX idx_state            ON restoration_intents(state);
CREATE INDEX idx_window_start_ts  ON restoration_intents(window_start_ts);
```

### 6.5 Crash recovery

On daemon startup, scan rows where `state NOT IN ('COMPLETE', 'FAILED')`. Per row, dispatch by current state to a resume handler that reasons about what's been persisted and either re-attempts the transition or advances. Detail in §6.3 spec.

WorkingDir + implStateDir must survive daemon restarts — therefore live in a persistent location, not `/tmp`. Suggested: `<earningDir>/restorations/<requestId>/` and `<earningDir>/impls/<implName>/`.

### 6.6 Workdir layout (engine-managed minimum)

```
<workingDir>/
  intent.json          ← engine writes; impl reads
  env/                  ← engine writes; impl reads (mode 0600)
  OUTPUTS.json         ← optional; impl writes to declare artifacts + access
  sessions/             ← convention; impl writes session logs here
  ...                   ← impl writes whatever else
```

Impl has full write access to `workingDir`. Engine has no opinion about non-standardized paths.

### 6.7 Restorer-impl interface

```ts
interface RestorerImpl {
  name:    string;                                        // "claude-mcp-hyperliquid"
  version: string;                                        // semver
  supports(spec: { kind: string }): boolean;
  canAttempt?(intent: DesiredState): Promise<{ ok: true } | { ok: false, reason: string }>;
  run(ctx: RestorationContext): Promise<RestorationOutput>;
}

interface RestorationContext {
  intent:       DesiredState;
  implStateDir: string;                                   // persistent
  workingDir:   string;                                   // ephemeral
  log:          (event: { level, msg, data? }) => void;
  abort:        AbortSignal;                              // fires at window.endTs
  msUntilEndTs: () => number;
}

interface RestorationOutput {
  venueRef: { name: string };

  // Optional for impls that don't operate on a venue (e.g. evaluator impls)
  preSnapshot?:  { capturedAt: number, payload: unknown };
  postSnapshot?: { capturedAt: number, payload: unknown };
  fills?:        unknown[];

  gating:        Record<string, unknown>;                 // shape per spec.kind
  informational?: Record<string, unknown>;

  artifacts?: Array<{ path, role, metadata?, tags?, access? }>;
  rationale?: Array<{ ts, sessionId, note, relatedFillTids? }>;
}
```

Impl registration is done by the engine's `RestorerImplRegistry` at startup. v0 ships `claude-mcp-hyperliquid` and `portfolio-v0-evaluator` registered by default; operator config can disable or add.

## 7. portfolio-v0-evaluator impl

Pure code, deterministic, no LLM. Implements both restoration verification (PASS/FAIL/REJECTED) and verdict signing.

### 7.1 Algorithm

Given an evaluation intent referencing a target manifest CID and target intent CID:

```
1. Fetch original intent + manifest from IPFS
2. Fetch on-chain creation tx → get block.timestamp
3. Verify manifest signature signs back to manifest.restorer.agentEoa
4. Re-fetch HL state for verification:
     - portfolio (for historical equity grid; see §7.7)
     - userFills filtered to [startTs, endTs] via userFillsByTime
5. Run all engine-enforced integrity checks (§7.4 integrity.*)
6. Run availability checks; SKIP downstream checks if availability fails
7. Run eligibility checks
8. Run consistency checks (claimed vs rederived, with tolerances per §7.5)
9. Run spec checks
10. Derive verdict from check statuses (§7.3)
11. Compute score per scoreBasis (§7.7)
12. Assemble verdict manifest, sign, return RestorationOutput
```

### 7.2 Engine-enforced integrity checks (cross-kind)

The engine prepends three checks to every evaluator impl's check list:

- `integrity.signature` — manifest sig valid for `manifest.restorer.agentEoa`
- `integrity.intent_ref` — `manifest.intent.cid` matches the eval intent's `targetIntentCid`
- `integrity.onchain_anchor` — `intent.window.startTs ≥ block.timestamp(creationTx)`

Impls cannot skip these.

### 7.3 Verdict derivation rule (deterministic)

```
if any check with name "availability.*" has FAIL    → INDETERMINATE
else if any "eligibility.*"          has FAIL       → REJECTED
else if any "integrity.*"|"consistency.*"|"spec.*"  has FAIL → FAIL
else                                                → PASS
```

`SKIP` does not contribute to verdict transitions. Order matters: data-availability problems precede attempt-quality problems.

### 7.4 portfolio.v0 check list

Engine-prepended:
```
integrity.signature
integrity.intent_ref
integrity.onchain_anchor
```

Impl-declared:
```
availability.hyperliquid_reachable
availability.hl_pre_snapshot_rederivable           (portfolio grid covers startTs)
availability.hl_fills_rederivable                   (no silent-clamp at retention horizon)

eligibility.min_closed_trades
eligibility.min_traded_notional

integrity.window_bounds                             (pre.capturedAt ≥ startTs, post.capturedAt ≥ endTs)

consistency.pre_snapshot
consistency.post_snapshot
consistency.fills                                   (set match by tid; per-fill fields exact)
consistency.gating.equity_return
consistency.gating.max_drawdown
consistency.gating.closed_trades
consistency.gating.traded_notional

spec.equity_return_target
spec.max_drawdown_constraint
```

### 7.5 Tolerance rules (portfolio.v0)

Tolerances cover input-data drift only (string-serialization rounding, query-time edge cases, back-derivation arithmetic). Computation methodology is canonicalized so derivations match bit-for-bit on identical input.

| Comparison | Tolerance |
|---|---|
| Snapshot decimal fields (`accountValue`, `withdrawable`, etc.) | 0.01% relative OR 0.0001 USD absolute, whichever greater |
| Per-fill HL fields (`px`, `sz`, `time`, `fee`, `closedPnl`, etc.) | **Exact** — HL is authoritative |
| Fills set membership (matched by `tid`) | **Exact** |
| `equityReturnPct`, `maxDrawdownPct` | 0.05% absolute (input tolerance propagates) |
| `closedTradesCount` | **Exact** |
| `tradedNotionalMultiple` | 0.05% relative |
| Window/timestamp bounds | **Exact** (integrity, no fuzzy match) |

#### Funding-accrual edge case

Between `endTs` and the post-snapshot capture (which is "as soon after as possible"), funding fees accrue. If `postSnapshot.capturedAt > endTs + 60s`, mark `availability.post_snapshot_rederivable` as SKIP and emit `INDETERMINATE`. Restorer should ensure post-snapshot capture within 60s of endTs.

#### Tolerance ownership

Tolerances are baked into the evaluator impl per `spec.kind` and are not operator-configurable — operators choose which evaluator impl runs, but not how lax it is.

### 7.6 Canonical computation spec for portfolio.v0 metrics

Both restorer and evaluator MUST follow this spec. Disagreements caused by methodology drift are not tolerable; tolerances cover only input drift.

```
Equity at time T:      unified accountValue =
                         marginSummary.accountValue  from clearinghouseState(T)
                       + USDC total                  from spotClearinghouseState(T)
                       (matches HL portfolio endpoint accountValueHistory, which
                        reports the same unified figure; includes unrealized
                        perps PnL and pending funding)
Equity curve:          sampled at preSnapshot.capturedAt
                                + every fill.time
                                + postSnapshot.capturedAt
Drawdown at point P:   100 * (peak_so_far - equity_P) / peak_so_far,
                       where peak_so_far is max equity over the curve up to and including P
maxDrawdownPct:        max over all P
equityReturnPct:       100 * (postSnapshot.accountValue - preSnapshot.accountValue)
                       / preSnapshot.accountValue
closedTradesCount:     count of fills where closedPnl != "0.0"
tradedNotionalMultiple: sum_i(|sz_i * px_i|) / preSnapshot.accountValue
```

**Snapshot payload shape.** Restorer writes `preSnapshot.payload` /
`postSnapshot.payload` as:

```
{
  accountValue:           string,                  // unified (canonical)
  perpsAccountValue:      string,                  // clearinghouseState.marginSummary.accountValue
  spotUsdc:               string,                  // spotClearinghouseState USDC total (0 if absent)
  clearinghouseState:     HlClearinghouseState,    // raw perps payload, verbatim
  spotClearinghouseState: HlSpotClearinghouseState // raw spot payload, verbatim
}
```

Evaluator consistency extraction reads the top-level `accountValue`
(falling back to the legacy `{marginSummary:{accountValue}}` shape for the
grid-rederived pre-snapshot, which HL's `portfolio` endpoint already reports
as unified).

### 7.7 Pre-snapshot historical verification

HL's `clearinghouseState` / `spotClearinghouseState` return CURRENT state only. The evaluator cannot directly re-fetch the pre-snapshot at `window.startTs`.

**Path used:** HL `portfolio` info endpoint, which returns `accountValueHistory` on a rolling **~140-minute grid** (day bucket has ~13 points over ~25.6h, gaps 120-140 min). Crucially, HL reports unified (perps + spot) equity here, matching §7.6's canonical equity definition.

**Restorer behavior:** restorer's pre-snapshot capture should be aligned to the next portfolio grid point at or after `window.startTs`. This adds up to 140 minutes of "pre-window setup" time but enables exact verification.

**Evaluator check:**
- `availability.hl_pre_snapshot_rederivable` — query `portfolio` for `masterAddress`, find a grid point at `pre.capturedAt`. SKIP downstream consistency checks if no matching grid point exists.
- `consistency.pre_snapshot` — claimed `accountValue` matches grid-point value within tolerance.

### 7.8 Score function for portfolio.v0

Default `scoreBasis: "calmar.v1"`:

```
score_calmar_v1 =
  if verdict != PASS:  0
  else:
    ratio = clamp(equityReturnPct / max(maxDrawdownPct, 1.0%), 0, 10.0)
    encoded = ratio * 1e17                                   // → range [0, 1e18]
    encoded as decimal string
```

The 1.0% drawdown floor mirrors Trality's 4% floor (smaller because our windows are shorter) — prevents tiny-drawdown score inflation. Cap at 10.0× for "perfect" to keep the value range bounded.

`score` is advisory in v0 (no on-chain consequence). Carrying it now makes the data available for off-chain consumers (leaderboards, x402 pricing tiers, future Phase 1b weighted rewards).

### 7.9 Eval intent shape

Generated automatically by the existing `DeliveryWatcherLoop` after each restoration delivery (calls `JinnRouter.createEvaluationJob`). Operator does not write these by hand.

```ts
{
  id, description: "Verify portfolio.v0 manifest <cid>.",
  window: { startTs, endTs },                                 // 1h fixed in v0
  spec: {
    kind:                "portfolio.v0.eval",
    targetManifestCid:   "Qm...",
    targetIntentCid:     "Qm...",
    targetCreationTx:    "0x...",
    targetRequestId:     "0x...",
  },
}
```

The 1-hour eval window is an upper bound — eval impls finish in seconds-to-minutes. The window absorbs transient HL/RPC outages and bounds mech marketplace request lifetime.

## 8. Reference impl: claude-mcp-hyperliquid

This is the `RestorerImpl` we ship with v0. It is deliberately minimal and deliberately not privileged — it is expected to be outclassed by operator-written impls.

### 8.1 Architecture

- Spawns Claude Code session(s) with HL-specific MCP tools available
- Manages an HL API wallet (separate keypair, derived from operator-managed mnemonic; persisted in `implStateDir`)
- On first run for a given fleet, executes HL "approve agent" flow to authorize the API wallet on the master account (one-time per fleet)
- Briefs each Claude session with intent details, current state, time remaining, available tools
- Captures session transcripts to `workingDir/sessions/<sessionId>/`
- Records initiated fills per session (matches HL fill `tid` to the session that placed the order)
- At end-of-window: takes post-snapshot, computes gating + informational metrics, returns `RestorationOutput`

### 8.2 MCP tool surface

Read-only tools (no auth needed, public HL data):
```
hl_clearinghouse_state(address?)
hl_user_fills(address?, startTime?, endTime?, limit?)
hl_meta()
hl_all_mids()
hl_portfolio(address?)                                 // for self-introspection
```

Write tools (require API wallet; safety rails per §8.3):
```
hl_open_position({ coin, side, size, leverage, tp?, sl?, slippageBps })
hl_close_position({ coin, sizeOrAll })
hl_modify_position({ coin, leverage?, tp?, sl? })
hl_cancel_orders({ coin? })
```

### 8.3 Safety rails

Tool-boundary enforcement (Claude can't bypass these):

- `hl_open_position`:
  - `notional_usd ≤ 0.25 * accountValue` (configurable per intent via context override)
  - `leverage ≤ 10` (configurable)
  - `slippageBps ≤ 50`
- All write tools: rate-limit ≤ 60 ops/minute per intent
- Total trade count: ≤ 1000 per window (sanity cap, not eligibility check)
- Failed tool calls return structured errors that Claude can read and adapt to

### 8.4 Session orchestration

For v0 simplicity:
- Sequential, not parallel — single Claude session at a time
- Cadence: one session every 30 minutes of remaining window time, OR triggered by significant market moves (≥2% mid-price change on tracked coins)
- Each session has 5-10 minutes of wall time; can be interrupted by AbortSignal at endTs
- Session prompt template: brief on intent target/constraint/eligibility, brief on tools, brief on time remaining, brief on current positions and recent fills, ask for next action(s) with rationale

### 8.5 Out of scope for v0

- Multi-agent orchestration (architect → builder → operator) — restorer is a single Claude per session for v0; multi-agent is a future impl variant
- Strategy persistence across intents — `implStateDir` only used for credentials and HL approve-agent state; cross-intent learning is downstream work
- Generated code as primary artifact — sessions produce transcripts; future impls (e.g. `claude-code-builder`) can shift to code-as-artifact

## 9. On-chain integration

### 9.1 Existing contracts used (no changes)

| Contract | Purpose | Used by |
|---|---|---|
| `JinnRouter` (`contracts/src/staking/JinnRouterV2.sol`) | Loop enforcement; activity counters; evidence forwarding | Engine creates restoration + eval jobs; engine claims delivery |
| `ClaimRegistry` (`contracts/src/claiming/ClaimRegistry.sol`) | Per-request work coordination | Engine calls `claimJob` with `claimTTL = endTs - now + grace` |
| `MechMarketplace` (`contracts/src/vendor/mech/MechMarketplace.sol`) | Marketplace request lifecycle + delivery | Engine creates request via `JinnRouter.createRestorationJob`, delivers via `mech.deliverToMarketplace` |
| `RestorationActivityCheckerV2` | Anti-farming via SimHash novelty; staking integration | Engine passes `evidenceHash = manifestCid` (or derived) on `claimDelivery` |

### 9.2 Configured values

- `JinnRouter.createRestorationJob(..., responseTimeout = 300, ...)` — max allowed by marketplace; "priority-mech exclusivity window," not hard expiry. After 300s the request remains deliverable by the priority mech (us) with no karma penalty.
- `ClaimRegistry.claimTTL` (per registry deployment, owner-configurable by us) — set to `24h + 1h grace = 25h` for portfolio.v0. Other intent kinds may use different registries.
- Eval job: `responseTimeout = 300` (same), `claimTTL` = `1h + grace = 90 min`.

### 9.3 What's NOT enforced on-chain in v0 (deliberately)

- **Verdict consequences.** PASS/FAIL/REJECTED is advisory. No reward gating. (Tracked: jinn-mono-24n)
- **Pre-claim eligibility.** `AcceptAllChecker` is the active `IEligibilityChecker`. Anyone can claim. (Tracked: jinn-mono-68w)
- **Multi-evaluator consensus.** Each evaluation delivery registers independently. (Tracked: jinn-mono-7fa)
- **Multi-restorer competition.** First-claim-wins. Single restorer per request in practice. (Tracked: jinn-mono-vwk)

These are Phase 1b protocol-design tracks. v0 ships forward-compatibly with all of them.

## 10. Implementation sequencing

High-level vertical slices, in order:

1. **Schema + types module.** `client/src/types/desired-state.ts` extension, manifest schemas, evaluator output types. Pure types, no runtime. Enables TypeScript checking across subsequent slices.

2. **HL venue helpers.** `client/src/venues/hyperliquid/` — read-only API client (`clearinghouseState`, `userFills`, `userFillsByTime`, `portfolio`, `meta`, `allMids`), `@nktkas/hyperliquid` SDK wrapper, types. Used by both restorer impl (writes) and evaluator impl (reads). Engine never touches.

3. **Restorer engine + RestorerImpl interface.** `client/src/restorer/engine/` — state machine, persistence schema (extend SQLite migrations), recovery, dispatch, ClaimRegistry integration, packaging, signing, delivery. Pluggable impl registry. No impls registered yet.

4. **claude-mcp-hyperliquid impl.** Module under `client/src/restorer/impls/claude-mcp-hyperliquid/` implementing `RestorerImpl`. Includes MCP tool definitions (`hl_*`), session orchestration, API wallet provisioning, transcript capture. Registered into the engine.

5. **portfolio-v0-evaluator impl.** Module under `client/src/restorer/impls/portfolio-v0-evaluator/`. Pure deterministic verifier. Registered into the engine.

6. **Daemon wiring.** Replace existing `RestorerLoop` (`client/src/daemon/restorer.ts`) with the new engine. Existing health-check intent remains supported (no `spec` → fallback to legacy generic Claude restorer, preserved alongside the new engine for backwards compat).

7. **End-to-end test.** Extend `client/scripts/e2e-validate.ts` with a portfolio.v0 scenario on Anvil-forked Base Sepolia. Single fleet posts an intent, claims, runs the impl with mocked Claude (or short cadence + small windows), produces manifest, eval impl verifies, verdict delivered.

8. **Operator UX.** Surface portfolio.v0 intents in dashboard / `/v1/status`; document config; `jinn doctor` checks for HL API wallet, faucet status, etc.

Each step is independently testable. Steps 1-2 unblock 3-5. Steps 3-5 unblock 6-8.

## 11. Open Phase 1b protocol design (parallel to v0)

Filed as beads issues. None block v0. All have v0-forward-compatible mitigations baked into the design.

| Issue | Topic |
|---|---|
| `jinn-mono-vwk` | One-request-to-many-restorations semantics |
| `jinn-mono-24n` | Verdict-gated / verdict-weighted reward design |
| `jinn-mono-7fa` | Multi-evaluator consensus |
| `jinn-mono-68w` | On-chain enforcement of `DesiredState.eligibility` pre-claim fields |
| `jinn-mono-1li` | Mech marketplace `responseTimeout` long-window verification (resolved; remains open for documentation closure) |
| `jinn-mono-8bm` | HL pre-snapshot historical verification (resolved; closes after evaluator implementation confirms approach) |
| `jinn-mono-c03` | HL `userFills` retention (resolved; closes after evaluator implementation confirms approach) |

## 12. Success criteria for v0

A v0 release is shippable when:

- A single fleet can post a `portfolio.v0` intent on Base Sepolia
- A different fleet's daemon (or the same fleet, dev mode) claims it via ClaimRegistry, runs `claude-mcp-hyperliquid` for 24h (or short-cadence dev mode), produces a signed manifest with verifiable HL data
- An evaluator fleet picks up the auto-generated eval intent, runs `portfolio-v0-evaluator`, produces a signed verdict manifest with `verdict ∈ {PASS, FAIL, REJECTED, INDETERMINATE}` and a non-zero score on PASS
- All artifacts (manifests, transcripts, system snapshot) are discoverable via the existing `/v1/artifacts` endpoint and registered with the ERC-8004 registry with parent-manifest back-pointers
- Existing health-check intents continue to function unchanged (backwards compat verified)
- Test suite (`yarn test`) passes; e2e (`yarn e2e`) includes the new portfolio.v0 scenario and passes on Anvil fork

## 13. Forward-compatibility properties

The v0 design is shaped so future Phase 1b protocol changes are additive, not disruptive:

- **Verdict-gated rewards (`jinn-mono-24n`)** — the `score` field already exists in the verdict manifest. On-chain consumption requires only a `JinnRouter` change to read it; no manifest schema change.
- **Multi-restorer (`jinn-mono-vwk`)** — `RestorerImplRegistry` already supports multiple impls; manifest signature and per-restorer artifact roles are uniform across impls. Changes are at the protocol layer, not the manifest.
- **Pre-claim eligibility (`jinn-mono-68w`)** — `IEligibilityChecker` is already pluggable. Smarter checkers can be deployed without touching the off-chain `DesiredState.eligibility` shape.
- **Multi-evaluator consensus (`jinn-mono-7fa`)** — verdict manifests are independently signed and addressable; consensus computation can be added at the consumption layer (subgraph, leaderboard, on-chain reward function) without changing how verdicts are produced.
- **New venues** — adding e.g. Aave, Uniswap means adding a venue helper module and a new restorer impl. Engine, evaluator framework, manifest base shape unchanged.
- **New intent kinds** — `codegen.v0`, `lp.v0`, `dca.v0` etc. all dispatch via `spec.kind`, share the engine, share the manifest base, declare their own check namespaces.
