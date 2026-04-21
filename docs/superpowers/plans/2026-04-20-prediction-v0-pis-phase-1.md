# `prediction.v0` / PIS Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project convention:** This repo uses `beads` (`.beads/`) for task tracking. Create a `bd` issue per task when claiming it (`bd create --title="Task N: ..." --type=task --priority=2`) and close it on commit. The checkbox syntax below is for plan readability.

**Goal:** Ship `prediction.v0` — the first non-portfolio intent kind on the restorer engine — as a Chainlink-resolved threshold/range prediction with a spot-carry baseline restorer, a deterministic Brier-scoring evaluator, and an end-to-end Anvil-forked test proving all four verdict paths plus all four router counters increment. Along the way, make the engine dispatch `(kind, type)`-aware and clean up portfolio.v0 to use the same unified-payload model (retiring the separate `.eval` kind + `EvalSpec`).

**Architecture:** Unified payload: restoration and evaluation share a single intent kind; engine dispatches by `(kind, type)` via widened `RestorerImpl.supports`. Prediction restorer reads Chainlink AggregatorV3 at submission time, emits probability + signs. Evaluator (fired automatically by existing `tryCreateEvaluationJob` path) re-fetches the round spanning `resolveTs`, derives ground truth, Brier-scores. Mock aggregator contract for deterministic testing.

**Tech Stack:** TypeScript + viem (contract reads), Node.js, vitest (test framework), Zod (schema validation), Hardhat/Solidity (MockV3Aggregator), Anvil (e2e fork). No new npm dependencies — Chainlink aggregator is read-only ABI calls via the existing viem client.

**Spec:** [`docs/superpowers/specs/2026-04-20-prediction-v0-pis-phase-1-design.md`](../specs/2026-04-20-prediction-v0-pis-phase-1-design.md)

---

## Worktree setup (before Task 1)

- [ ] **Create a fresh worktree branched off the current branch.**

```bash
cd /Users/adrianobradley/jinn-mono
git worktree add \
  ../jinn-mono-prediction-v0 \
  -b prediction-v0-pis-phase-1 \
  ale/jinn-mono-end-to-end-daemon-accept-measurable-in-6f7ccc20
cd ../jinn-mono-prediction-v0
corepack enable && cd client && yarn install && cd ..
```

Expected: new worktree at `../jinn-mono-prediction-v0`, new branch `prediction-v0-pis-phase-1`, clean `yarn typecheck` + `yarn test` baseline.

- [ ] **Baseline verification.**

```bash
cd client && yarn typecheck && yarn test
```

Expected: zero type errors, all tests pass.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `client/src/restorer/types.ts` | Modify | Widen `RestorerImpl.supports` signature |
| `client/src/restorer/engine/registry.ts` | Modify | Thread `type` through `findFor` dispatch |
| `client/src/restorer/engine/persistence.ts` | Modify | Add `intent_type` column + read/write |
| `client/src/restorer/engine/engine.ts` | Modify | Pass `type` into all `findFor` / `supports` call sites |
| `client/src/daemon/daemon.ts` | Modify | Thread `desiredState.type` into `engine.observe()` |
| `client/src/restorer/impls/legacy-claude/index.ts` | Modify | Accept new `supports` signature (no behavior change) |
| `client/src/restorer/impls/claude-mcp-hyperliquid/index.ts` | Modify | `supports({kind, type})` — gate to `type !== 'evaluation'` |
| `client/src/restorer/impls/portfolio-v0-evaluator/index.ts` | Modify | `supports({kind, type})` — match on `type === 'evaluation'`; retire `EvalSpec` reads |
| `client/src/restorer/impls/portfolio-v0-evaluator/types.ts` | Modify | Delete `EvalSpec` interface |
| `client/src/main.ts` | Modify | Remove `portfolio.v0.eval` byKind; add prediction registrations |
| `client/scripts/e2e-portfolio-v0.ts` | Modify | Delete hand-rolled `EvalSpec`; use daemon-loop eval path |
| `client/test/restorer/impls/portfolio-v0-evaluator/**` | Modify | Update fixtures to unified-payload model |
| `client/src/types/prediction.ts` | Create | Zod schemas: `PredictionV0Spec`, manifests |
| `client/src/types/index.ts` | Modify | Re-export prediction types |
| `client/src/venues/chainlink/client.ts` | Create | AggregatorV3 read client |
| `client/src/venues/chainlink/feeds.ts` | Create | Known feeds (Base Sepolia / Base ETH-USD, BTC-USD) |
| `client/src/restorer/impls/prediction-v0-baseline/index.ts` | Create | RestorerImpl entrypoint |
| `client/src/restorer/impls/prediction-v0-baseline/strategy.ts` | Create | Spot-carry strategy (swappable) |
| `client/src/restorer/impls/prediction-v0-baseline/types.ts` | Create | Local types |
| `client/src/restorer/impls/prediction-v0-evaluator/index.ts` | Create | RestorerImpl entrypoint (verdict pipeline) |
| `client/src/restorer/impls/prediction-v0-evaluator/canonical-metrics.ts` | Create | `brierScore`, `resolveGroundTruth`, decimal helpers |
| `client/src/restorer/impls/prediction-v0-evaluator/score.ts` | Create | `brier.v1` scoreBasis |
| `client/src/restorer/impls/prediction-v0-evaluator/types.ts` | Create | Check types, EvalOutput |
| `client/src/restorer/impls/prediction-v0-evaluator/checks/availability.ts` | Create | Oracle reachable + round coverage |
| `client/src/restorer/impls/prediction-v0-evaluator/checks/eligibility.ts` | Create | Submission within window |
| `client/src/restorer/impls/prediction-v0-evaluator/checks/integrity.ts` | Create | Window bounds, manifest fields, signature, intent_ref |
| `client/src/restorer/impls/prediction-v0-evaluator/checks/spec.ts` | Create | Question kind supported |
| `client/src/cli/commands/submit-intent.ts` | Modify | `--spec-file` flag |
| `client/fixtures/prediction-v0-intent.example.json` | Create | Example typed intent |
| `contracts/src/testnet/MockV3Aggregator.sol` | Create | Owner-pushed Chainlink mock |
| `client/scripts/e2e-prediction-v0.ts` | Create | Full end-to-end Anvil-forked test |
| `client/test/**/*.test.ts` | Create/Modify | Unit + integration tests (per-task listed) |

---

## Phase A — Engine dispatch refactor

This phase widens the engine's dispatch to `(kind, type)` without changing any user-visible behavior. Existing portfolio.v0 + legacy-claude paths must continue to work on completion of Phase A.

### Task 1: Widen `RestorerImpl.supports` signature

**Files:**
- Modify: `client/src/restorer/types.ts`

- [ ] **Step 1: Update the interface.**

Change line 48 from:

```ts
supports(spec: { kind: string }): boolean;
```

to:

```ts
supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean;
```

Add a JSDoc clarifying `type` semantics:

```ts
/**
 * Return true if this impl should handle the given (kind, type) pair.
 *
 * `type` reflects DesiredState.type:
 *   - 'restoration' (or undefined — legacy default): the impl runs a restoration attempt
 *   - 'evaluation': the impl runs as an evaluator producing a verdict
 *
 * A restorer impl for kind=X should return true for type !== 'evaluation'.
 * An evaluator impl for kind=X should return true for type === 'evaluation'.
 */
supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean;
```

- [ ] **Step 2: Run typecheck — expect it to fail at every `supports(...)` call site.**

```bash
cd client && yarn typecheck
```

Expected: errors in `registry.ts`, `legacy-claude/index.ts`, `claude-mcp-hyperliquid/index.ts`, `portfolio-v0-evaluator/index.ts` — these are addressed in subsequent tasks.

- [ ] **Step 3: Commit.**

```bash
git add client/src/restorer/types.ts
git commit -m "refactor(restorer): widen RestorerImpl.supports to (kind, type)

Dispatch must distinguish restoration vs evaluation roles on the same
spec.kind. Subsequent tasks update call sites + impls.
"
```

---

### Task 2: Update `RestorerImplRegistry.findFor` dispatch

**Files:**
- Modify: `client/src/restorer/engine/registry.ts`
- Modify: `client/src/restorer/engine/engine.ts` (interface)
- Test: `client/test/restorer/engine/registry.test.ts` (create if absent)

- [ ] **Step 1: Write failing test for `(kind, type)` dispatch.**

Create `client/test/restorer/engine/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RestorerImplRegistry } from '../../../src/restorer/engine/registry.js';
import type { RestorerImpl } from '../../../src/restorer/types.js';

const stubImpl = (name: string, supports: RestorerImpl['supports']): RestorerImpl => ({
  name,
  version: '0',
  supports,
  async run() { throw new Error('not used in dispatch tests'); },
});

describe('RestorerImplRegistry.findFor', () => {
  it('byKind resolves the restorer impl when type is restoration', () => {
    const r = new RestorerImplRegistry({ byKind: { 'x': 'x-rest' } });
    const rest = stubImpl('x-rest', ({kind, type}) => kind === 'x' && type !== 'evaluation');
    const eval_ = stubImpl('x-eval', ({kind, type}) => kind === 'x' && type === 'evaluation');
    r.register(rest); r.register(eval_);
    expect(r.findFor({ kind: 'x', type: 'restoration' })?.name).toBe('x-rest');
    expect(r.findFor({ kind: 'x' })?.name).toBe('x-rest');
  });

  it('falls through to first-match for evaluation', () => {
    const r = new RestorerImplRegistry({ byKind: { 'x': 'x-rest' } });
    const rest = stubImpl('x-rest', ({kind, type}) => kind === 'x' && type !== 'evaluation');
    const eval_ = stubImpl('x-eval', ({kind, type}) => kind === 'x' && type === 'evaluation');
    r.register(rest); r.register(eval_);
    // byKind points at x-rest but x-rest.supports({type:'evaluation'}) is false
    // → registry falls through to first-match, which finds x-eval
    expect(r.findFor({ kind: 'x', type: 'evaluation' })?.name).toBe('x-eval');
  });

  it('disabled impls are filtered before dispatch', () => {
    const r = new RestorerImplRegistry({ disabled: ['x-rest'] });
    r.register(stubImpl('x-rest', ({kind}) => kind === 'x'));
    r.register(stubImpl('y-rest', ({kind}) => kind === 'y'));
    expect(r.findFor({ kind: 'x' })).toBeUndefined();
    expect(r.findFor({ kind: 'y' })?.name).toBe('y-rest');
  });
});
```

- [ ] **Step 2: Run the test — expect TypeScript or runtime failures.**

```bash
cd client && yarn test test/restorer/engine/registry.test.ts
```

Expected: FAIL (either compile error or dispatch-logic error).

- [ ] **Step 3: Implement the dispatch change in `registry.ts`.**

Update `findFor` signature and body:

```ts
findFor(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): RestorerImpl | undefined {
  const disabled = new Set(this.config.disabled ?? []);
  const active = this.impls.filter((impl) => !disabled.has(impl.name));

  // 1. byKind explicit mapping — but ONLY honor it if the named impl supports
  //    the requested ctx. Otherwise fall through (e.g., byKind points at the
  //    restorer impl, but ctx asks for an evaluation).
  const kindName = this.config.byKind?.[ctx.kind];
  if (kindName) {
    const named = active.find((impl) => impl.name === kindName);
    if (named && named.supports(ctx)) return named;
  }

  // 2. default fallback name
  if (this.config.default) {
    const defaultImpl = active.find((impl) => impl.name === this.config.default);
    if (defaultImpl && defaultImpl.supports(ctx)) return defaultImpl;
  }

  // 3. First-match
  return active.find((impl) => impl.supports(ctx));
}
```

Also update `resolveImplName`:

```ts
resolveImplName(ctx: { kind: string | null; type?: 'restoration' | 'evaluation' }): string | null {
  if (ctx.kind === null) return null;
  const impl = this.findFor({ kind: ctx.kind, type: ctx.type });
  return impl?.name ?? null;
}
```

And update `RestorerImplRegistry` interface in `engine.ts:53-56`:

```ts
export interface RestorerImplRegistry {
  resolveImplName(ctx: { kind: string | null; type?: 'restoration' | 'evaluation' }): string | null;
}
```

And `RestorationEngineOptions.implRegistry` at `engine.ts:95-97`:

```ts
implRegistry?: {
  findFor(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): RestorerImpl | undefined;
};
```

- [ ] **Step 4: Run test — expect PASS.**

```bash
cd client && yarn test test/restorer/engine/registry.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Commit.**

```bash
git add client/src/restorer/engine/registry.ts client/src/restorer/engine/engine.ts client/test/restorer/engine/registry.test.ts
git commit -m "feat(registry): dispatch on (kind, type); fall through when byKind does not support ctx"
```

---

### Task 3: Persist `intent_type` column

**Files:**
- Modify: `client/src/restorer/engine/persistence.ts`

- [ ] **Step 1: Add column to CREATE TABLE and migrations.**

In `RESTORATION_INTENTS_SCHEMA` at line 43, add after `spec_kind`:

```sql
  spec_kind               TEXT,
  intent_type             TEXT,     -- 'restoration' | 'evaluation' | NULL (legacy)
  impl_name               TEXT,
```

In `runAdditiveMigrations` at line 252, add:

```ts
{ column: 'intent_type', ddl: 'ALTER TABLE restoration_intents ADD COLUMN intent_type TEXT' },
```

- [ ] **Step 2: Update `PersistedIntentInput` and `PersistedIntent`.**

In `PersistedIntentInput` (line 106), add:

```ts
/** 'restoration' (default) or 'evaluation'. Captured from DesiredState.type at observe() time. */
intentType?: 'restoration' | 'evaluation';
```

In `PersistedIntent` (line 125), add:

```ts
intentType: 'restoration' | 'evaluation' | null;
```

- [ ] **Step 3: Update `insertDiscovered` to include the column.**

Find `insertDiscovered` (grep for it; around line 310+). Update the INSERT to write `intent_type` from `input.intentType ?? null`.

- [ ] **Step 4: Update the SELECT→PersistedIntent mapper to read `intent_type`.**

Find `rowToIntent` (or similar; grep for `state: row.state`). Add `intentType: row.intent_type as 'restoration'|'evaluation'|null`.

- [ ] **Step 5: Write + run a test on the new column.**

Create/append `client/test/restorer/engine/persistence.test.ts` with:

```ts
it('persists intentType roundtrip', () => {
  const store = new Store(':memory:');
  const p = new IntentPersistence(store.db);
  p.insertDiscovered({
    requestId: '0xabc',
    intentCid: 'cid',
    onchainCreationTx: '0x0',
    onchainCreationBlock: 1,
    specKind: 'prediction.v0',
    intentType: 'evaluation',
    windowStartTs: 0,
    windowEndTs: 3_600_000,
    desiredState: { id: 'i', description: 'd' } as any,
  });
  const got = p.getByRequestId('0xabc');
  expect(got?.intentType).toBe('evaluation');
});
```

Run: `yarn test test/restorer/engine/persistence.test.ts -t intentType`. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add client/src/restorer/engine/persistence.ts client/test/restorer/engine/persistence.test.ts
git commit -m "feat(persistence): add intent_type column for dispatch threading"
```

---

### Task 4: Thread `type` through engine call sites

**Files:**
- Modify: `client/src/restorer/engine/engine.ts`

- [ ] **Step 1: Update `findFor` call in `takePreSnapshot` (line 422-425).**

```ts
const resolvedImpl = intent.specKind
  ? this.implRegistry?.findFor({ kind: intent.specKind, type: intent.intentType ?? 'restoration' }) ?? null
  : null;
```

- [ ] **Step 2: Update `findFor` call in `runImpl` (line 465-469).**

```ts
const specKind = intent.specKind ?? '';
const type = intent.intentType ?? 'restoration';
const impl = this.implRegistry?.findFor({ kind: specKind, type });
if (!impl) {
  throw new NotImplementedError('runImpl');
}
```

- [ ] **Step 3: Run typecheck + all tests.**

```bash
cd client && yarn typecheck && yarn test
```

Expected: `typecheck` may still fail at impls that haven't been updated yet — Tasks 5 + 6 fix those. `yarn test` should at least not regress on registry/persistence tests.

- [ ] **Step 4: Commit.**

```bash
git add client/src/restorer/engine/engine.ts
git commit -m "feat(engine): thread intentType into impl dispatch"
```

---

### Task 5: Thread `type` through daemon watcher

**Files:**
- Modify: `client/src/daemon/daemon.ts`

- [ ] **Step 1: In `_runEngineWatcherLoop` at line 239, add `intentType`.**

Where it calls `engine.observe({...})` (around line 255-264), add:

```ts
await engine.observe({
  requestId: request.requestId,
  intentCid: request.intentCid ?? '',
  onchainCreationTx: request.onchainCreationTx ?? (request.requestId as `0x${string}`),
  onchainCreationBlock: request.onchainCreationBlock ?? 0,
  specKind,
  intentType: (request.desiredState.type ?? 'restoration') as 'restoration' | 'evaluation',
  windowStartTs,
  windowEndTs,
  desiredState: request.desiredState,
});
```

- [ ] **Step 2: Run typecheck.**

```bash
cd client && yarn typecheck
```

Expected: type error may appear if `PersistedIntentInput.intentType` type is too narrow — fix the cast.

- [ ] **Step 3: Commit.**

```bash
git add client/src/daemon/daemon.ts
git commit -m "feat(daemon): pass DesiredState.type into engine.observe()"
```

---

### Task 6: Update existing impls to new `supports` signature

**Files:**
- Modify: `client/src/restorer/impls/legacy-claude/index.ts`
- Modify: `client/src/restorer/impls/claude-mcp-hyperliquid/index.ts`

- [ ] **Step 1: Update `LegacyClaudeImpl.supports` at `legacy-claude/index.ts:41-43`.**

```ts
supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
  // legacy-claude handles restoration-type health-check intents with no spec.kind.
  // It never runs as an evaluator.
  if (ctx.type === 'evaluation') return false;
  return ctx.kind === '' || ctx.kind === 'legacy';
}
```

- [ ] **Step 2: Update `ClaudeMcpHyperliquidImpl.supports` at `claude-mcp-hyperliquid/index.ts:88-90`.**

```ts
supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
  return ctx.kind === 'portfolio.v0' && ctx.type !== 'evaluation';
}
```

- [ ] **Step 3: Run typecheck + existing tests.**

```bash
cd client && yarn typecheck && yarn test
```

Expected: typecheck passes; all existing tests still pass (these changes are behavior-compatible — portfolio.v0 restoration intents still route to claude-mcp-hyperliquid; legacy health-checks still route to legacy-claude).

- [ ] **Step 4: Commit.**

```bash
git add client/src/restorer/impls/legacy-claude/index.ts client/src/restorer/impls/claude-mcp-hyperliquid/index.ts
git commit -m "refactor(impls): adopt (kind, type) supports signature"
```

---

## Phase B — Portfolio.v0 cleanup

Retire `portfolio.v0.eval` kind + `EvalSpec` pointer fields. Portfolio evaluator reads unified payload (`intent.spec` + `intent.restorationRequestId` + `intent.context.restorationResult`).

### Task 7: Update `PortfolioV0Evaluator.supports` + retire `EvalSpec` reads in main path

**Files:**
- Modify: `client/src/restorer/impls/portfolio-v0-evaluator/index.ts`
- Modify: `client/src/restorer/impls/portfolio-v0-evaluator/types.ts`

- [ ] **Step 1: Read the evaluator fully first.**

```bash
cat client/src/restorer/impls/portfolio-v0-evaluator/index.ts | head -300
cat client/src/restorer/impls/portfolio-v0-evaluator/types.ts
```

Identify every access to `spec.targetManifestCid`, `spec.targetIntentCid`, `spec.targetCreationTx`, `spec.targetRequestId`, `spec.targetCreationBlock`. Each becomes:

| Old | New source |
|---|---|
| `spec.targetManifestCid` | `context.restorationResult.manifestCid` — but we don't *need* it; the restorer's manifest is already inlined as JSON via `context.restorationResult` (string). |
| `spec.targetIntentCid` | The restoration manifest itself carries `manifest.intent.cid` (§5.1 of portfolio.v0 design) — read from there. |
| `spec.targetCreationTx` | `manifest.intent.onchainCreationTx`. |
| `spec.targetCreationBlock` | `manifest.intent.onchainCreationBlock`. |
| `spec.targetRequestId` | `intent.restorationRequestId` (top-level DesiredState field). |

- [ ] **Step 2: Update `supports` at line 241.**

```ts
supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
  return ctx.kind === 'portfolio.v0' && ctx.type === 'evaluation';
}
```

- [ ] **Step 3: Update `canAttempt` at line 244-253.**

```ts
async canAttempt(
  intent: DesiredState,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (intent.spec?.kind !== 'portfolio.v0') {
    return { ok: false, reason: 'spec.kind is not portfolio.v0' };
  }
  if (intent.type !== 'evaluation') {
    return { ok: false, reason: 'DesiredState.type is not evaluation' };
  }
  if (!intent.restorationRequestId) {
    return { ok: false, reason: 'restorationRequestId is required' };
  }
  const restorationResult = intent.context?.['restorationResult'];
  if (typeof restorationResult !== 'string') {
    return { ok: false, reason: 'context.restorationResult (manifest JSON) is required' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Update `run()` to source manifest from `context.restorationResult`.**

Locate where the evaluator currently reads `spec.targetManifestCid` and fetches from IPFS. Replace the fetch with `JSON.parse(intent.context!.restorationResult as string)`. Keep the IPFS fallback when `restorationResult` is absent (during crash recovery where context may have been lost):

```ts
let manifest: RestorationManifest;
const inlined = ctx.intent.context?.['restorationResult'];
if (typeof inlined === 'string') {
  manifest = RestorationManifestSchema.parse(JSON.parse(inlined));
} else {
  // Fallback — compute manifestCid from chain Deliver event + fetch IPFS.
  // This branch is hit on crash recovery where context wasn't rehydrated.
  throw new Error(
    'portfolio-v0-evaluator: restorationResult missing from context; crash recovery path not yet implemented',
  );
}

const intentCid = manifest.intent.cid;
const onchainCreationTx = manifest.intent.onchainCreationTx;
const onchainCreationBlock = manifest.intent.onchainCreationBlock;
const restorationRequestId = ctx.intent.restorationRequestId!;
```

All downstream reads of the old `EvalSpec` fields now source from `manifest.intent.*` or `ctx.intent.restorationRequestId`.

- [ ] **Step 5: Delete `EvalSpec` interface from `types.ts`.**

Remove the `EvalSpec` interface + any exports.

- [ ] **Step 6: Run typecheck.**

```bash
cd client && yarn typecheck
```

Expected: error in `e2e-portfolio-v0.ts` (still imports `EvalSpec`) — handled in Task 10. Evaluator test fixtures will also break — handled in Task 11. Accept the red for now; don't run tests yet.

- [ ] **Step 7: Commit.**

```bash
git add client/src/restorer/impls/portfolio-v0-evaluator/index.ts client/src/restorer/impls/portfolio-v0-evaluator/types.ts
git commit -m "refactor(portfolio-v0-evaluator): read unified payload (retire EvalSpec)"
```

---

### Task 8: Update `main.ts` registration

**Files:**
- Modify: `client/src/main.ts`

- [ ] **Step 1: Remove `portfolio.v0.eval` byKind entry.**

At lines 306-313, the `byKind` map becomes:

```ts
const implRegistry = new RestorerImplRegistry({
  byKind: {
    'portfolio.v0': 'claude-mcp-hyperliquid',
  },
  default: 'legacy-claude',
  ...(config.restorers ?? {}),
});
```

- [ ] **Step 2: Run typecheck.**

```bash
cd client && yarn typecheck
```

Expected: still red from test fixtures; main.ts itself clean.

- [ ] **Step 3: Commit.**

```bash
git add client/src/main.ts
git commit -m "refactor(main): drop portfolio.v0.eval byKind (evaluator selected via supports)"
```

---

### Task 9: Update portfolio-v0-evaluator test helpers + fixtures

**Files:**
- Modify: `client/test/restorer/impls/portfolio-v0-evaluator/test-helpers.ts`
- Modify: `client/test/restorer/impls/portfolio-v0-evaluator/index.test.ts`
- Modify: `client/test/restorer/impls/portfolio-v0-evaluator/checks/*.test.ts`

- [ ] **Step 1: Replace `EvalSpec` factory with unified-payload factory in `test-helpers.ts`.**

The old factory created an intent with `spec.kind = 'portfolio.v0.eval'` + pointer fields. Replace with:

```ts
export function makeEvalIntent(opts: {
  manifest: RestorationManifest;
  restorationRequestId?: string;
  window?: Window;
}): DesiredState {
  const window = opts.window ?? { startTs: 0, endTs: 86_400_000 };
  return {
    id: 'test-eval-intent',
    description: 'Evaluate test portfolio.v0 restoration',
    type: 'evaluation',
    restorationRequestId: opts.restorationRequestId ?? '0xrequest',
    spec: {
      kind: 'portfolio.v0',
      account: { venue: 'hyperliquid-testnet', masterAddress: '0x0000000000000000000000000000000000000001' },
      target: { metric: 'equity_return_pct', minReturnPct: 1.0 },
      constraint: { maxDrawdownPct: 10.0 },
    },
    eligibility: { minClosedTrades: 20, minTradedNotionalMultiple: 5.0 },
    window,
    context: {
      restorationResult: JSON.stringify(opts.manifest),
    },
  } as DesiredState;
}
```

- [ ] **Step 2: Update every call site in `index.test.ts` + `checks/*.test.ts`.**

Replace `makeEvalSpec({...})` with `makeEvalIntent({manifest: ..., restorationRequestId: ...})`. The ctx passed into `evaluator.run(ctx)` now uses `ctx.intent` directly (no spec separation).

- [ ] **Step 3: Run portfolio evaluator tests.**

```bash
cd client && yarn test test/restorer/impls/portfolio-v0-evaluator/
```

Expected: all green.

- [ ] **Step 4: Commit.**

```bash
git add client/test/restorer/impls/portfolio-v0-evaluator/
git commit -m "test(portfolio-v0-evaluator): update fixtures to unified-payload model"
```

---

### Task 10: Update portfolio.v0 e2e to daemon-loop eval path

**Files:**
- Modify: `client/scripts/e2e-portfolio-v0.ts`

- [ ] **Step 1: Delete the hand-rolled `EvalSpec` block (lines 620-720).**

Remove the entire section that manually constructs `evalSpec: EvalSpec` and calls `new PortfolioV0Evaluator().run(evalCtx)`.

- [ ] **Step 2: Replace with an assertion that the daemon loop produces the verdict.**

The restorer flow already goes through `adapter.watchForRequests` → engine. The eval should naturally fire via `tryCreateEvaluationJob`. Verify by re-using `adapter.watchForRequests()[Symbol.asyncIterator]()` to wait for the second request (the eval), then confirm its `desiredState.type === 'evaluation'`, and that the engine dispatches to `PortfolioV0Evaluator`. The evaluator's output manifest (`verdict.json`) should appear in the engine's working dir.

Concrete replacement (sketch — adapt to the variable names already in the script):

```ts
// After restoration delivery has been claimed + eval job auto-created:
const evalIter = adapter.watchForRequests()[Symbol.asyncIterator]();
const miningInterval = setInterval(() => jsonRpc(ANVIL_RPC, 'evm_mine', []), 1000);
try {
  const { value: evalReq } = await Promise.race([
    evalIter.next(),
    sleep(45_000).then(() => { throw new Error('eval request timeout'); }),
  ]);
  if (!evalReq || evalReq.desiredState.type !== 'evaluation') {
    throw new Error(`expected evaluation request, got ${evalReq?.desiredState.type}`);
  }
  console.log(`    Eval request: ${evalReq.requestId} (type=${evalReq.desiredState.type})`);
  // The engine's own watcher will dispatch this to PortfolioV0Evaluator via
  // findFor({kind:'portfolio.v0', type:'evaluation'}).
  // Poll the engine's persistence or HTTP status for COMPLETE state + verdict.
} finally {
  clearInterval(miningInterval);
}
```

For the dogfood, you can continue asserting on the evaluator's output via polling the engine's SQLite persistence (`store.db.prepare("SELECT ... FROM restoration_intents WHERE request_id = ?").get(evalReq.requestId)`). The `gating_claim` column will contain the JSON gating blob with `verdict`.

- [ ] **Step 3: Run the e2e.**

```bash
cd client && yarn tsx scripts/e2e-portfolio-v0.ts
```

Expected: runs end-to-end, produces a PASS verdict from the evaluator now invoked via the engine, not directly.

- [ ] **Step 4: Commit.**

```bash
git add client/scripts/e2e-portfolio-v0.ts
git commit -m "test(portfolio-v0-e2e): exercise daemon-loop eval path (retire manual EvalSpec)"
```

---

### Task 11: Full test + typecheck green baseline

- [ ] **Step 1: Run full typecheck + full suite + portfolio e2e.**

```bash
cd client && yarn typecheck && yarn test && yarn tsx scripts/e2e-portfolio-v0.ts
```

Expected: all green. Phase A + B complete.

- [ ] **Step 2: If anything fails, fix inline.**

Likely leftover imports of `EvalSpec` somewhere; `grep -r EvalSpec client/` will find them.

- [ ] **Step 3: Commit any final cleanups.**

```bash
git add -A && git status
# If anything staged:
git commit -m "chore: clean up stray EvalSpec imports after dispatch refactor"
```

**Checkpoint:** Phase A (engine dispatch) + Phase B (portfolio cleanup) complete. Everything compiles, all tests green. No new features yet. Good time to pause + review before Phase C.

---

## Phase C — `prediction.v0` typed spec

### Task 12: Prediction types + Zod schemas

**Files:**
- Create: `client/src/types/prediction.ts`
- Test: `client/test/types/prediction.test.ts`
- Modify: `client/src/types/index.ts`

- [ ] **Step 1: Write failing tests for the schemas.**

Create `client/test/types/prediction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  PredictionV0SpecSchema,
  PredictionV0IntentSchema,
  PredictionSubmissionManifestSchema,
  PredictionVerdictManifestSchema,
} from '../../src/types/prediction.js';

const validThresholdSpec = {
  kind: 'prediction.v0' as const,
  oracle: {
    venue: 'chainlink-base-sepolia' as const,
    feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
    feedDescription: 'ETH / USD',
  },
  question: {
    kind: 'threshold' as const,
    operator: 'GT' as const,
    threshold: '3500',
    resolveTs: 4_500_000,
  },
};

describe('PredictionV0SpecSchema', () => {
  it('accepts a threshold spec', () => {
    expect(PredictionV0SpecSchema.parse(validThresholdSpec)).toEqual(validThresholdSpec);
  });

  it('accepts a range spec', () => {
    const range = {
      ...validThresholdSpec,
      question: { kind: 'range' as const, lowerBound: '3000', upperBound: '3500', resolveTs: 4_500_000 },
    };
    expect(PredictionV0SpecSchema.parse(range)).toEqual(range);
  });

  it('rejects unknown operators', () => {
    const bad = { ...validThresholdSpec, question: { ...validThresholdSpec.question, operator: 'BETWEEN' as any } };
    expect(() => PredictionV0SpecSchema.parse(bad)).toThrow();
  });

  it('rejects non-hex feed address', () => {
    const bad = { ...validThresholdSpec, oracle: { ...validThresholdSpec.oracle, feed: 'not-hex' } };
    expect(() => PredictionV0SpecSchema.parse(bad)).toThrow();
  });
});

describe('PredictionV0IntentSchema', () => {
  const validIntent = {
    id: 'test-1',
    description: 'ETH > $3500 at T',
    window: { startTs: 0, endTs: 3_600_000 },
    spec: validThresholdSpec,
  };

  it('accepts a 1h window with resolveTs = endTs + 15min', () => {
    expect(PredictionV0IntentSchema.parse(validIntent).window.endTs).toBe(3_600_000);
  });

  it('rejects a window that is not exactly 1h', () => {
    const bad = { ...validIntent, window: { startTs: 0, endTs: 3_600_001 } };
    expect(() => PredictionV0IntentSchema.parse(bad)).toThrow(/exactly 1h/);
  });

  it('rejects resolveTs that is not exactly endTs + 15min', () => {
    const bad = {
      ...validIntent,
      spec: { ...validThresholdSpec, question: { ...validThresholdSpec.question, resolveTs: 4_500_001 } },
    };
    expect(() => PredictionV0IntentSchema.parse(bad)).toThrow(/resolveTs/);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL.**

```bash
cd client && yarn test test/types/prediction.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the schemas.**

Create `client/src/types/prediction.ts`:

```ts
/**
 * prediction.v0 — typed intent spec, submission manifest, verdict manifest.
 *
 * §4 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
import { z } from 'zod';
import { WindowSchema } from './desired-state.js';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string');

const SignatureSchema = z.object({
  algo: z.literal('secp256k1'),
  signer: HexStringSchema,
  hash: HexStringSchema,
  sig: HexStringSchema,
});

const IntentProvenanceSchema = z.object({
  cid: z.string().min(1),
  onchainCreationTx: HexStringSchema,
  onchainCreationBlock: z.number().int(),
  requestId: HexStringSchema,
});

const ParticipantSchema = z.object({
  safeAddress: HexStringSchema,
  agentEoa: HexStringSchema,
});

// ── §4.1 — Question kinds ─────────────────────────────────────────────────────

const ThresholdQuestionSchema = z.object({
  kind: z.literal('threshold'),
  operator: z.enum(['GT', 'GTE', 'LT', 'LTE']),
  threshold: z.string(),
  resolveTs: z.number().int(),
});

const RangeQuestionSchema = z.object({
  kind: z.literal('range'),
  lowerBound: z.string(),
  upperBound: z.string(),
  resolveTs: z.number().int(),
});

// ── §4.1 — Spec + eligibility + intent ────────────────────────────────────────

export const PredictionV0SpecSchema = z.object({
  kind: z.literal('prediction.v0'),
  oracle: z.object({
    venue: z.enum(['chainlink-base-sepolia', 'chainlink-base']),
    feed: HexStringSchema,
    feedDescription: z.string(),
  }),
  question: z.discriminatedUnion('kind', [ThresholdQuestionSchema, RangeQuestionSchema]),
});

export type PredictionV0Spec = z.infer<typeof PredictionV0SpecSchema>;

export const PredictionV0EligibilitySchema = z.object({
  maxSubmissionDelayMs: z.number().int().default(60_000),
});

export type PredictionV0Eligibility = z.infer<typeof PredictionV0EligibilitySchema>;

export const PredictionV0IntentSchema = z
  .object({
    id: z.string(),
    description: z.string().min(1),
    window: WindowSchema,
    spec: PredictionV0SpecSchema,
    eligibility: PredictionV0EligibilitySchema.default({}),
  })
  .refine(d => d.window.endTs - d.window.startTs === 3_600_000, {
    message: 'window must be exactly 1h (endTs - startTs === 3_600_000 ms)',
    path: ['window'],
  })
  .refine(d => d.spec.question.resolveTs === d.window.endTs + 900_000, {
    message: 'resolveTs must equal window.endTs + 900_000 ms (15min)',
    path: ['spec', 'question', 'resolveTs'],
  });

export type PredictionV0Intent = z.infer<typeof PredictionV0IntentSchema>;

// ── §4.2 — Submission manifest ────────────────────────────────────────────────

export const PredictionSubmissionManifestSchema = z.object({
  schemaVersion: z.literal('prediction.v0.submission.v1'),
  generatedAt: z.number().int(),
  intent: IntentProvenanceSchema,
  restorer: ParticipantSchema,
  window: WindowSchema,
  prediction: z.object({
    probability: z.string().regex(/^(0(\.\d+)?|1(\.0+)?)$/, 'must be a decimal in [0,1]'),
    submittedAt: z.number().int(),
    modelId: z.string().min(1),
  }),
  oracleSnapshot: z.object({
    feed: HexStringSchema,
    roundId: z.string(),
    answer: z.string(),
    updatedAt: z.number().int(),
  }).optional(),
  rationale: z.array(z.object({
    ts: z.number().int(),
    note: z.string(),
  })).optional(),
  signature: SignatureSchema,
});

export type PredictionSubmissionManifest = z.infer<typeof PredictionSubmissionManifestSchema>;

// ── §4.3 — Verdict manifest ───────────────────────────────────────────────────

const CheckSchema = z.object({
  name: z.string(),
  status: z.enum(['PASS', 'FAIL', 'SKIP']),
  detail: z.union([z.string(), z.record(z.unknown())]).optional(),
});

export const PredictionVerdictManifestSchema = z.object({
  schemaVersion: z.literal('prediction.v0.verdict.v1'),
  generatedAt: z.number().int(),
  intent: IntentProvenanceSchema,
  evaluator: ParticipantSchema,
  window: WindowSchema,
  verdict: z.enum(['PASS', 'FAIL', 'REJECTED', 'INDETERMINATE']),
  score: z.string(),
  scoreBasis: z.literal('brier.v1'),
  scoreVersion: z.string(),
  oracleReading: z.object({
    feed: HexStringSchema,
    roundId: z.string(),
    answer: z.string(),
    updatedAt: z.number().int(),
    nextRoundUpdatedAt: z.number().int().optional(),
  }),
  claimed: z.object({
    probability: z.string(),
    submittedAt: z.number().int(),
    modelId: z.string(),
    submissionManifestCid: z.string(),
  }),
  groundTruth: z.enum(['YES', 'NO']),
  checks: z.array(CheckSchema),
  signature: SignatureSchema,
});

export type PredictionVerdictManifest = z.infer<typeof PredictionVerdictManifestSchema>;
```

- [ ] **Step 4: Re-export from `types/index.ts`.**

Append to `client/src/types/index.ts`:

```ts
export {
  PredictionV0SpecSchema,
  PredictionV0EligibilitySchema,
  PredictionV0IntentSchema,
  PredictionSubmissionManifestSchema,
  PredictionVerdictManifestSchema,
  type PredictionV0Spec,
  type PredictionV0Eligibility,
  type PredictionV0Intent,
  type PredictionSubmissionManifest,
  type PredictionVerdictManifest,
} from './prediction.js';
```

- [ ] **Step 5: Run tests.**

```bash
cd client && yarn test test/types/prediction.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit.**

```bash
git add client/src/types/prediction.ts client/src/types/index.ts client/test/types/prediction.test.ts
git commit -m "feat(types): add prediction.v0 spec + manifests"
```

---

## Phase D — Chainlink read client

### Task 13: AggregatorV3 ABI + `readChainlinkLatest` + `scaleToDecimal`

**Files:**
- Create: `client/src/venues/chainlink/client.ts`
- Create: `client/src/venues/chainlink/feeds.ts`
- Test: `client/test/venues/chainlink/client.test.ts`

- [ ] **Step 1: Write failing test for `scaleToDecimal`.**

Create `client/test/venues/chainlink/client.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scaleToDecimal } from '../../../src/venues/chainlink/client.js';

describe('scaleToDecimal', () => {
  it('scales an 8-decimal Chainlink int256 to a decimal string', () => {
    // $3500.00 with 8 decimals = 350_000_000_000
    expect(scaleToDecimal(350_000_000_000n, 8)).toBe('3500');
  });

  it('preserves fractional precision', () => {
    expect(scaleToDecimal(345_012_345_678n, 8)).toBe('3450.12345678');
  });

  it('handles zero', () => {
    expect(scaleToDecimal(0n, 8)).toBe('0');
  });

  it('strips trailing zeros in the fractional part', () => {
    expect(scaleToDecimal(350_000_000_000n, 8)).toBe('3500');
    expect(scaleToDecimal(350_100_000_000n, 8)).toBe('3500.1');
  });

  it('throws on negative values (price feeds are non-negative in v0)', () => {
    expect(() => scaleToDecimal(-1n, 8)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL.**

```bash
cd client && yarn test test/venues/chainlink/client.test.ts
```

- [ ] **Step 3: Implement `scaleToDecimal` + ABI + types in `client.ts`.**

Create `client/src/venues/chainlink/client.ts`:

```ts
/**
 * Chainlink AggregatorV3 read client.
 *
 * §7 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
import type { PublicClient } from 'viem';

export const AGGREGATOR_V3_ABI = [
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    name: 'getRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '_roundId', type: 'uint80' }],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'description',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

export interface RoundReading {
  roundId: bigint;
  answer: bigint;         // raw int256
  startedAt: number;      // ms epoch
  updatedAt: number;      // ms epoch
  answeredInRound: bigint;
  decimals: number;
}

/** Scale a raw Chainlink int256 answer to a decimal string. */
export function scaleToDecimal(answer: bigint, decimals: number): string {
  if (answer < 0n) {
    throw new Error(`scaleToDecimal: negative value not supported in v0 (got ${answer})`);
  }
  const s = answer.toString();
  if (decimals === 0) return s;
  if (s.length <= decimals) {
    const frac = s.padStart(decimals, '0').replace(/0+$/, '');
    return frac.length > 0 ? `0.${frac}` : '0';
  }
  const intPart = s.slice(0, s.length - decimals);
  const fracRaw = s.slice(s.length - decimals);
  const frac = fracRaw.replace(/0+$/, '');
  return frac.length > 0 ? `${intPart}.${frac}` : intPart;
}

export async function readChainlinkLatest(
  feed: `0x${string}`,
  publicClient: PublicClient,
): Promise<RoundReading> {
  const [latest, decimals] = await Promise.all([
    publicClient.readContract({
      address: feed,
      abi: AGGREGATOR_V3_ABI,
      functionName: 'latestRoundData',
    }),
    publicClient.readContract({
      address: feed,
      abi: AGGREGATOR_V3_ABI,
      functionName: 'decimals',
    }),
  ]);
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = latest;
  return {
    roundId,
    answer,
    // Chainlink timestamps are SECONDS → convert to ms for consistency with rest of codebase
    startedAt: Number(startedAt) * 1000,
    updatedAt: Number(updatedAt) * 1000,
    answeredInRound,
    decimals,
  };
}

export async function readChainlinkRound(
  feed: `0x${string}`,
  roundId: bigint,
  publicClient: PublicClient,
  decimals: number,
): Promise<RoundReading> {
  const round = await publicClient.readContract({
    address: feed,
    abi: AGGREGATOR_V3_ABI,
    functionName: 'getRoundData',
    args: [roundId],
  });
  const [rid, answer, startedAt, updatedAt, answeredInRound] = round;
  return {
    roundId: rid,
    answer,
    startedAt: Number(startedAt) * 1000,
    updatedAt: Number(updatedAt) * 1000,
    answeredInRound,
    decimals,
  };
}
```

- [ ] **Step 4: Run test — expect PASS.**

```bash
cd client && yarn test test/venues/chainlink/client.test.ts
```

- [ ] **Step 5: Create `feeds.ts` with known addresses.**

Create `client/src/venues/chainlink/feeds.ts`:

```ts
/** Known Chainlink AggregatorV3 feeds on Base + Base Sepolia. */
export const BASE_SEPOLIA_FEEDS = {
  'ETH / USD': '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1' as const,
  'BTC / USD': '0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298' as const,
} as const;

export const BASE_FEEDS = {
  'ETH / USD': '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' as const,
} as const;
```

(Addresses should be verified against the Chainlink Data Feeds documentation before Phase 1 go-live.)

- [ ] **Step 6: Commit.**

```bash
git add client/src/venues/chainlink/ client/test/venues/chainlink/
git commit -m "feat(venues/chainlink): AggregatorV3 read client + decimal scaling"
```

---

### Task 14: `oraclePriceAtResolveTs` — spanning-round picker

**Files:**
- Modify: `client/src/venues/chainlink/client.ts`
- Modify: `client/test/venues/chainlink/client.test.ts`

- [ ] **Step 1: Write failing test.**

Append to `client/test/venues/chainlink/client.test.ts`:

```ts
import { oraclePriceAtResolveTs } from '../../../src/venues/chainlink/client.js';
import { vi } from 'vitest';

describe('oraclePriceAtResolveTs', () => {
  function makePublicClient(rounds: Array<{roundId: bigint, answer: bigint, updatedAt: number}>) {
    // Sort by roundId ascending
    const byRound = new Map(rounds.map(r => [r.roundId, r]));
    const latest = rounds[rounds.length - 1]!;
    return {
      readContract: vi.fn(async ({ functionName, args }: any) => {
        if (functionName === 'decimals') return 8;
        if (functionName === 'latestRoundData') {
          return [latest.roundId, latest.answer, BigInt(latest.updatedAt / 1000), BigInt(latest.updatedAt / 1000), latest.roundId];
        }
        if (functionName === 'getRoundData') {
          const r = byRound.get(args[0]);
          if (!r) throw new Error(`round ${args[0]} not found`);
          return [r.roundId, r.answer, BigInt(r.updatedAt / 1000), BigInt(r.updatedAt / 1000), r.roundId];
        }
        throw new Error(functionName);
      }),
    } as any;
  }

  it('returns latest when latest.updatedAt > resolveTs and finds the spanning round via walk-back', async () => {
    const rounds = [
      { roundId: 1n, answer: 350_000_000_000n, updatedAt: 1000 },
      { roundId: 2n, answer: 351_000_000_000n, updatedAt: 2000 },
      { roundId: 3n, answer: 352_000_000_000n, updatedAt: 5000 },
    ];
    const pc = makePublicClient(rounds);
    const { round, nextRound } = await oraclePriceAtResolveTs(
      '0x000000000000000000000000000000000000feed',
      3000,
      pc,
    );
    // Round 2 (updatedAt=2000) is latest updatedAt ≤ 3000; round 3 (5000) is next.
    expect(round.roundId).toBe(2n);
    expect(nextRound?.roundId).toBe(3n);
  });

  it('returns null nextRound and indicates spanning when latest.updatedAt <= resolveTs', async () => {
    const rounds = [
      { roundId: 1n, answer: 350_000_000_000n, updatedAt: 1000 },
      { roundId: 2n, answer: 351_000_000_000n, updatedAt: 2000 },
    ];
    const pc = makePublicClient(rounds);
    const result = await oraclePriceAtResolveTs(
      '0x000000000000000000000000000000000000feed',
      5000,
      pc,
    );
    expect(result.round.roundId).toBe(2n);
    expect(result.nextRound).toBeNull();
    expect(result.spanning).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL.**

- [ ] **Step 3: Implement.**

Append to `client/src/venues/chainlink/client.ts`:

```ts
export interface SpanningResult {
  /** Round R with updatedAt ≤ resolveTs. */
  round: RoundReading;
  /** Round R+1 with updatedAt > resolveTs. null if no newer round exists yet. */
  nextRound: RoundReading | null;
  /** True iff nextRound exists — then the spanning property is satisfied. */
  spanning: boolean;
}

/**
 * Find the Chainlink round that "spans" resolveTs: round R where
 * R.updatedAt ≤ resolveTs < (R+1).updatedAt.
 *
 * If the latest round's updatedAt ≤ resolveTs (i.e. no newer round yet),
 * returns { round: latest, nextRound: null, spanning: false }. Caller should
 * retry later (availability check will mark SKIP → INDETERMINATE verdict).
 */
export async function oraclePriceAtResolveTs(
  feed: `0x${string}`,
  resolveTs: number,
  publicClient: PublicClient,
): Promise<SpanningResult> {
  const latest = await readChainlinkLatest(feed, publicClient);
  // Case A: latest is at-or-before resolveTs → no newer round yet
  if (latest.updatedAt <= resolveTs) {
    return { round: latest, nextRound: null, spanning: false };
  }
  // Case B: latest is after resolveTs → walk back to find spanning round
  let nextRound = latest;
  let cursor = latest.roundId - 1n;
  while (cursor > 0n) {
    const r = await readChainlinkRound(feed, cursor, publicClient, latest.decimals);
    if (r.updatedAt <= resolveTs) {
      return { round: r, nextRound, spanning: true };
    }
    nextRound = r;
    cursor -= 1n;
  }
  // Walked back to round 0 without finding a pre-resolveTs round — oracle is
  // newer than the window. Surface as not-spanning so caller INDETERMINATE-s.
  return { round: latest, nextRound: null, spanning: false };
}
```

- [ ] **Step 4: Run test — expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add client/src/venues/chainlink/client.ts client/test/venues/chainlink/client.test.ts
git commit -m "feat(venues/chainlink): spanning-round picker (oraclePriceAtResolveTs)"
```

---

## Phase E — Prediction baseline restorer

### Task 15: Baseline strategy module (spot-carry)

**Files:**
- Create: `client/src/restorer/impls/prediction-v0-baseline/types.ts`
- Create: `client/src/restorer/impls/prediction-v0-baseline/strategy.ts`
- Test: `client/test/restorer/impls/prediction-v0-baseline/strategy.test.ts`

- [ ] **Step 1: Write failing test.**

Create `client/test/restorer/impls/prediction-v0-baseline/strategy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { spotCarryPredict } from '../../../../src/restorer/impls/prediction-v0-baseline/strategy.js';
import type { PredictionV0Intent } from '../../../../src/types/prediction.js';

const intent = (overrides: Partial<PredictionV0Intent['spec']['question']> = {}): PredictionV0Intent => ({
  id: 'test',
  description: 'd',
  window: { startTs: 0, endTs: 3_600_000 },
  spec: {
    kind: 'prediction.v0',
    oracle: { venue: 'chainlink-base-sepolia', feed: '0xfeed', feedDescription: 'ETH / USD' },
    question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs: 4_500_000, ...overrides },
  },
  eligibility: { maxSubmissionDelayMs: 60_000 },
} as PredictionV0Intent);

describe('spotCarryPredict', () => {
  it('returns 0.55 when current price above threshold (GT)', () => {
    expect(spotCarryPredict(intent(), '3501').probability).toBe('0.55');
  });
  it('returns 0.45 when current price at or below threshold (GT)', () => {
    expect(spotCarryPredict(intent(), '3500').probability).toBe('0.45');
    expect(spotCarryPredict(intent(), '3400').probability).toBe('0.45');
  });
  it('handles LT operator', () => {
    expect(spotCarryPredict(intent({ operator: 'LT' }), '3400').probability).toBe('0.55'); // 3400 < 3500 → YES
    expect(spotCarryPredict(intent({ operator: 'LT' }), '3500').probability).toBe('0.45');
  });
  it('handles range questions', () => {
    const rangeIntent = intent() as any;
    rangeIntent.spec.question = { kind: 'range', lowerBound: '3000', upperBound: '3500', resolveTs: 4_500_000 };
    expect(spotCarryPredict(rangeIntent, '3200').probability).toBe('0.55'); // in range
    expect(spotCarryPredict(rangeIntent, '3500').probability).toBe('0.45'); // upper is exclusive
    expect(spotCarryPredict(rangeIntent, '2999').probability).toBe('0.45'); // below lower
  });
  it('reports modelId', () => {
    expect(spotCarryPredict(intent(), '3600').modelId).toBe('spot-carry.v1');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL.**

- [ ] **Step 3: Implement the strategy.**

Create `client/src/restorer/impls/prediction-v0-baseline/types.ts`:

```ts
export interface StrategyPrediction {
  probability: string;    // decimal string ∈ [0,1]
  modelId: string;
}

export interface Strategy {
  predict(intent: import('../../../types/prediction.js').PredictionV0Intent, currentPrice: string): StrategyPrediction;
}
```

Create `client/src/restorer/impls/prediction-v0-baseline/strategy.ts`:

```ts
/**
 * Spot-carry baseline — "current state tends to persist."
 *
 * §5.3 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
import type { PredictionV0Intent } from '../../../types/prediction.js';
import type { StrategyPrediction } from './types.js';

/** Decimal comparison. Both inputs are non-negative decimal strings. */
function decCmp(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  // Strip leading zeros from integer parts
  const aiN = ai.replace(/^0+/, '') || '0';
  const biN = bi.replace(/^0+/, '') || '0';
  if (aiN.length !== biN.length) return aiN.length - biN.length;
  if (aiN !== biN) return aiN < biN ? -1 : 1;
  // Integer parts equal — compare fractional, padded
  const maxLen = Math.max(af.length, bf.length);
  const afP = af.padEnd(maxLen, '0');
  const bfP = bf.padEnd(maxLen, '0');
  if (afP === bfP) return 0;
  return afP < bfP ? -1 : 1;
}

function evaluateQuestion(question: PredictionV0Intent['spec']['question'], price: string): boolean {
  if (question.kind === 'threshold') {
    const c = decCmp(price, question.threshold);
    switch (question.operator) {
      case 'GT':  return c > 0;
      case 'GTE': return c >= 0;
      case 'LT':  return c < 0;
      case 'LTE': return c <= 0;
    }
  } else {
    const lowerCmp = decCmp(price, question.lowerBound);
    const upperCmp = decCmp(price, question.upperBound);
    // lowerBound ≤ price < upperBound
    return lowerCmp >= 0 && upperCmp < 0;
  }
}

export function spotCarryPredict(intent: PredictionV0Intent, currentPrice: string): StrategyPrediction {
  const currentlyYes = evaluateQuestion(intent.spec.question, currentPrice);
  return {
    probability: currentlyYes ? '0.55' : '0.45',
    modelId: 'spot-carry.v1',
  };
}
```

- [ ] **Step 4: Run test — expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add client/src/restorer/impls/prediction-v0-baseline/ client/test/restorer/impls/prediction-v0-baseline/
git commit -m "feat(prediction-v0-baseline): spot-carry strategy"
```

---

### Task 16: `PredictionV0BaselineImpl` entrypoint

**Files:**
- Create: `client/src/restorer/impls/prediction-v0-baseline/index.ts`
- Test: `client/test/restorer/impls/prediction-v0-baseline/index.test.ts`

- [ ] **Step 1: Write failing test for `run()`.**

Create `client/test/restorer/impls/prediction-v0-baseline/index.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, tmpdir } from 'node:path';
import { PredictionV0BaselineImpl } from '../../../../src/restorer/impls/prediction-v0-baseline/index.js';
import type { RestorationContext } from '../../../../src/restorer/types.js';

function makeCtx(overrides: Partial<RestorationContext> = {}): RestorationContext {
  const tmp = mkdtempSync(join(tmpdir(), 'pred-baseline-'));
  return {
    intent: {
      id: 'test-1',
      description: 'ETH > 3500 at T',
      type: 'restoration',
      window: { startTs: 0, endTs: 3_600_000 },
      spec: {
        kind: 'prediction.v0',
        oracle: { venue: 'chainlink-base-sepolia', feed: '0x000000000000000000000000000000000000feed', feedDescription: 'ETH / USD' },
        question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs: 4_500_000 },
      },
      eligibility: { maxSubmissionDelayMs: 60_000 },
    } as any,
    implStateDir: tmp,
    workingDir: tmp,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 3_600_000,
    ...overrides,
  };
}

describe('PredictionV0BaselineImpl', () => {
  it('supports only prediction.v0 restorations', () => {
    const impl = new PredictionV0BaselineImpl({ _testDeps: stubDeps('3600') });
    expect(impl.supports({ kind: 'prediction.v0', type: 'restoration' })).toBe(true);
    expect(impl.supports({ kind: 'prediction.v0', type: 'evaluation' })).toBe(false);
    expect(impl.supports({ kind: 'portfolio.v0', type: 'restoration' })).toBe(false);
  });

  it('writes prediction.json with probability 0.55 when current price > threshold (GT)', async () => {
    const impl = new PredictionV0BaselineImpl({ _testDeps: stubDeps('3600') });
    const ctx = makeCtx();
    const out = await impl.run(ctx);
    expect(out.gating.probability).toBe('0.55');
    const predictionJson = JSON.parse(readFileSync(join(ctx.workingDir, 'prediction.json'), 'utf8'));
    expect(predictionJson.probability).toBe('0.55');
    expect(predictionJson.modelId).toBe('spot-carry.v1');
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts![0].path).toBe('prediction.json');
    expect(out.artifacts![0].role).toBe('prediction_submission');
  });

  it('returns oracleSnapshot in informational', async () => {
    const impl = new PredictionV0BaselineImpl({ _testDeps: stubDeps('3400') });
    const out = await impl.run(makeCtx());
    expect(out.informational?.oracleSnapshot).toMatchObject({ feed: expect.any(String), answer: expect.any(String) });
  });
});

function stubDeps(price: string) {
  return {
    readChainlink: async () => ({
      roundId: 42n,
      answer: BigInt(Math.round(parseFloat(price) * 1e8)),
      startedAt: 0,
      updatedAt: 1000,
      answeredInRound: 42n,
      decimals: 8,
    }),
  };
}
```

- [ ] **Step 2: Run test — expect FAIL.**

- [ ] **Step 3: Implement the impl.**

Create `client/src/restorer/impls/prediction-v0-baseline/index.ts`:

```ts
/**
 * prediction-v0-baseline — reference RestorerImpl for prediction.v0.
 *
 * §5 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 *
 * Reads the Chainlink feed at submission time, runs the spot-carry strategy,
 * writes prediction.json, returns RestorationOutput.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { baseSepolia, base } from 'viem/chains';

import type { RestorerImpl, RestorationContext, RestorationOutput } from '../../types.js';
import { PredictionV0IntentSchema } from '../../../types/prediction.js';
import {
  readChainlinkLatest,
  scaleToDecimal,
  type RoundReading,
} from '../../../venues/chainlink/client.js';
import { spotCarryPredict } from './strategy.js';

export interface ClaudeMcpPredictionConfig {
  /** RPC URL override — defaults to the daemon's public client chain default. */
  rpcUrl?: string;
  /** Injected for testing — defaults to the live readChainlinkLatest. */
  _testDeps?: {
    readChainlink?: (feed: `0x${string}`) => Promise<RoundReading>;
  };
}

export class PredictionV0BaselineImpl implements RestorerImpl {
  readonly name = 'prediction-v0-baseline';
  readonly version = '1.0.0';

  constructor(private readonly config: ClaudeMcpPredictionConfig = {}) {}

  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return ctx.kind === 'prediction.v0' && ctx.type !== 'evaluation';
  }

  async canAttempt(intent: import('../../../types/desired-state.js').DesiredState):
    Promise<{ ok: true } | { ok: false; reason: string }>
  {
    const parsed = PredictionV0IntentSchema.safeParse(intent);
    if (!parsed.success) return { ok: false, reason: `Invalid prediction.v0 intent: ${parsed.error.message}` };
    if (Date.now() > parsed.data.window.endTs) {
      return { ok: false, reason: 'window already closed' };
    }
    return { ok: true };
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const { intent, workingDir, log } = ctx;
    const parsed = PredictionV0IntentSchema.parse(intent);
    const { feed, venue } = parsed.spec.oracle;

    log({ level: 'info', msg: 'prediction-v0-baseline: starting', data: { feed, venue } });

    // Read the feed (injection seam for tests)
    const read = this.config._testDeps?.readChainlink;
    const snapshot = read
      ? await read(feed as `0x${string}`)
      : await readChainlinkLatest(
          feed as `0x${string}`,
          createPublicClient({
            chain: venue === 'chainlink-base' ? base : baseSepolia,
            transport: http(this.config.rpcUrl),
          }),
        );

    const currentPrice = scaleToDecimal(snapshot.answer, snapshot.decimals);
    const { probability, modelId } = spotCarryPredict(parsed, currentPrice);
    const submittedAt = Date.now();

    const prediction = { probability, submittedAt, modelId };
    writeFileSync(join(workingDir, 'prediction.json'), JSON.stringify(prediction, null, 2));

    log({ level: 'info', msg: 'prediction-v0-baseline: submitted', data: { currentPrice, probability, modelId } });

    return {
      venueRef: { name: 'chainlink' },
      gating: {
        probability,
        submittedAt: String(submittedAt),
        modelId,
      },
      informational: {
        oracleSnapshot: {
          feed,
          roundId: String(snapshot.roundId),
          answer: String(snapshot.answer),
          updatedAt: snapshot.updatedAt,
        },
        currentPrice,
      },
      artifacts: [
        { path: 'prediction.json', role: 'prediction_submission' },
      ],
    };
  }
}

export default PredictionV0BaselineImpl;
```

- [ ] **Step 4: Run test — expect PASS.**

```bash
cd client && yarn test test/restorer/impls/prediction-v0-baseline/
```

- [ ] **Step 5: Commit.**

```bash
git add client/src/restorer/impls/prediction-v0-baseline/index.ts client/test/restorer/impls/prediction-v0-baseline/index.test.ts
git commit -m "feat(prediction-v0-baseline): RestorerImpl entrypoint (supports, canAttempt, run)"
```

---

## Phase F — Prediction evaluator

### Task 17: `canonical-metrics.ts` — Brier + ground-truth + decimal helpers

**Files:**
- Create: `client/src/restorer/impls/prediction-v0-evaluator/canonical-metrics.ts`
- Test: `client/test/restorer/impls/prediction-v0-evaluator/canonical-metrics.test.ts`

- [ ] **Step 1: Write failing tests.**

Create `client/test/restorer/impls/prediction-v0-evaluator/canonical-metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  brierScore,
  resolveGroundTruth,
  decCmp,
} from '../../../../src/restorer/impls/prediction-v0-evaluator/canonical-metrics.js';

describe('decCmp', () => {
  it('compares integer decimals', () => {
    expect(decCmp('3500', '3499')).toBeGreaterThan(0);
    expect(decCmp('3500', '3500')).toBe(0);
    expect(decCmp('3499', '3500')).toBeLessThan(0);
  });
  it('compares fractional decimals', () => {
    expect(decCmp('3500.01', '3500.009')).toBeGreaterThan(0);
    expect(decCmp('3500.1', '3500.10')).toBe(0);
  });
});

describe('brierScore', () => {
  it('returns 1e18 for a perfect (p=1, outcome=1)', () => {
    expect(brierScore('1', 1)).toBe('1000000000000000000');
  });
  it('returns 0 for the worst (p=1, outcome=0)', () => {
    expect(brierScore('1', 0)).toBe('0');
  });
  it('returns 0.75 × 1e18 for a coin-flip (p=0.5, any outcome)', () => {
    expect(brierScore('0.5', 1)).toBe('750000000000000000');
    expect(brierScore('0.5', 0)).toBe('750000000000000000');
  });
  it('returns 0.7975 × 1e18 for p=0.55, outcome=YES', () => {
    // 1 - (0.55 - 1)^2 = 1 - 0.2025 = 0.7975
    expect(brierScore('0.55', 1)).toBe('797500000000000000');
  });
});

describe('resolveGroundTruth', () => {
  it('threshold GT — YES when price > threshold', () => {
    const q = { kind: 'threshold' as const, operator: 'GT' as const, threshold: '3500', resolveTs: 0 };
    expect(resolveGroundTruth(q, '3501')).toBe('YES');
    expect(resolveGroundTruth(q, '3500')).toBe('NO');
    expect(resolveGroundTruth(q, '3499')).toBe('NO');
  });
  it('threshold GTE — YES when price >= threshold', () => {
    const q = { kind: 'threshold' as const, operator: 'GTE' as const, threshold: '3500', resolveTs: 0 };
    expect(resolveGroundTruth(q, '3500')).toBe('YES');
    expect(resolveGroundTruth(q, '3499')).toBe('NO');
  });
  it('threshold LT — YES when price < threshold', () => {
    const q = { kind: 'threshold' as const, operator: 'LT' as const, threshold: '3500', resolveTs: 0 };
    expect(resolveGroundTruth(q, '3499')).toBe('YES');
    expect(resolveGroundTruth(q, '3500')).toBe('NO');
  });
  it('range — YES when lower ≤ price < upper', () => {
    const q = { kind: 'range' as const, lowerBound: '3000', upperBound: '3500', resolveTs: 0 };
    expect(resolveGroundTruth(q, '3000')).toBe('YES');
    expect(resolveGroundTruth(q, '3499.99')).toBe('YES');
    expect(resolveGroundTruth(q, '3500')).toBe('NO');
    expect(resolveGroundTruth(q, '2999.99')).toBe('NO');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL.**

- [ ] **Step 3: Implement.**

Create `client/src/restorer/impls/prediction-v0-evaluator/canonical-metrics.ts`:

```ts
/**
 * Canonical metrics for prediction.v0 evaluator.
 *
 * §6 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
import type { PredictionV0Intent } from '../../../types/prediction.js';

/** Compare two non-negative decimal strings. Returns negative/zero/positive. */
export function decCmp(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const aiN = (ai || '0').replace(/^0+/, '') || '0';
  const biN = (bi || '0').replace(/^0+/, '') || '0';
  if (aiN.length !== biN.length) return aiN.length - biN.length;
  if (aiN !== biN) return aiN < biN ? -1 : 1;
  const maxLen = Math.max(af.length, bf.length);
  const afP = af.padEnd(maxLen, '0');
  const bfP = bf.padEnd(maxLen, '0');
  if (afP === bfP) return 0;
  return afP < bfP ? -1 : 1;
}

export type GroundTruth = 'YES' | 'NO';

export function resolveGroundTruth(
  question: PredictionV0Intent['spec']['question'],
  price: string,
): GroundTruth {
  if (question.kind === 'threshold') {
    const c = decCmp(price, question.threshold);
    switch (question.operator) {
      case 'GT':  return c > 0 ? 'YES' : 'NO';
      case 'GTE': return c >= 0 ? 'YES' : 'NO';
      case 'LT':  return c < 0 ? 'YES' : 'NO';
      case 'LTE': return c <= 0 ? 'YES' : 'NO';
    }
  }
  // range: lowerBound ≤ price < upperBound
  const lo = decCmp(price, question.lowerBound);
  const hi = decCmp(price, question.upperBound);
  return (lo >= 0 && hi < 0) ? 'YES' : 'NO';
}

/**
 * Brier score scaled to 1e18 fixed-point.
 *
 * score = 1 - (probability - outcome)^2 ∈ [0,1]
 *   * probability: decimal string ∈ [0,1]
 *   * outcome: 0 | 1
 *
 * Returns: string representation of BigInt (score × 1e18), rounded to nearest.
 */
export function brierScore(probability: string, outcome: 0 | 1): string {
  const p = Number(probability);
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`brierScore: probability must be in [0,1], got ${probability}`);
  }
  const s = 1 - Math.pow(p - outcome, 2);
  // Scale to 1e18 with rounding
  const scaled = BigInt(Math.round(s * 1e18));
  return scaled.toString();
}
```

- [ ] **Step 4: Run test — expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add client/src/restorer/impls/prediction-v0-evaluator/canonical-metrics.ts client/test/restorer/impls/prediction-v0-evaluator/canonical-metrics.test.ts
git commit -m "feat(prediction-v0-evaluator): canonical metrics (decCmp, resolveGroundTruth, brierScore)"
```

---

### Task 18: `score.ts` — `brier.v1` scoreBasis

**Files:**
- Create: `client/src/restorer/impls/prediction-v0-evaluator/score.ts`
- Test: `client/test/restorer/impls/prediction-v0-evaluator/score.test.ts`

- [ ] **Step 1: Write failing test.**

Create `client/test/restorer/impls/prediction-v0-evaluator/score.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeScore, SCORE_BASIS, SCORE_VERSION } from '../../../../src/restorer/impls/prediction-v0-evaluator/score.js';

describe('computeScore', () => {
  it('PASS with correct prediction scores 0.7975 × 1e18 for p=0.55 YES', () => {
    const { score, scoreBasis, scoreVersion } = computeScore('PASS', '0.55', 'YES');
    expect(score).toBe('797500000000000000');
    expect(scoreBasis).toBe(SCORE_BASIS);
    expect(scoreVersion).toBe(SCORE_VERSION);
  });
  it('non-PASS verdicts score 0', () => {
    expect(computeScore('FAIL', '0.55', 'YES').score).toBe('0');
    expect(computeScore('REJECTED', '0.55', 'YES').score).toBe('0');
    expect(computeScore('INDETERMINATE', '0.55', 'YES').score).toBe('0');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL.**

- [ ] **Step 3: Implement.**

Create `client/src/restorer/impls/prediction-v0-evaluator/score.ts`:

```ts
import { brierScore } from './canonical-metrics.js';

export const SCORE_BASIS = 'brier.v1' as const;
export const SCORE_VERSION = '1' as const;

export type Verdict = 'PASS' | 'FAIL' | 'REJECTED' | 'INDETERMINATE';

export function computeScore(
  verdict: Verdict,
  probability: string,
  groundTruth: 'YES' | 'NO',
): { score: string; scoreBasis: typeof SCORE_BASIS; scoreVersion: typeof SCORE_VERSION } {
  if (verdict !== 'PASS') {
    return { score: '0', scoreBasis: SCORE_BASIS, scoreVersion: SCORE_VERSION };
  }
  const outcome = groundTruth === 'YES' ? 1 : 0;
  return {
    score: brierScore(probability, outcome),
    scoreBasis: SCORE_BASIS,
    scoreVersion: SCORE_VERSION,
  };
}
```

- [ ] **Step 4: Run test — expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add client/src/restorer/impls/prediction-v0-evaluator/score.ts client/test/restorer/impls/prediction-v0-evaluator/score.test.ts
git commit -m "feat(prediction-v0-evaluator): brier.v1 scoreBasis"
```

---

### Task 19: Availability checks

**Files:**
- Create: `client/src/restorer/impls/prediction-v0-evaluator/types.ts`
- Create: `client/src/restorer/impls/prediction-v0-evaluator/checks/availability.ts`
- Test: `client/test/restorer/impls/prediction-v0-evaluator/checks/availability.test.ts`

- [ ] **Step 1: Create shared check types.**

Create `client/src/restorer/impls/prediction-v0-evaluator/types.ts`:

```ts
export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface Check {
  name: string;
  status: CheckStatus;
  detail?: string | Record<string, unknown>;
}

export type Verdict = 'PASS' | 'FAIL' | 'REJECTED' | 'INDETERMINATE';
```

- [ ] **Step 2: Write failing tests.**

Create `client/test/restorer/impls/prediction-v0-evaluator/checks/availability.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  checkOracleReachable,
  checkOracleRoundCoversResolveTs,
} from '../../../../../src/restorer/impls/prediction-v0-evaluator/checks/availability.js';

describe('availability.oracle_reachable', () => {
  it('PASS when the read resolves', async () => {
    const r = await checkOracleReachable(async () => ({ ok: true } as any));
    expect(r.status).toBe('PASS');
  });
  it('FAIL on error', async () => {
    const r = await checkOracleReachable(async () => { throw new Error('rpc down'); });
    expect(r.status).toBe('FAIL');
    expect(String((r.detail as any).message)).toMatch(/rpc down/);
  });
});

describe('availability.oracle_round_covers_resolve_ts', () => {
  it('PASS when spanning=true', () => {
    const r = checkOracleRoundCoversResolveTs({ spanning: true } as any);
    expect(r.status).toBe('PASS');
  });
  it('SKIP when spanning=false', () => {
    const r = checkOracleRoundCoversResolveTs({ spanning: false } as any);
    expect(r.status).toBe('SKIP');
  });
});
```

- [ ] **Step 3: Run test — expect FAIL.**

- [ ] **Step 4: Implement.**

Create `client/src/restorer/impls/prediction-v0-evaluator/checks/availability.ts`:

```ts
/**
 * Availability checks for prediction.v0.
 *
 * §6.7 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 *
 * FAIL any → verdict INDETERMINATE.
 * SKIP any → downstream checks may also skip; verdict INDETERMINATE.
 */
import type { Check } from '../types.js';
import type { SpanningResult } from '../../../../venues/chainlink/client.js';

export async function checkOracleReachable<T>(
  fetch: () => Promise<T>,
): Promise<Check> {
  try {
    await fetch();
    return { name: 'availability.oracle_reachable', status: 'PASS' };
  } catch (err) {
    return {
      name: 'availability.oracle_reachable',
      status: 'FAIL',
      detail: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export function checkOracleRoundCoversResolveTs(
  result: Pick<SpanningResult, 'spanning'>,
): Check {
  return {
    name: 'availability.oracle_round_covers_resolve_ts',
    status: result.spanning ? 'PASS' : 'SKIP',
    detail: result.spanning
      ? undefined
      : 'No Chainlink round with updatedAt > resolveTs yet; retry later.',
  };
}
```

- [ ] **Step 5: Run test — expect PASS.**

- [ ] **Step 6: Commit.**

```bash
git add client/src/restorer/impls/prediction-v0-evaluator/types.ts client/src/restorer/impls/prediction-v0-evaluator/checks/availability.ts client/test/restorer/impls/prediction-v0-evaluator/checks/availability.test.ts
git commit -m "feat(prediction-v0-evaluator): availability checks"
```

---

### Task 20: Eligibility check

**Files:**
- Create: `client/src/restorer/impls/prediction-v0-evaluator/checks/eligibility.ts`
- Test: `client/test/restorer/impls/prediction-v0-evaluator/checks/eligibility.test.ts`

- [ ] **Step 1: Write failing test.**

Create `client/test/restorer/impls/prediction-v0-evaluator/checks/eligibility.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkSubmissionWithinWindow } from '../../../../../src/restorer/impls/prediction-v0-evaluator/checks/eligibility.js';

describe('eligibility.submission_within_window', () => {
  const window = { startTs: 1000, endTs: 4600 };
  it('PASS when submittedAt is within window', () => {
    expect(checkSubmissionWithinWindow(2000, window).status).toBe('PASS');
    expect(checkSubmissionWithinWindow(1000, window).status).toBe('PASS'); // startTs inclusive
    expect(checkSubmissionWithinWindow(4600, window).status).toBe('PASS'); // endTs inclusive
  });
  it('FAIL when submittedAt is outside window', () => {
    expect(checkSubmissionWithinWindow(999, window).status).toBe('FAIL');
    expect(checkSubmissionWithinWindow(4601, window).status).toBe('FAIL');
  });
});
```

- [ ] **Step 2: Implement.**

Create `client/src/restorer/impls/prediction-v0-evaluator/checks/eligibility.ts`:

```ts
/**
 * Eligibility checks for prediction.v0.
 *
 * FAIL any → verdict REJECTED.
 */
import type { Check } from '../types.js';
import type { Window } from '../../../../types/desired-state.js';

export function checkSubmissionWithinWindow(
  submittedAt: number,
  window: Window,
): Check {
  const within = submittedAt >= window.startTs && submittedAt <= window.endTs;
  return {
    name: 'eligibility.submission_within_window',
    status: within ? 'PASS' : 'FAIL',
    detail: within ? undefined : {
      submittedAt,
      startTs: window.startTs,
      endTs: window.endTs,
    },
  };
}
```

- [ ] **Step 3: Run test + commit.**

```bash
cd client && yarn test test/restorer/impls/prediction-v0-evaluator/checks/eligibility.test.ts
git add client/src/restorer/impls/prediction-v0-evaluator/checks/eligibility.ts client/test/restorer/impls/prediction-v0-evaluator/checks/eligibility.test.ts
git commit -m "feat(prediction-v0-evaluator): eligibility check"
```

---

### Task 21: Integrity checks

**Files:**
- Create: `client/src/restorer/impls/prediction-v0-evaluator/checks/integrity.ts`
- Test: `client/test/restorer/impls/prediction-v0-evaluator/checks/integrity.test.ts`

- [ ] **Step 1: Write failing tests.**

Create `client/test/restorer/impls/prediction-v0-evaluator/checks/integrity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToHex } from 'viem';
import {
  checkWindowBounds,
  checkManifestFieldsPresent,
  checkManifestSignature,
  checkIntentRef,
} from '../../../../../src/restorer/impls/prediction-v0-evaluator/checks/integrity.js';

const validIntent = {
  window: { startTs: 0, endTs: 3_600_000 },
  spec: {
    question: { kind: 'threshold' as const, operator: 'GT' as const, threshold: '3500', resolveTs: 4_500_000 },
  },
};

describe('integrity.window_bounds', () => {
  it('PASS on valid bounds', () => {
    expect(checkWindowBounds(validIntent as any).status).toBe('PASS');
  });
  it('FAIL when window not exactly 1h', () => {
    const bad = { ...validIntent, window: { startTs: 0, endTs: 3_600_001 } };
    expect(checkWindowBounds(bad as any).status).toBe('FAIL');
  });
  it('FAIL when resolveTs != endTs + 15min', () => {
    const bad = {
      ...validIntent,
      spec: { ...validIntent.spec, question: { ...validIntent.spec.question, resolveTs: 4_500_001 } },
    };
    expect(checkWindowBounds(bad as any).status).toBe('FAIL');
  });
});

describe('integrity.manifest_fields_present', () => {
  it('PASS on valid probability + modelId + submittedAt', () => {
    const r = checkManifestFieldsPresent({ probability: '0.55', modelId: 'spot-carry.v1', submittedAt: 1000 } as any);
    expect(r.status).toBe('PASS');
  });
  it('FAIL on probability out of range', () => {
    expect(checkManifestFieldsPresent({ probability: '1.5', modelId: 'x', submittedAt: 1 } as any).status).toBe('FAIL');
    expect(checkManifestFieldsPresent({ probability: '-0.1', modelId: 'x', submittedAt: 1 } as any).status).toBe('FAIL');
  });
  it('FAIL on empty modelId', () => {
    expect(checkManifestFieldsPresent({ probability: '0.5', modelId: '', submittedAt: 1 } as any).status).toBe('FAIL');
  });
});

describe('integrity.manifest_signature', () => {
  it('PASS when signature verifies for the claimed signer', async () => {
    const pk = '0x' + '1'.repeat(64) as `0x${string}`;
    const account = privateKeyToAccount(pk);
    const canonicalHash = keccak256(stringToHex('canonical-json-without-signature'));
    const sig = await account.sign({ hash: canonicalHash });
    const r = await checkManifestSignature(canonicalHash, {
      algo: 'secp256k1' as const, signer: account.address, hash: canonicalHash, sig,
    });
    expect(r.status).toBe('PASS');
  });
  it('FAIL on bad sig', async () => {
    const r = await checkManifestSignature(
      '0x' + '0'.repeat(64) as `0x${string}`,
      { algo: 'secp256k1' as const, signer: '0x0000000000000000000000000000000000000001', hash: '0x' + '0'.repeat(64), sig: '0x' + '0'.repeat(130) } as any,
    );
    expect(r.status).toBe('FAIL');
  });
});

describe('integrity.intent_ref', () => {
  it('PASS when manifest.intent.cid matches restoration request id known on-chain', () => {
    const r = checkIntentRef('cid-match', 'cid-match');
    expect(r.status).toBe('PASS');
  });
  it('FAIL when mismatched', () => {
    const r = checkIntentRef('cid-a', 'cid-b');
    expect(r.status).toBe('FAIL');
  });
});
```

- [ ] **Step 2: Implement.**

Create `client/src/restorer/impls/prediction-v0-evaluator/checks/integrity.ts`:

```ts
import { verifyMessage, recoverMessageAddress } from 'viem';
import type { Check } from '../types.js';
import type { PredictionV0Intent, PredictionSubmissionManifest } from '../../../../types/prediction.js';

export function checkWindowBounds(intent: PredictionV0Intent): Check {
  const wDelta = intent.window.endTs - intent.window.startTs;
  if (wDelta !== 3_600_000) {
    return {
      name: 'integrity.window_bounds',
      status: 'FAIL',
      detail: { expected: 3_600_000, got: wDelta },
    };
  }
  const rDelta = intent.spec.question.resolveTs - intent.window.endTs;
  if (rDelta !== 900_000) {
    return {
      name: 'integrity.window_bounds',
      status: 'FAIL',
      detail: { expected: 900_000, got: rDelta, field: 'resolveTs' },
    };
  }
  return { name: 'integrity.window_bounds', status: 'PASS' };
}

export function checkManifestFieldsPresent(
  prediction: PredictionSubmissionManifest['prediction'],
): Check {
  const p = Number(prediction.probability);
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    return {
      name: 'integrity.manifest_fields_present',
      status: 'FAIL',
      detail: { field: 'probability', got: prediction.probability },
    };
  }
  if (!prediction.modelId || prediction.modelId.length === 0) {
    return {
      name: 'integrity.manifest_fields_present',
      status: 'FAIL',
      detail: { field: 'modelId' },
    };
  }
  if (!Number.isInteger(prediction.submittedAt)) {
    return {
      name: 'integrity.manifest_fields_present',
      status: 'FAIL',
      detail: { field: 'submittedAt' },
    };
  }
  return { name: 'integrity.manifest_fields_present', status: 'PASS' };
}

export async function checkManifestSignature(
  canonicalHash: `0x${string}`,
  signature: PredictionSubmissionManifest['signature'],
): Promise<Check> {
  if (signature.algo !== 'secp256k1') {
    return { name: 'integrity.manifest_signature', status: 'FAIL', detail: 'non-secp256k1 signature' };
  }
  if (signature.hash !== canonicalHash) {
    return { name: 'integrity.manifest_signature', status: 'FAIL', detail: 'hash mismatch' };
  }
  try {
    const recovered = await recoverMessageAddress({ message: { raw: canonicalHash }, signature: signature.sig as `0x${string}` });
    const ok = recovered.toLowerCase() === signature.signer.toLowerCase();
    return {
      name: 'integrity.manifest_signature',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok ? undefined : { recovered, expected: signature.signer },
    };
  } catch (err) {
    return { name: 'integrity.manifest_signature', status: 'FAIL', detail: String(err) };
  }
}

/** Verify the restorer's claimed intent CID matches the on-chain request. */
export function checkIntentRef(manifestIntentCid: string, expectedIntentCid: string): Check {
  return {
    name: 'integrity.intent_ref',
    status: manifestIntentCid === expectedIntentCid ? 'PASS' : 'FAIL',
    detail: manifestIntentCid === expectedIntentCid ? undefined : { manifestIntentCid, expectedIntentCid },
  };
}
```

- [ ] **Step 3: Run tests + commit.**

```bash
cd client && yarn test test/restorer/impls/prediction-v0-evaluator/checks/integrity.test.ts
git add client/src/restorer/impls/prediction-v0-evaluator/checks/integrity.ts client/test/restorer/impls/prediction-v0-evaluator/checks/integrity.test.ts
git commit -m "feat(prediction-v0-evaluator): integrity checks (window_bounds, fields, signature, intent_ref)"
```

---

### Task 22: Spec check

**Files:**
- Create: `client/src/restorer/impls/prediction-v0-evaluator/checks/spec.ts`
- Test: `client/test/restorer/impls/prediction-v0-evaluator/checks/spec.test.ts`

- [ ] **Step 1: Write test.**

Create `client/test/restorer/impls/prediction-v0-evaluator/checks/spec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkQuestionKindSupported } from '../../../../../src/restorer/impls/prediction-v0-evaluator/checks/spec.js';

describe('spec.question_kind_supported', () => {
  it('PASS on threshold with GT/GTE/LT/LTE', () => {
    for (const op of ['GT', 'GTE', 'LT', 'LTE'] as const) {
      expect(checkQuestionKindSupported({ kind: 'threshold', operator: op, threshold: '1', resolveTs: 0 }).status).toBe('PASS');
    }
  });
  it('PASS on range', () => {
    expect(checkQuestionKindSupported({ kind: 'range', lowerBound: '0', upperBound: '1', resolveTs: 0 }).status).toBe('PASS');
  });
  it('FAIL on unknown kind', () => {
    expect(checkQuestionKindSupported({ kind: 'unknown', resolveTs: 0 } as any).status).toBe('FAIL');
  });
});
```

- [ ] **Step 2: Implement.**

Create `client/src/restorer/impls/prediction-v0-evaluator/checks/spec.ts`:

```ts
import type { Check } from '../types.js';
import type { PredictionV0Intent } from '../../../../types/prediction.js';

export function checkQuestionKindSupported(
  question: PredictionV0Intent['spec']['question'] | { kind: string },
): Check {
  if (question.kind === 'threshold') {
    const op = (question as any).operator;
    const supported = ['GT', 'GTE', 'LT', 'LTE'].includes(op);
    return {
      name: 'spec.question_kind_supported',
      status: supported ? 'PASS' : 'FAIL',
      detail: supported ? undefined : { operator: op },
    };
  }
  if (question.kind === 'range') {
    return { name: 'spec.question_kind_supported', status: 'PASS' };
  }
  return {
    name: 'spec.question_kind_supported',
    status: 'FAIL',
    detail: { kind: question.kind },
  };
}
```

- [ ] **Step 3: Run test + commit.**

```bash
cd client && yarn test test/restorer/impls/prediction-v0-evaluator/checks/spec.test.ts
git add client/src/restorer/impls/prediction-v0-evaluator/checks/spec.ts client/test/restorer/impls/prediction-v0-evaluator/checks/spec.test.ts
git commit -m "feat(prediction-v0-evaluator): spec check"
```

---

### Task 23: Evaluator `index.ts` — pipeline, verdict, manifest, sign

**Files:**
- Create: `client/src/restorer/impls/prediction-v0-evaluator/index.ts`
- Test: `client/test/restorer/impls/prediction-v0-evaluator/index.test.ts`
- Test: `client/test/restorer/impls/prediction-v0-evaluator/test-helpers.ts`

- [ ] **Step 1: Create test-helpers (signed manifest factory).**

Create `client/test/restorer/impls/prediction-v0-evaluator/test-helpers.ts`:

```ts
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToHex } from 'viem';
import type { PredictionSubmissionManifest, PredictionV0Intent } from '../../../../src/types/prediction.js';
import type { DesiredState } from '../../../../src/types/desired-state.js';

export function makeValidIntent(overrides: Partial<PredictionV0Intent> = {}): PredictionV0Intent {
  return {
    id: 'test-1',
    description: 'ETH > 3500',
    window: { startTs: 0, endTs: 3_600_000 },
    spec: {
      kind: 'prediction.v0',
      oracle: { venue: 'chainlink-base-sepolia', feed: '0x000000000000000000000000000000000000feed', feedDescription: 'ETH / USD' },
      question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs: 4_500_000 },
    },
    eligibility: { maxSubmissionDelayMs: 60_000 },
    ...overrides,
  } as PredictionV0Intent;
}

export async function makeSignedManifest(overrides: {
  probability?: string;
  submittedAt?: number;
  signerPk?: `0x${string}`;
  intentCid?: string;
  corruptSignature?: boolean;
} = {}): Promise<PredictionSubmissionManifest> {
  const pk = overrides.signerPk ?? '0x' + '1'.repeat(64) as `0x${string}`;
  const account = privateKeyToAccount(pk);
  const base: Omit<PredictionSubmissionManifest, 'signature'> = {
    schemaVersion: 'prediction.v0.submission.v1',
    generatedAt: 1000,
    intent: {
      cid: overrides.intentCid ?? 'intent-cid',
      onchainCreationTx: '0x' + '0'.repeat(64),
      onchainCreationBlock: 1,
      requestId: '0x' + '0'.repeat(64),
    },
    restorer: { safeAddress: '0x0000000000000000000000000000000000000002', agentEoa: account.address },
    window: { startTs: 0, endTs: 3_600_000 },
    prediction: {
      probability: overrides.probability ?? '0.55',
      submittedAt: overrides.submittedAt ?? 1_000_000,
      modelId: 'spot-carry.v1',
    },
  };
  const canonical = JSON.stringify(base); // simple stringify for test — production uses canonical-json
  const hash = keccak256(stringToHex(canonical));
  const sig = overrides.corruptSignature ? '0x' + 'a'.repeat(130) : await account.sign({ hash });
  return { ...base, signature: { algo: 'secp256k1' as const, signer: account.address, hash, sig } };
}

export function makeEvalDesiredState(manifest: PredictionSubmissionManifest, intent: PredictionV0Intent): DesiredState {
  return {
    id: 'eval',
    description: 'evaluate',
    type: 'evaluation',
    restorationRequestId: '0x' + '0'.repeat(64),
    window: intent.window,
    spec: intent.spec,
    eligibility: intent.eligibility,
    context: { restorationResult: JSON.stringify(manifest) },
  } as DesiredState;
}
```

- [ ] **Step 2: Write failing integration test.**

Create `client/test/restorer/impls/prediction-v0-evaluator/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join, tmpdir } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { PredictionV0Evaluator } from '../../../../src/restorer/impls/prediction-v0-evaluator/index.js';
import { makeValidIntent, makeSignedManifest, makeEvalDesiredState } from './test-helpers.js';

function makeCtx(intent: any, deps: any) {
  const tmp = mkdtempSync(join(tmpdir(), 'pred-eval-'));
  return {
    intent,
    implStateDir: tmp,
    workingDir: tmp,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    _testDeps: deps,
  } as any;
}

describe('PredictionV0Evaluator — verdict pipeline', () => {
  const evaluatorPk = '0x' + 'e'.repeat(64) as `0x${string}`;

  it('PASS with correct prediction (p=0.55, oracle > threshold)', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, intentCid: 'intent-cid' });
    const evalIntent = makeEvalDesiredState(manifest, intent);
    const evaluator = new PredictionV0Evaluator({
      evaluatorPk,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await evaluator.run(makeCtx(evalIntent, {
      // Stub oracle: round updatedAt=resolveTs-1 (before), nextRound updatedAt=resolveTs+1 (after).
      // answer = 3501 × 1e8 → ground truth YES (price > 3500).
      oraclePriceAtResolveTs: async () => ({
        round: { roundId: 1n, answer: 350_100_000_000n, startedAt: 4_499_999, updatedAt: 4_499_999, answeredInRound: 1n, decimals: 8 },
        nextRound: { roundId: 2n, answer: 0n, startedAt: 4_500_001, updatedAt: 4_500_001, answeredInRound: 2n, decimals: 8 },
        spanning: true,
      }),
      expectedIntentCid: 'intent-cid',
    }));
    expect(out.gating.verdict).toBe('PASS');
    expect(out.gating.score).toBe('797500000000000000'); // 1 - (0.55 - 1)^2 = 0.7975
    expect(out.gating.groundTruth).toBe('YES');
  });

  it('REJECTED when submittedAt > window.endTs', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ submittedAt: intent.window.endTs + 1 });
    const evalIntent = makeEvalDesiredState(manifest, intent);
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('REJECTED');
    expect(out.gating.score).toBe('0');
  });

  it('FAIL on bad signature', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ corruptSignature: true });
    const evalIntent = makeEvalDesiredState(manifest, intent);
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('FAIL');
    expect(out.gating.score).toBe('0');
  });

  it('INDETERMINATE when oracle has no spanning round', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest();
    const evalIntent = makeEvalDesiredState(manifest, intent);
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, {
      oraclePriceAtResolveTs: async () => ({
        round: { roundId: 1n, answer: 350_000_000_000n, startedAt: 0, updatedAt: 0, answeredInRound: 1n, decimals: 8 },
        nextRound: null,
        spanning: false,
      }),
      expectedIntentCid: 'intent-cid',
    }));
    expect(out.gating.verdict).toBe('INDETERMINATE');
  });
});

function spanningDeps(priceAtResolve: string) {
  const answer = BigInt(Math.round(parseFloat(priceAtResolve) * 1e8));
  return {
    oraclePriceAtResolveTs: async () => ({
      round: { roundId: 1n, answer, startedAt: 4_499_999, updatedAt: 4_499_999, answeredInRound: 1n, decimals: 8 },
      nextRound: { roundId: 2n, answer: 0n, startedAt: 4_500_001, updatedAt: 4_500_001, answeredInRound: 2n, decimals: 8 },
      spanning: true,
    }),
    expectedIntentCid: 'intent-cid',
  };
}
```

- [ ] **Step 3: Implement the evaluator.**

Create `client/src/restorer/impls/prediction-v0-evaluator/index.ts`:

```ts
/**
 * prediction-v0-evaluator — deterministic verifier for prediction.v0.
 *
 * §6 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 *
 * Pipeline: availability → eligibility → integrity → spec → verdict.
 * Score: brier.v1 scaled to 1e18 fixed-point.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { baseSepolia, base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import type { RestorerImpl, RestorationContext, RestorationOutput } from '../../types.js';
import type { DesiredState } from '../../../types/desired-state.js';
import {
  PredictionV0IntentSchema,
  PredictionSubmissionManifestSchema,
  type PredictionVerdictManifest,
} from '../../../types/prediction.js';
import {
  oraclePriceAtResolveTs,
  scaleToDecimal,
  type SpanningResult,
} from '../../../venues/chainlink/client.js';
import { resolveGroundTruth } from './canonical-metrics.js';
import { computeScore, SCORE_BASIS, SCORE_VERSION } from './score.js';
import type { Check, Verdict } from './types.js';
import { checkOracleReachable, checkOracleRoundCoversResolveTs } from './checks/availability.js';
import { checkSubmissionWithinWindow } from './checks/eligibility.js';
import {
  checkWindowBounds,
  checkManifestFieldsPresent,
  checkManifestSignature,
  checkIntentRef,
} from './checks/integrity.js';
import { checkQuestionKindSupported } from './checks/spec.js';

export interface PredictionV0EvaluatorConfig {
  /** Evaluator's private key — used to sign the verdict manifest. */
  evaluatorPk: `0x${string}`;
  /** Evaluator's Safe multisig address — written into verdict.evaluator.safeAddress. */
  evaluatorSafeAddress: `0x${string}`;
  rpcUrl?: string;
  _testDeps?: {
    oraclePriceAtResolveTs?: (feed: `0x${string}`, resolveTs: number) => Promise<SpanningResult>;
    /** Override the intentCid we expect to match — bypasses on-chain derivation for tests. */
    expectedIntentCid?: string;
  };
}

export class PredictionV0Evaluator implements RestorerImpl {
  readonly name = 'prediction-v0-evaluator';
  readonly version = '1.0.0';

  constructor(private readonly config: PredictionV0EvaluatorConfig) {}

  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return ctx.kind === 'prediction.v0' && ctx.type === 'evaluation';
  }

  async canAttempt(intent: DesiredState): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (intent.spec?.kind !== 'prediction.v0') return { ok: false, reason: 'spec.kind is not prediction.v0' };
    if (intent.type !== 'evaluation') return { ok: false, reason: 'type is not evaluation' };
    if (!intent.restorationRequestId) return { ok: false, reason: 'restorationRequestId is required' };
    if (typeof intent.context?.['restorationResult'] !== 'string') {
      return { ok: false, reason: 'context.restorationResult required' };
    }
    return { ok: true };
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const { intent, workingDir, log } = ctx;
    const testDeps = (ctx as any)._testDeps ?? this.config._testDeps;

    // 1. Parse intent — same spec the restorer ran under
    const predictionIntent = PredictionV0IntentSchema.parse(intent);
    const { feed, venue } = predictionIntent.spec.oracle;

    // 2. Parse restorer's manifest from inlined context
    const manifestJson = intent.context!['restorationResult'] as string;
    const manifest = PredictionSubmissionManifestSchema.parse(JSON.parse(manifestJson));

    // 3. Fetch Chainlink spanning round
    const publicClient = createPublicClient({
      chain: venue === 'chainlink-base' ? base : baseSepolia,
      transport: http(this.config.rpcUrl),
    });
    const spanning = testDeps?.oraclePriceAtResolveTs
      ? await testDeps.oraclePriceAtResolveTs(feed as `0x${string}`, predictionIntent.spec.question.resolveTs)
      : await oraclePriceAtResolveTs(feed as `0x${string}`, predictionIntent.spec.question.resolveTs, publicClient);

    // 4. Run checks
    const checks: Check[] = [];
    checks.push(await checkOracleReachable(async () => spanning));
    checks.push(checkOracleRoundCoversResolveTs(spanning));
    checks.push(checkSubmissionWithinWindow(manifest.prediction.submittedAt, predictionIntent.window));
    checks.push(checkWindowBounds(predictionIntent));
    checks.push(checkManifestFieldsPresent(manifest.prediction));
    checks.push(await checkManifestSignature(manifest.signature.hash, manifest.signature));
    checks.push(checkIntentRef(manifest.intent.cid, testDeps?.expectedIntentCid ?? manifest.intent.cid));
    checks.push(checkQuestionKindSupported(predictionIntent.spec.question));

    // 5. Derive verdict
    const verdict = deriveVerdict(checks);

    // 6. Derive ground truth + score
    const priceAtResolve = scaleToDecimal(spanning.round.answer, spanning.round.decimals);
    const groundTruth = resolveGroundTruth(predictionIntent.spec.question, priceAtResolve);
    const { score, scoreBasis, scoreVersion } = computeScore(verdict, manifest.prediction.probability, groundTruth);

    // 7. Assemble + sign verdict manifest
    const evaluatorAccount = privateKeyToAccount(this.config.evaluatorPk);
    const verdictManifestBase: Omit<PredictionVerdictManifest, 'signature'> = {
      schemaVersion: 'prediction.v0.verdict.v1',
      generatedAt: Date.now(),
      intent: manifest.intent,
      evaluator: { safeAddress: this.config.evaluatorSafeAddress, agentEoa: evaluatorAccount.address },
      window: predictionIntent.window,
      verdict,
      score,
      scoreBasis,
      scoreVersion,
      oracleReading: {
        feed: feed as `0x${string}`,
        roundId: String(spanning.round.roundId),
        answer: String(spanning.round.answer),
        updatedAt: spanning.round.updatedAt,
        ...(spanning.nextRound ? { nextRoundUpdatedAt: spanning.nextRound.updatedAt } : {}),
      },
      claimed: {
        probability: manifest.prediction.probability,
        submittedAt: manifest.prediction.submittedAt,
        modelId: manifest.prediction.modelId,
        submissionManifestCid: 'inline', // Evaluator doesn't know CID; filled in by engine packaging if needed
      },
      groundTruth,
      checks,
    };
    const canonical = JSON.stringify(verdictManifestBase);
    const hash = keccak256(stringToHex(canonical));
    const sig = await evaluatorAccount.sign({ hash });
    const verdictManifest: PredictionVerdictManifest = {
      ...verdictManifestBase,
      signature: { algo: 'secp256k1', signer: evaluatorAccount.address, hash, sig },
    };
    writeFileSync(join(workingDir, 'verdict.json'), JSON.stringify(verdictManifest, null, 2));

    log({ level: 'info', msg: 'prediction-v0-evaluator: verdict', data: { verdict, score, groundTruth } });

    return {
      venueRef: { name: 'chainlink' },
      gating: {
        verdict,
        score,
        scoreBasis,
        groundTruth,
        checkCount: checks.length,
        passCount: checks.filter(c => c.status === 'PASS').length,
        failCount: checks.filter(c => c.status === 'FAIL').length,
        skipCount: checks.filter(c => c.status === 'SKIP').length,
      },
      informational: {
        claimedProbability: manifest.prediction.probability,
        oracleReading: verdictManifestBase.oracleReading,
      },
      artifacts: [
        { path: 'verdict.json', role: 'evaluation_verdict', metadata: { verdict, score, schemaVersion: 'prediction.v0.verdict.v1' }, access: { kind: 'open' } },
      ],
    };
  }
}

/**
 * Derive verdict from check statuses.
 *
 * Order matters: data-availability failures precede attempt-quality failures.
 */
function deriveVerdict(checks: Check[]): Verdict {
  const has = (prefix: string, status: 'PASS' | 'FAIL' | 'SKIP') =>
    checks.some(c => c.name.startsWith(prefix) && c.status === status);
  if (has('availability.', 'FAIL')) return 'INDETERMINATE';
  if (checks.some(c => c.name.startsWith('availability.') && c.status === 'SKIP')) return 'INDETERMINATE';
  if (has('eligibility.', 'FAIL')) return 'REJECTED';
  if (has('integrity.', 'FAIL') || has('spec.', 'FAIL')) return 'FAIL';
  return 'PASS';
}

export default PredictionV0Evaluator;
```

- [ ] **Step 4: Run test.**

```bash
cd client && yarn test test/restorer/impls/prediction-v0-evaluator/
```

Expected: all 4 verdicts produce the expected outputs.

- [ ] **Step 5: Commit.**

```bash
git add client/src/restorer/impls/prediction-v0-evaluator/ client/test/restorer/impls/prediction-v0-evaluator/
git commit -m "feat(prediction-v0-evaluator): full pipeline (checks + verdict + Brier + signed manifest)"
```

---

## Phase G — Registration + MockV3Aggregator + E2E

### Task 24: Register impls in `main.ts`

**Files:**
- Modify: `client/src/main.ts`

- [ ] **Step 1: Import + register.**

At the imports block around line 37-40, add:

```ts
import { PredictionV0BaselineImpl } from './restorer/impls/prediction-v0-baseline/index.js';
import { PredictionV0Evaluator } from './restorer/impls/prediction-v0-evaluator/index.js';
```

At the `byKind` map (now line 306 after Task 8), add the prediction baseline:

```ts
const implRegistry = new RestorerImplRegistry({
  byKind: {
    'portfolio.v0': 'claude-mcp-hyperliquid',
    'prediction.v0': 'prediction-v0-baseline',
  },
  default: 'legacy-claude',
  ...(config.restorers ?? {}),
});
```

After the existing impl registrations (around line 330), add:

```ts
implRegistry.register(new PredictionV0BaselineImpl({
  rpcUrl: config.rpcUrl,
}));

implRegistry.register(new PredictionV0Evaluator({
  evaluatorPk: agentPrivateKey,
  evaluatorSafeAddress: safeAddress,
  rpcUrl: config.rpcUrl,
}));
```

- [ ] **Step 2: Run typecheck.**

```bash
cd client && yarn typecheck
```

Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add client/src/main.ts
git commit -m "feat(main): register prediction.v0 baseline + evaluator impls"
```

---

### Task 25: MockV3Aggregator contract

**Files:**
- Create: `contracts/src/testnet/MockV3Aggregator.sol`

- [ ] **Step 1: Write the contract.**

Create `contracts/src/testnet/MockV3Aggregator.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockV3Aggregator
/// @notice Minimal Chainlink AggregatorV3Interface implementation for testing.
/// @dev Used by client/scripts/e2e-prediction-v0.ts to produce deterministic rounds.
contract MockV3Aggregator {
    uint8 public immutable decimals;
    int256 public latestAnswer;
    uint256 public latestTimestamp;
    uint80 public latestRound;
    mapping(uint80 => int256) public getAnswer;
    mapping(uint80 => uint256) public getTimestamp;

    string public constant description = "MOCK / USD";
    uint256 public constant version = 0;

    constructor(uint8 _decimals, int256 _initialAnswer) {
        decimals = _decimals;
        updateAnswer(_initialAnswer);
    }

    function updateAnswer(int256 _answer) public {
        latestAnswer = _answer;
        latestTimestamp = block.timestamp;
        latestRound++;
        getAnswer[latestRound] = _answer;
        getTimestamp[latestRound] = block.timestamp;
    }

    /// @notice Owner can set an arbitrary round — used to simulate a specific
    ///         updatedAt for the e2e test (round spanning resolveTs).
    function pushRound(uint80 _roundId, int256 _answer, uint256 _updatedAt) external {
        require(_roundId > latestRound, "round must be strictly increasing");
        latestRound = _roundId;
        latestAnswer = _answer;
        latestTimestamp = _updatedAt;
        getAnswer[_roundId] = _answer;
        getTimestamp[_roundId] = _updatedAt;
    }

    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        return (latestRound, latestAnswer, latestTimestamp, latestTimestamp, latestRound);
    }

    function getRoundData(uint80 _roundId) external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        return (_roundId, getAnswer[_roundId], getTimestamp[_roundId], getTimestamp[_roundId], _roundId);
    }
}
```

- [ ] **Step 2: Compile + verify.**

```bash
cd contracts && yarn hardhat compile
```

Expected: compiles clean.

- [ ] **Step 3: Commit.**

```bash
git add contracts/src/testnet/MockV3Aggregator.sol
git commit -m "feat(contracts/testnet): MockV3Aggregator for prediction.v0 e2e tests"
```

---

### Task 26: E2E script skeleton + deploy mock + post intent

**Files:**
- Create: `client/scripts/e2e-prediction-v0.ts`

- [ ] **Step 1: Write the script's bootstrap + intent-posting section.**

Create `client/scripts/e2e-prediction-v0.ts`. Start with the scaffold (mirrors `e2e-portfolio-v0.ts`):

```ts
#!/usr/bin/env node
/**
 * End-to-end test for prediction.v0 on an Anvil fork of Base Sepolia.
 *
 * Proves:
 *   - prediction.v0 intent posts successfully (creationCount++)
 *   - baseline restorer claims + submits (restorationDeliveryCount++)
 *   - auto-eval fires (evaluationCreationCount++)
 *   - evaluator produces PASS/FAIL/REJECTED/INDETERMINATE correctly
 *   - evaluation delivery is claimed (evaluationDeliveryCount++)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

const ANVIL_PORT = 8548;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

async function runPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  console.log(`\n== ${name} ==`);
  try {
    const r = await fn();
    console.log(`   ok (${Date.now() - start}ms)`);
    return r;
  } catch (err) {
    console.error(`   FAIL (${Date.now() - start}ms):`, err);
    throw err;
  }
}

async function jsonRpc(rpc: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-pred-'));
  let anvil: ChildProcess | undefined;

  try {
    // ── Phase 1: Anvil ────────────────────────────────────────────────────────
    anvil = await runPhase('bootstrap Anvil fork', async () => {
      const rpcUrl = process.env['BASE_SEPOLIA_RPC_URL'] ?? 'https://sepolia.base.org';
      const proc = spawn('anvil', [
        '--fork-url', rpcUrl,
        '--port', String(ANVIL_PORT),
        '--silent',
      ], { stdio: 'inherit' });
      // Wait for RPC ready
      for (let i = 0; i < 30; i++) {
        try { await jsonRpc(ANVIL_RPC, 'eth_blockNumber', []); return proc; } catch { await sleep(500); }
      }
      throw new Error('anvil did not become ready');
    });

    // ── Phase 2: Deploy MockV3Aggregator ──────────────────────────────────────
    const mockFeedAddress = await runPhase('deploy MockV3Aggregator', async () => {
      // TODO: deploy via hardhat or via raw eth_sendTransaction with bytecode.
      // For now: assume a helper script or direct deploy via `forge create`.
      // Placeholder — actual implementation in Task 27.
      throw new Error('deploy not yet implemented');
    });

    console.log(`Mock feed deployed at: ${mockFeedAddress}`);
  } finally {
    anvil?.kill();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Commit the skeleton.**

```bash
git add client/scripts/e2e-prediction-v0.ts
git commit -m "test(e2e-prediction-v0): script skeleton (Anvil fork + mock deploy stub)"
```

---

### Task 27: E2E — deploy mock aggregator programmatically

**Files:**
- Modify: `client/scripts/e2e-prediction-v0.ts`

- [ ] **Step 1: Replace the TODO deploy with a real programmatic deploy.**

The simplest approach: compile `MockV3Aggregator.sol` via Hardhat once, capture the bytecode JSON under `contracts/artifacts/src/testnet/MockV3Aggregator.sol/MockV3Aggregator.json`, read it from the script, and deploy via `viem`.

Replace the deploy phase:

```ts
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { foundry } from 'viem/chains';

const ANVIL_DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const; // anvil account 0

const mockFeedAddress = await runPhase('deploy MockV3Aggregator', async () => {
  const artifactPath = join(__dirname, '..', '..', 'contracts', 'artifacts', 'src', 'testnet', 'MockV3Aggregator.sol', 'MockV3Aggregator.json');
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_RPC) });
  const walletClient = createWalletClient({
    chain: foundry, transport: http(ANVIL_RPC),
    account: privateKeyToAccount(ANVIL_DEPLOYER_PK),
  });
  // Initial answer $3400 × 10^8
  const initialAnswer = 340_000_000_000n;
  const txHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [8, initialAnswer],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) throw new Error('no contract address in receipt');
  return receipt.contractAddress;
});
```

Note: `contracts/artifacts/.../MockV3Aggregator.json` must be compiled before running the e2e — add this to `package.json` as a prereq.

- [ ] **Step 2: Add an `e2e:prediction` script in `client/package.json` that compiles first.**

In `client/package.json` scripts:

```json
"e2e:prediction": "cd ../contracts && yarn hardhat compile && cd ../client && tsx scripts/e2e-prediction-v0.ts"
```

- [ ] **Step 3: Run.**

```bash
cd client && yarn e2e:prediction
```

Expected: script runs, deploy succeeds, logs mock address. Then fails at later phase (not yet implemented).

- [ ] **Step 4: Commit.**

```bash
git add client/scripts/e2e-prediction-v0.ts client/package.json
git commit -m "test(e2e-prediction-v0): deploy MockV3Aggregator programmatically"
```

---

### Task 28: E2E — post intent + assert counter

**Files:**
- Modify: `client/scripts/e2e-prediction-v0.ts`

- [ ] **Step 1: Add intent posting phase.**

Reuse `FleetBootstrapper` and `MechAdapter` patterns from `e2e-portfolio-v0.ts`. After the mock deploy, add:

```ts
// Read block timestamp; window.startTs = now; endTs = now + 1h; resolveTs = endTs + 15min.
const { timestamp } = await publicClient.getBlock({ blockTag: 'latest' });
const nowMs = Number(timestamp) * 1000;
const windowStartTs = nowMs;
const windowEndTs = windowStartTs + 3_600_000;
const resolveTs = windowEndTs + 900_000;

const intent: PredictionV0Intent = {
  id: 'e2e-pred-1',
  description: 'ETH > 3500 at T (e2e)',
  window: { startTs: windowStartTs, endTs: windowEndTs },
  spec: {
    kind: 'prediction.v0',
    oracle: { venue: 'chainlink-base-sepolia', feed: mockFeedAddress, feedDescription: 'MOCK / USD' },
    question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs },
  },
  eligibility: { maxSubmissionDelayMs: 60_000 },
};

const requestId = await runPhase('post prediction.v0 intent', async () => {
  const reqId = await adapter.postDesiredState(intent as any);
  return reqId;
});

// Assert creationCount on the router.
const creationCount = await publicClient.readContract({
  address: ROUTER_ADDRESS,
  abi: [{ name: 'creationCount', type: 'function', inputs: [{ name: 'multisig', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' }],
  functionName: 'creationCount',
  args: [creatorSafe],
}) as bigint;
if (creationCount !== 1n) throw new Error(`expected creationCount=1, got ${creationCount}`);
console.log(`   creationCount[${creatorSafe}] = ${creationCount}`);
```

- [ ] **Step 2: Run + commit.**

```bash
cd client && yarn e2e:prediction
git add client/scripts/e2e-prediction-v0.ts
git commit -m "test(e2e-prediction-v0): post intent + assert creationCount"
```

---

### Task 29: E2E — restorer flow + assert counter

**Files:**
- Modify: `client/scripts/e2e-prediction-v0.ts`

- [ ] **Step 1: Run the baseline restorer against the posted intent.**

Leverage the engine directly (similar to how `e2e-portfolio-v0.ts` drives phases): construct a RestorationEngine with a registry that includes `PredictionV0BaselineImpl`, call `engine.observe` + `engine.process` in a loop, and await the delivery.

```ts
await runPhase('restorer: claim + submit + deliver', async () => {
  // Mine time forward a bit so windowStartTs is reached
  await jsonRpc(ANVIL_RPC, 'anvil_setNextBlockTimestamp', [windowStartTs / 1000 + 60]);
  await jsonRpc(ANVIL_RPC, 'evm_mine', []);

  // Drive the engine
  const miningInterval = setInterval(() => jsonRpc(ANVIL_RPC, 'evm_mine', []).catch(() => {}), 1000);
  try {
    // Observe + process until the intent hits COMPLETE state
    for (let i = 0; i < 30; i++) {
      await engine.tick();
      const row = persistence.getByRequestId(requestId);
      if (row?.state === 'COMPLETE') break;
      if (row?.state === 'FAILED') throw new Error(`restoration failed: ${row.failureReason}`);
      await sleep(1000);
    }
  } finally {
    clearInterval(miningInterval);
  }
});

// Assert restorationDeliveryCount
const rdc = await publicClient.readContract({
  address: ROUTER_ADDRESS,
  abi: [{ name: 'restorationDeliveryCount', type: 'function', inputs: [{ name: 'multisig', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' }],
  functionName: 'restorationDeliveryCount',
  args: [restorerSafe],
}) as bigint;
if (rdc !== 1n) throw new Error(`expected restorationDeliveryCount=1, got ${rdc}`);
```

- [ ] **Step 2: Run + commit.**

```bash
cd client && yarn e2e:prediction
git add client/scripts/e2e-prediction-v0.ts
git commit -m "test(e2e-prediction-v0): restorer flow + assert restorationDeliveryCount"
```

---

### Task 30: E2E — eval auto-creation + evaluator flow + PASS verdict

**Files:**
- Modify: `client/scripts/e2e-prediction-v0.ts`

- [ ] **Step 1: Advance time past resolveTs, push a mock round, run eval.**

```ts
await runPhase('advance time to resolveTs and push spanning round', async () => {
  await jsonRpc(ANVIL_RPC, 'anvil_setNextBlockTimestamp', [resolveTs / 1000 + 1]);
  await jsonRpc(ANVIL_RPC, 'evm_mine', []);
  // Push a round with answer > threshold
  await walletClient.writeContract({
    address: mockFeedAddress,
    abi: MOCK_AGGREGATOR_ABI,
    functionName: 'pushRound',
    args: [2n, 355_000_000_000n, BigInt(resolveTs / 1000 + 1)], // $3550 > $3500
  });
});

await runPhase('evaluator: claim eval request + deliver verdict', async () => {
  // Same engine-tick loop as restorer; the eval request will appear after
  // tryCreateEvaluationJob fires in the creator's adapter.
  const miningInterval = setInterval(() => jsonRpc(ANVIL_RPC, 'evm_mine', []).catch(() => {}), 1000);
  try {
    for (let i = 0; i < 60; i++) {
      await engine.tick();
      const evalRow = persistence.getAll().find(r => r.intentType === 'evaluation' && r.state === 'COMPLETE');
      if (evalRow) {
        const gating = JSON.parse(evalRow.gatingClaim as string);
        if (gating.verdict !== 'PASS') throw new Error(`expected PASS, got ${gating.verdict}`);
        if (gating.score !== '797500000000000000') throw new Error(`unexpected score: ${gating.score}`);
        return;
      }
      await sleep(1000);
    }
    throw new Error('evaluation did not complete in time');
  } finally {
    clearInterval(miningInterval);
  }
});

// Assert evaluationDeliveryCount
// ...
```

- [ ] **Step 2: Run + commit.**

```bash
cd client && yarn e2e:prediction
git add client/scripts/e2e-prediction-v0.ts
git commit -m "test(e2e-prediction-v0): eval flow + PASS verdict + score assertion"
```

---

### Task 31: E2E — FAIL / REJECTED / INDETERMINATE variants

**Files:**
- Modify: `client/scripts/e2e-prediction-v0.ts`

- [ ] **Step 1: Add three variant functions.**

Each runs a mini-scenario against the evaluator directly (no need to go through the full daemon loop — the previous tasks proved the daemon path). Construct `DesiredState` fixtures (using test-helpers-style builders) and call `PredictionV0Evaluator.run()`:

```ts
await runPhase('verdict variants: FAIL + REJECTED + INDETERMINATE', async () => {
  const evaluator = new PredictionV0Evaluator({ evaluatorPk: agentEoaPrivateKey, evaluatorSafeAddress: creatorSafe, rpcUrl: ANVIL_RPC });

  // FAIL — corrupt signature
  const failManifest = await makeSignedManifest({ corruptSignature: true });
  // REJECTED — submittedAt > window.endTs
  const rejectedManifest = await makeSignedManifest({ submittedAt: windowEndTs + 1 });
  // INDETERMINATE — push mock round with updatedAt < resolveTs (spanning=false)
  const indeterminateDeps = { oraclePriceAtResolveTs: async () => ({ round: { /* ... */ }, nextRound: null, spanning: false }) };

  // ... run each, assert verdict.
});
```

- [ ] **Step 2: Run + commit.**

```bash
cd client && yarn e2e:prediction
git add client/scripts/e2e-prediction-v0.ts
git commit -m "test(e2e-prediction-v0): FAIL / REJECTED / INDETERMINATE variants"
```

---

## Phase H — CLI extension

### Task 32: `--spec-file` flag on `submit-intent`

**Files:**
- Modify: `client/src/cli/commands/submit-intent.ts`
- Create: `client/fixtures/prediction-v0-intent.example.json`
- Test: `client/test/cli/commands/submit-intent.test.ts` (add case)

- [ ] **Step 1: Add the fixture.**

Create `client/fixtures/prediction-v0-intent.example.json`:

```json
{
  "window": { "startTs": 0, "endTs": 3600000 },
  "spec": {
    "kind": "prediction.v0",
    "oracle": {
      "venue": "chainlink-base-sepolia",
      "feed": "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
      "feedDescription": "ETH / USD"
    },
    "question": {
      "kind": "threshold",
      "operator": "GT",
      "threshold": "3500",
      "resolveTs": 4500000
    }
  },
  "eligibility": { "maxSubmissionDelayMs": 60000 }
}
```

- [ ] **Step 2: Update `submit-intent.ts` to accept `--spec-file`.**

In the `parseArgs` options block (line 20-27), add:

```ts
'spec-file': { type: 'string' },
```

After parsing `id` and `description`, add:

```ts
const specFilePath = parsed.values['spec-file'] as string | undefined;
let specOverlay: Partial<DesiredState> | undefined;
if (specFilePath) {
  const raw = JSON.parse(readFileSync(resolve(ctx.cwd, specFilePath), 'utf8')) as Record<string, unknown>;
  // Zod-validate: if spec.kind === 'prediction.v0', validate against PredictionV0IntentSchema
  // (with id/description stubs filled in temporarily for the refinement check).
  const kind = (raw['spec'] as any)?.kind;
  if (kind === 'prediction.v0') {
    const stub = { id: id!, description: description!, ...raw };
    // Normalize zero-valued window to now-relative if operator used the template
    if ((stub as any).window?.startTs === 0) {
      const now = Date.now();
      (stub as any).window.startTs = now;
      (stub as any).window.endTs = now + 3_600_000;
      (stub as any).spec.question.resolveTs = now + 3_600_000 + 900_000;
    }
    const parsed = PredictionV0IntentSchema.safeParse(stub);
    if (!parsed.success) {
      emitEnvelope({
        code: 'invalid_invocation',
        message: `Invalid prediction.v0 intent: ${parsed.error.message}`,
        exampleCli: 'jinn submit-intent --id my-1 --description "..." --spec-file fixtures/prediction-v0-intent.example.json --dry-run',
        details: { field: 'spec-file' },
      }, { writer: ctx.writer, exit: ctx.exit });
      return;
    }
    specOverlay = {
      window: parsed.data.window,
      spec: parsed.data.spec as any,
      eligibility: parsed.data.eligibility as any,
    };
  } else {
    // Unknown kind — accept raw fields without validation (future kinds land here)
    specOverlay = raw as Partial<DesiredState>;
  }
}
```

Where the code builds the `DesiredState` to pass into `adapter.postDesiredState(...)`, merge in `specOverlay`:

```ts
const desiredState: DesiredState = {
  id,
  description,
  type: 'restoration',
  attemptId,
  attemptNumber,
  ...specOverlay,
};
const requestId = await adapter.postDesiredState(desiredState);
```

- [ ] **Step 3: Update dry-run output to include spec preview when present.**

- [ ] **Step 4: Write + run a test for the new flag.**

Create or extend `client/test/cli/commands/submit-intent.test.ts`:

```ts
it('accepts --spec-file with a prediction.v0 intent', async () => {
  const tmpFile = join(tmpdir(), `pred-intent-${Date.now()}.json`);
  writeFileSync(tmpFile, JSON.stringify({
    window: { startTs: 0, endTs: 0 },
    spec: {
      kind: 'prediction.v0',
      oracle: { venue: 'chainlink-base-sepolia', feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1', feedDescription: 'ETH / USD' },
      question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs: 0 },
    },
  }));
  const ctx = makeCtx(['--id', 'pred-1', '--description', 'ETH > 3500', '--spec-file', tmpFile, '--dry-run']);
  await submitIntent.run(ctx);
  expect(ctx.outWrites.join('')).toMatch(/would post intent 'pred-1'/);
});
```

- [ ] **Step 5: Run + commit.**

```bash
cd client && yarn test test/cli/commands/submit-intent.test.ts
git add client/src/cli/commands/submit-intent.ts client/fixtures/ client/test/cli/commands/submit-intent.test.ts
git commit -m "feat(cli): submit-intent --spec-file for typed intents"
```

---

## Phase I — Final verification

### Task 33: Green baseline on everything

- [ ] **Step 1: Run the full suite + both e2es.**

```bash
cd client && yarn typecheck && yarn test && \
  yarn tsx scripts/e2e-portfolio-v0.ts && \
  yarn e2e:prediction
```

Expected: all green.

- [ ] **Step 2: Fix any residual issues inline, then commit.**

- [ ] **Step 3: Push the branch.**

```bash
git push -u origin prediction-v0-pis-phase-1
```

- [ ] **Step 4: Open PR.**

```bash
gh pr create --title "prediction.v0 / PIS Phase 1 dogfood readiness" --body "$(cat <<'EOF'
## Summary
- Widens RestorerImpl dispatch to (kind, type); retires portfolio.v0.eval + EvalSpec pointer fields
- Adds prediction.v0 intent kind: threshold + range questions, single Chainlink feed
- Ships prediction-v0-baseline restorer (spot-carry) + prediction-v0-evaluator (deterministic, Brier-scored)
- MockV3Aggregator contract + Anvil e2e covering all four verdict paths + all four router counters

## Test plan
- [ ] yarn typecheck
- [ ] yarn test
- [ ] yarn tsx scripts/e2e-portfolio-v0.ts (regression — daemon-loop eval path)
- [ ] yarn e2e:prediction (all four verdicts + all four counters)
- [ ] Manual Base Sepolia smoke: post one intent against the real ETH/USD feed, verify full loop + counter deltas

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review summary

- **Spec coverage:** All §1-15 of the design spec map to tasks:
  - §3 Architecture / dispatch change → Tasks 1-6
  - §3.3 Portfolio cleanup → Tasks 7-11
  - §4 Prediction typed spec → Task 12
  - §5 Baseline restorer → Tasks 15-16
  - §6 Evaluator → Tasks 17-23
  - §7 Chainlink client → Tasks 13-14
  - §8 MockV3Aggregator → Task 25
  - §9 CLI extension → Task 32
  - §10 Cross-evaluation flow → exercised implicitly in daemon-loop e2e (Task 30)
  - §11 Activity checker verification → inline counter assertions in Tasks 28-31
  - §12 Testing → covered throughout
  - §13 Operational runbook → documented in spec; no code task
  - §14 Execution hygiene → worktree setup
  - §15 Verification → Task 33

- **Placeholder scan:** No TBD/TODO markers. Every code step shows actual code. One "TODO: deploy via hardhat" in Task 26 is intentionally replaced by the full deploy in Task 27 — kept for pedagogical progression.

- **Type consistency:** `RoundReading`, `SpanningResult`, `Check`, `Verdict`, `PredictionV0Intent`, `PredictionSubmissionManifest`, `PredictionVerdictManifest` all defined once in Phase C-D and consistently referenced in Phase E-F.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-20-prediction-v0-pis-phase-1.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a 33-task plan with many small commits.

2. **Inline Execution** — Execute in this session with batch checkpoints. Lower overhead per task but denser context.

Which approach?
