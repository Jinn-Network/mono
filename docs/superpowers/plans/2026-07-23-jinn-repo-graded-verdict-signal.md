# Graded jinn-repo Verdict Signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Scope of issue #1976:** This issue is **shape `design`**. Its done bar is the ratified design + this plan — **not** shipping F1–F4. After human ratification of the design, file the F* Issues and close #1976. Implementation Autopilot sessions run against those follow-up Issues.

**Goal:** Carry Lever A–identical observational `passedCount`/`totalCount` on live-issue jinn-repo verdicts (`jinn-repo-verdict.v3`), through evaluator → SDK → indexer → discovery/corpus, without changing binary settlement or sizing emissions.

**Architecture:** Additive-only plumbing. Keep v2 `gates` for stage diagnosis; emit within-tests-gate assertion counts when vitest JSON is parseable; omit counts on applies/typecheck short-circuit, unparseable JSON, and non-vitest package-script fallback. Indexer reuses existing `verdictEnvelopeMeta.passedCount`/`totalCount` columns and generalizes the task-body fetch so jinn-repo evaluations populate `solutionRequestId`. Discovery surfaces `gradedScores[]` for learning; emissions paths never read the fields.

**Tech Stack:** TypeScript, Zod (SDK), Vitest, Ponder/Drizzle (indexer), GraphQL (discovery). Yarn workspaces: `packages/sdk`, `packages/indexer`, `packages/indexer-enrichment`, `client`.

**Spec:** `docs/superpowers/specs/2026-07-23-jinn-repo-graded-verdict-signal-design.md` · **Issue:** #1976 · **Precedent:** `docs/superpowers/plans/2026-06-03-graded-reward-signal-lever-a.md` (#1019)

## Global Constraints

- Binary `passed` remains authoritative for settlement and self-eval; graded never overrules it.
- Graded is observational learning-only — no emissions / reward-claim / faucet / distributor reads.
- `gradedScore` is never stored in the payload; derive `passedCount / totalCount` when `totalCount > 0`, else `null`.
- Absent ≠ zero: omit count keys when the tests gate did not produce a gradeable assertion set.
- Unscorable (infra / no gated package) publishes **no** verdict (existing `SkippableError`).
- Schema bump is additive `jinn-repo-verdict.v3`; read path `z.union([v1, v2, v3])`.
- Reuse `parseVitestJsonV1` contract; do not invent a parallel vitest JSON parser.
- American English identifiers (`distill`, never `distil`).
- Each F* Issue is one Autopilot implementation session; PR title prefix matches the F* Conventional Commit shape.

**Conventions:**
- Package tests from package dirs: `packages/sdk`, `packages/indexer`, `packages/indexer-enrichment`, `client`.
- Client single-file iteration: `cd client && yarn vitest run <path>`.
- Commit after every green task inside an F* session. Target base: `next`.

---

## #1976 acceptance criteria → design coverage

This design Issue's ACs are satisfied by the locked design (+ this plan). Verification is **documentation**, not code:

| AC | Verification that the design already covers it | Code ships in |
|---|---|---|
| **1.** Signal strictly richer than the v2 gate vector, including failed + unscorable meaning | Design §3 A1 lock + §3 B table + §4.1–4.2; hop assertions 1–3 | F2 (emit) + F1 (schema) |
| **2.** Binary pass/fail authoritative; graded does not size emissions/rewards | Design §1 invariants + §4.6; hop assertion 8 | F4 boundary test (extends Lever A guard) |
| **3.** Backward compatibility for v1/v2 producers and consumers | Design §3 C1 + §4.5; hop assertion 4 | F1 |
| **4.** Complete evaluator → payload/envelope → indexer/discovery → corpus-association path, testable | Design §3 D hops + numbered assertions 1–7; §4.3–4.4 | F2 + F3 + F4 |
| **5.** Bounded follow-up `feat` work units (one session each) | Design §3 E table (F1–F4); expanded below | (filing Issues after ratification) |

**Explicit close path for #1976:** After human ratification of the design (and resolution or deferral of §Open questions below), file GitHub Issues F1–F4 (Issue Type `feat`), link them as sub-issues or blockers of any parent epic if desired, then close #1976. **This plan does not ship code in #1976.**

---

## Sequencing / dependencies

```
F1 (SDK v3 schema)
 ├──► F2 (evaluator emit)     [requires F1 types/union]
 └──► F3 (indexer carry+join) [requires F1 field names; can parallel F2 after F1]
         └──► F4 (discovery+corpus+boundary) [requires F3 columns populated]
```

- **F1 before F2 and F3** — hard. F2 publishes `schemaVersion: 'jinn-repo-verdict.v3'`; F3 parses those fields.
- **F2 ∥ F3** after F1 — allowed. Prefer merging F1 first so both land against a released schema.
- **F4 after F3** — hard for the discovery path that reads indexer meta. Corpus `scoreMetadata` wiring can start once F1 payload shape is known, but end-to-end gradedScores needs F3.
- Optional sequenced work (not blocking #1976 ACs): per-package count arrays; merged-pr v1 gold-test counts; jinn-repo-specific Consolidator Tier-2 policy (Lever A already consumes `gradedScores` generically).

---

## Human-ratification open questions (from design §7)

These shape or gate F* scope; they do **not** block writing this plan. Record the human answer on the design (or in the F* Issue body) before implementation starts.

| # | Question | Design lock (default if unamended) | Affects |
|---|---|---|---|
| **Q1** | Non-vitest package fallback scripts: omit counts vs graded-only unscorable? | **Omit counts**; boolean `gates.tests` still settles | F2 |
| **Q2** | Is generalizing the swe-rebench-only task-body IPFS fetch into F3 in-scope? | **Yes — inside F3** (needed for `#1433` join on jinn-repo) | F3 |
| **Q3** | Discovery auth posture: restore a verified `getCodeDigestRewards` route vs corpus-local graded path? | Product choice; **F1–F3 payload/indexer contract unblocked** either way | F4 |

---

## File structure (all F*)

**Create:**
- (none required — extend existing files; optional small shared helper extract under `client/src/` only if F2 wants `parseVitestJsonV1` without importing a `task-creator/proofs/` fixture module)

**Modify:**
- `packages/sdk/src/payloads/jinn-repo.ts` — `JinnRepoVerdictV3PayloadSchema` + union bump
- `packages/sdk/src/solvernets/jinn-repo.ts` — re-export v3 schema/type
- `packages/sdk/src/contracts.ts` — already uses union; rebuild JSON schema via existing path
- `client/src/harnesses/impls/jinn-repo-evaluator/live-eval-runner.ts` — JSON reporter + aggregate counts
- `client/src/harnesses/impls/jinn-repo-evaluator/harness.ts` — publish v3 + forward counts
- `packages/indexer/src/enrichment-parse.ts` — jinn-repo branch in `parseVerdictEnvelopeLite`
- `packages/indexer/src/handlers.ts` — widen task-body fetch gate beyond `swe-rebench-v2`
- `packages/indexer-enrichment/src/enrich.ts` — same fetch-gate widen (must stay in lockstep)
- `client/src/discovery/http.ts` (and/or corpus path) — surface jinn-repo `gradedScores`
- `client/src/mcp/search-records.ts` / corpus knowledge seam — pass graded fields into `scoreMetadata` (or documented sibling)

**Test:**
- `packages/sdk/test/payloads.jinn-repo.test.ts`
- `client/test/harnesses/jinn-repo-evaluator/harness.test.ts`
- `client/test/harnesses/jinn-repo-evaluator/live-eval-runner.integration.test.ts` (and/or new unit file with JSON fixtures)
- `packages/indexer/test/handlers.test.ts` (`parseVerdictEnvelopeLite` describe)
- `packages/indexer-enrichment/test/enrich.test.ts`
- `client/test/discovery/*` (extend Lever A codedigest-rewards tests if present; else add)
- `client/test/learner/emissions-boundary.test.ts` (confirm still green; extend if jinn-repo-specific identifiers appear)

---

## Phase 0 — Design Issue closeout (this session / Captain)

### Task 0: Ratify, file F*, close #1976

**Files:** none in-repo (GitHub Issues only)

- [ ] **Step 1:** Human ratifies `docs/superpowers/specs/2026-07-23-jinn-repo-graded-verdict-signal-design.md` (status → ratified / DR if required by process).
- [ ] **Step 2:** Record Q1–Q3 answers on the design or in F2/F3/F4 Issue bodies.
- [ ] **Step 3:** File four `feat` Issues with titles from design §3 E; paste the matching Phase below as the Issue implementation pointer; set Effort from triage; Blocked on: F2/F3 → F1, F4 → F3.
- [ ] **Step 4:** Close #1976 with a comment linking the design, this plan, and F1–F4.

**Success criteria:** #1976 closed; F1–F4 open; no production code required from #1976 itself.

---

## Phase F1 — `feat(sdk): add jinn-repo-verdict.v3 graded counts`

**Depends on:** —  
**Session sizing:** one Autopilot implement session  
**Proposed Issue title:** `feat(sdk): add jinn-repo-verdict.v3 graded counts`

### Task F1.1: Additive `jinn-repo-verdict.v3` schema + union

**Files:**
- Modify: `packages/sdk/src/payloads/jinn-repo.ts`
- Modify: `packages/sdk/src/solvernets/jinn-repo.ts` (re-exports)
- Test: `packages/sdk/test/payloads.jinn-repo.test.ts`

**Interfaces:**
- Consumes: existing `JinnRepoVerdictV1PayloadSchema`, `JinnRepoVerdictV2PayloadSchema`
- Produces: `JinnRepoVerdictV3PayloadSchema`, updated `JinnRepoVerdictPayloadSchema` union, types `JinnRepoVerdictV3Payload` / `JinnRepoVerdictPayload`

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/test/payloads.jinn-repo.test.ts`:

```typescript
import {
  JinnRepoVerdictPayloadSchema,
  JinnRepoVerdictV3PayloadSchema,
} from '../src/payloads/jinn-repo.js';

describe('jinn-repo-verdict.v3 (graded counts — #1976)', () => {
  const v3WithCounts = {
    schemaVersion: 'jinn-repo-verdict.v3' as const,
    passed: false,
    gates: { applies: true, typecheck: true, tests: false },
    passedCount: 18,
    totalCount: 20,
  };

  const v3WithoutCounts = {
    schemaVersion: 'jinn-repo-verdict.v3' as const,
    passed: false,
    gates: { applies: false, typecheck: false, tests: false },
  };

  it('parses v3 with graded counts', () => {
    const parsed = JinnRepoVerdictV3PayloadSchema.parse(v3WithCounts);
    expect(parsed.passedCount).toBe(18);
    expect(parsed.totalCount).toBe(20);
  });

  it('parses v3 without counts (short-circuit / unparseable)', () => {
    expect(() => JinnRepoVerdictV3PayloadSchema.parse(v3WithoutCounts)).not.toThrow();
    const parsed = JinnRepoVerdictV3PayloadSchema.parse(v3WithoutCounts);
    expect(parsed.passedCount).toBeUndefined();
    expect(parsed.totalCount).toBeUndefined();
  });

  it('rejects one-of-two counts', () => {
    expect(() =>
      JinnRepoVerdictV3PayloadSchema.parse({ ...v3WithoutCounts, passedCount: 1 }),
    ).toThrow();
    expect(() =>
      JinnRepoVerdictV3PayloadSchema.parse({ ...v3WithoutCounts, totalCount: 1 }),
    ).toThrow();
  });

  it('rejects passedCount greater than totalCount', () => {
    expect(() =>
      JinnRepoVerdictV3PayloadSchema.parse({ ...v3WithCounts, passedCount: 21, totalCount: 20 }),
    ).toThrow();
  });

  it('rejects negative or non-integer counts', () => {
    expect(() =>
      JinnRepoVerdictV3PayloadSchema.parse({ ...v3WithCounts, passedCount: -1 }),
    ).toThrow();
    expect(() =>
      JinnRepoVerdictV3PayloadSchema.parse({ ...v3WithCounts, totalCount: 1.5 }),
    ).toThrow();
  });

  it('accepts 0/0 (present; gradedScore null downstream)', () => {
    expect(() =>
      JinnRepoVerdictV3PayloadSchema.parse({ ...v3WithCounts, passedCount: 0, totalCount: 0 }),
    ).not.toThrow();
  });

  it('union accepts v1, v2, and v3', () => {
    const v1 = { schemaVersion: 'jinn-repo-verdict.v1' as const, passed: true };
    const v2 = {
      schemaVersion: 'jinn-repo-verdict.v2' as const,
      passed: false,
      gates: { applies: true, typecheck: false, tests: false },
    };
    expect(JinnRepoVerdictPayloadSchema.parse(v1).schemaVersion).toBe('jinn-repo-verdict.v1');
    expect(JinnRepoVerdictPayloadSchema.parse(v2).schemaVersion).toBe('jinn-repo-verdict.v2');
    expect(JinnRepoVerdictPayloadSchema.parse(v3WithCounts).schemaVersion).toBe(
      'jinn-repo-verdict.v3',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && yarn vitest run test/payloads.jinn-repo.test.ts`
Expected: FAIL — `JinnRepoVerdictV3PayloadSchema` is not exported.

- [ ] **Step 3: Add v3 schema + update union**

In `packages/sdk/src/payloads/jinn-repo.ts`, after the v2 schema, add:

```typescript
/**
 * v3 — additive graded signal within the tests gate (#1976 / Lever A vocabulary).
 * Superset of v2: keeps `passed` + `gates`, adds optional `passedCount`/`totalCount`
 * (both present or both absent). `gradedScore = passedCount/totalCount` is derived
 * downstream when totalCount > 0; never stored here.
 */
export const JinnRepoVerdictV3PayloadSchema = z
  .object({
    schemaVersion: z.literal('jinn-repo-verdict.v3'),
    passed: z.boolean(),
    test_log_excerpt: z.string().optional(),
    gates: z.object({
      applies: z.boolean(),
      typecheck: z.boolean(),
      tests: z.boolean(),
    }),
    passedCount: z.number().int().nonnegative().optional(),
    totalCount: z.number().int().nonnegative().optional(),
  })
  .refine(
    (p) =>
      (p.passedCount === undefined && p.totalCount === undefined) ||
      (p.passedCount !== undefined && p.totalCount !== undefined),
    { message: 'passedCount and totalCount must both be present or both absent' },
  )
  .refine(
    (p) =>
      p.passedCount === undefined ||
      p.totalCount === undefined ||
      p.passedCount <= p.totalCount,
    { message: 'passedCount must not exceed totalCount' },
  );

export type JinnRepoVerdictV3Payload = z.infer<typeof JinnRepoVerdictV3PayloadSchema>;

export const JinnRepoVerdictPayloadSchema = z.union([
  JinnRepoVerdictV1PayloadSchema,
  JinnRepoVerdictV2PayloadSchema,
  JinnRepoVerdictV3PayloadSchema,
]);
```

Update the file header comment to mention three verdict versions. Re-export `JinnRepoVerdictV3PayloadSchema` / `JinnRepoVerdictV3Payload` from `packages/sdk/src/solvernets/jinn-repo.ts`.

- [ ] **Step 4: Run tests + build**

Run: `cd packages/sdk && yarn vitest run test/payloads.jinn-repo.test.ts && yarn build`
Expected: PASS; `contracts.ts` JSON schema regenerates/consumes the widened union without further edits if it already imports `JinnRepoVerdictPayloadSchema`.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/payloads/jinn-repo.ts packages/sdk/src/solvernets/jinn-repo.ts packages/sdk/test/payloads.jinn-repo.test.ts
git commit -m "$(cat <<'EOF'
feat(sdk): add jinn-repo-verdict.v3 graded counts

EOF
)"
```

**F1 success criteria:** v1/v2 still parse; v3 parses with and without counts; one-of-two and `passedCount > totalCount` rejected; union includes v3. Design hop assertion 4 green.

---

## Phase F2 — `feat(evaluator): emit jinn-repo v3 passedCount/totalCount`

**Depends on:** F1  
**Session sizing:** one Autopilot implement session  
**Proposed Issue title:** `feat(evaluator): emit jinn-repo v3 passedCount/totalCount`  
**Q1 default:** omit counts on non-vitest package-script fallback.

### Task F2.1: Runner returns optional counts from vitest JSON

**Files:**
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/live-eval-runner.ts`
- Modify (optional extract): move or re-export `parseVitestJsonV1` to a shared non-fixture module **without changing parse semantics** (prefer import from `client/src/task-creator/proofs/vitest-json-fixture.ts` if the import graph is acceptable; else extract to e.g. `client/src/harnesses/impls/jinn-repo-evaluator/vitest-json.ts` that duplicates only the re-export)
- Test: new or extended unit tests under `client/test/harnesses/jinn-repo-evaluator/` (prefer pure unit over full integration for count aggregation)

**Interfaces:**
- Consumes: `parseVitestJsonV1(log: string) => { passed: string[]; failed: string[] }`
- Produces: extend `JinnRepoLiveEvalResult` with optional `passedCount?: number; totalCount?: number`

- [ ] **Step 1: Write the failing tests**

Add a focused unit test file (e.g. `client/test/harnesses/jinn-repo-evaluator/live-eval-counts.test.ts`) that either:
- exports a pure helper `aggregateVitestCounts(reports: { passed: string[]; failed: string[] }[])` from the runner module, **or**
- mocks `sh` / filesystem enough to exercise the tests gate with fixture JSON stdout.

Minimal pure-helper approach (recommended for session speed):

```typescript
import { describe, it, expect } from 'vitest';
import { aggregateAssertionCounts } from '../../../src/harnesses/impls/jinn-repo-evaluator/live-eval-runner.js';

describe('aggregateAssertionCounts', () => {
  it('sums passed/failed across packages', () => {
    expect(
      aggregateAssertionCounts([
        { passed: ['a', 'b'], failed: ['c'] },
        { passed: ['d'], failed: [] },
      ]),
    ).toEqual({ passedCount: 3, totalCount: 4 });
  });
});
```

(If exporting a helper is rejected as surface bloat, inline the same assertions against a runner result fixture instead — same numbers.)

Also extend harness tests (Task F2.2) for published payload — that is the design's load-bearing assertion.

- [ ] **Step 2: Run to verify fail**

Run: `cd client && yarn vitest run test/harnesses/jinn-repo-evaluator/live-eval-counts.test.ts`
Expected: FAIL — helper / counts not present.

- [ ] **Step 3: Implement count aggregation + vitest JSON reporter**

In `live-eval-runner.ts`:

1. Extend `JinnRepoLiveEvalResult`:

```typescript
export interface JinnRepoLiveEvalResult {
  applies: boolean;
  typecheck: boolean;
  tests: boolean;
  passed: boolean;
  unscorable: boolean;
  logExcerpt: string;
  /** Present iff tests gate ran and assertion counts were parsed. */
  passedCount?: number;
  totalCount?: number;
}
```

2. Export:

```typescript
export function aggregateAssertionCounts(
  reports: ReadonlyArray<{ passed: string[]; failed: string[] }>,
): { passedCount: number; totalCount: number } {
  let passedCount = 0;
  let failedCount = 0;
  for (const r of reports) {
    passedCount += r.passed.length;
    failedCount += r.failed.length;
  }
  return { passedCount, totalCount: passedCount + failedCount };
}
```

3. In the tests gate loop:
   - Prefer `yarn vitest run --reporter=json ...` (dual reporter OK if human logs must stay — e.g. default + json). Capture stdout/stderr; on success **and** on real failure (`isRealFailure`), attempt `parseVitestJsonV1` on the combined log.
   - On successful parse, push `{ passed, failed }` into an array; on throw from parser, mark that package as "no counts" for aggregation (do not invent counts).
   - For the package-script fallback branch (`yarn [testScript]`): keep boolean gate behavior; **do not** attempt counts unless the script is known to emit vitest JSON (Q1: omit).
   - After the loop: if **at least one** package produced a parseable report, set `passedCount`/`totalCount` from `aggregateAssertionCounts`; if tests ran but **no** package parsed, omit both fields.
   - Applies-fail and typecheck-fail early returns: **do not** set count fields.
   - Unscorable returns: unchanged (no counts; harness skips publish).

Skipped/pending/todo assertions stay out of both numerator and denominator (`parseVitestJsonV1` already ignores them).

- [ ] **Step 4: Run unit tests**

Run: `cd client && yarn vitest run test/harnesses/jinn-repo-evaluator/live-eval-counts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/impls/jinn-repo-evaluator/live-eval-runner.ts client/test/harnesses/jinn-repo-evaluator/
git commit -m "$(cat <<'EOF'
feat(evaluator): aggregate vitest assertion counts for jinn-repo live eval

EOF
)"
```

### Task F2.2: Harness publishes v3 payload (including published-file assertion)

**Files:**
- Modify: `client/src/harnesses/impls/jinn-repo-evaluator/harness.ts` (`runLive`)
- Test: `client/test/harnesses/jinn-repo-evaluator/harness.test.ts`

**Interfaces:**
- Consumes: `JinnRepoLiveEvalResult` counts from F2.1; `JinnRepoVerdictV3Payload` from F1
- Produces: on-disk `jinn-repo-verdict.json` with `schemaVersion: 'jinn-repo-verdict.v3'`

- [ ] **Step 1: Write the failing tests**

Update / add cases in `harness.test.ts`:

```typescript
it('publishes jinn-repo-verdict.v3 with counts when gradeLive returns them', async () => {
  const gradeLive = vi.fn().mockResolvedValue({
    applies: true,
    typecheck: true,
    tests: false,
    passed: false,
    unscorable: false,
    logExcerpt: 'tests-failed',
    passedCount: 18,
    totalCount: 20,
  });
  const h = new JinnRepoEvaluatorHarness({ gradeLive });
  // … existing live-task solve path …
  const written = JSON.parse(await readFile(join(workingDir, 'jinn-repo-verdict.json'), 'utf8'));
  expect(written).toMatchObject({
    schemaVersion: 'jinn-repo-verdict.v3',
    passed: false,
    gates: { applies: true, typecheck: true, tests: false },
    passedCount: 18,
    totalCount: 20,
  });
});

it('publishes v3 without count keys on applies short-circuit', async () => {
  const gradeLive = vi.fn().mockResolvedValue({
    applies: false,
    typecheck: false,
    tests: false,
    passed: false,
    unscorable: false,
    logExcerpt: 'patch does not apply',
  });
  // … assert written payload has schemaVersion v3, gates.applies false,
  // and !('passedCount' in written) && !('totalCount' in written)
});

it('still skips publish on unscorable (no verdict file)', async () => {
  // existing SkippableError expectation — unchanged
});
```

Update existing v2 expectations that assumed `schemaVersion: 'jinn-repo-verdict.v2'` for live path to v3 (live producer bumps; merged-pr v1 path unchanged).

- [ ] **Step 2: Run to verify fail**

Run: `cd client && yarn vitest run test/harnesses/jinn-repo-evaluator/harness.test.ts`
Expected: FAIL on v3 / counts assertions.

- [ ] **Step 3: Minimal harness change**

In `runLive`, replace v2 construction with:

```typescript
const verdictPayload: JinnRepoVerdictPayload = {
  schemaVersion: 'jinn-repo-verdict.v3',
  passed: result.passed,
  test_log_excerpt: result.logExcerpt || undefined,
  gates: {
    applies: result.applies,
    typecheck: result.typecheck,
    tests: result.tests,
  },
  ...(result.passedCount !== undefined && result.totalCount !== undefined
    ? { passedCount: result.passedCount, totalCount: result.totalCount }
    : {}),
};
```

Keep unscorable → `SkippableError` path unchanged.

- [ ] **Step 4: Run harness + related tests**

Run: `cd client && yarn vitest run test/harnesses/jinn-repo-evaluator/`
Expected: PASS. Design hop assertions 1–3 covered (counts / short-circuit / unscorable).

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/impls/jinn-repo-evaluator/harness.ts client/test/harnesses/jinn-repo-evaluator/harness.test.ts
git commit -m "$(cat <<'EOF'
feat(evaluator): publish jinn-repo-verdict.v3 with optional graded counts

EOF
)"
```

**F2 success criteria:** Fixture 18/2 → published v3 with counts; applies fail → no count keys; unscorable → no verdict; package-script fallback omits counts (Q1).

---

## Phase F3 — `feat(indexer): carry jinn-repo graded counts + join keys`

**Depends on:** F1 (schema field names); may land parallel to F2  
**Session sizing:** one Autopilot implement session  
**Proposed Issue title:** `feat(indexer): carry jinn-repo graded counts + join keys`  
**Q2 default:** task-body fetch generalization is **in scope** for this Issue.

### Task F3.1: `parseVerdictEnvelopeLite` jinn-repo branch

**Files:**
- Modify: `packages/indexer/src/enrichment-parse.ts`
- Test: `packages/indexer/test/handlers.test.ts` (`describe('parseVerdictEnvelopeLite')`)

**Interfaces:**
- Consumes: payload `passed`, optional `passedCount`/`totalCount`, `schemaVersion`
- Produces: `VerdictEnvelopeLite` with correct `actualPassed`, `evaluatorVerdict`, counts (default `0/0` when absent)

- [ ] **Step 1: Write the failing tests**

Append:

```typescript
it('parses jinn-repo-verdict.v3 actualPassed from payload.passed + graded counts', () => {
  const body = {
    solverType: 'jinn-repo.v1',
    task: { requestId: '0xabc', attemptIndex: 0, taskId: '1', cid: 'bafyTask' },
    participant: { safeAddress: '0xeval' },
    payload: {
      schemaVersion: 'jinn-repo-verdict.v3',
      passed: false,
      gates: { applies: true, typecheck: true, tests: false },
      passedCount: 18,
      totalCount: 20,
    },
  };
  const meta = parseVerdictEnvelopeLite(body);
  expect(meta?.actualPassed).toBe(false);
  expect(meta?.evaluatorVerdict).toBe('FAIL');
  expect(meta?.passedCount).toBe(18);
  expect(meta?.totalCount).toBe(20);
});

it('jinn-repo v2 without counts → 0/0 columns; actualPassed from payload.passed', () => {
  const body = {
    solverType: 'jinn-repo.v1',
    task: { requestId: '0xdef', attemptIndex: 0, taskId: '1', cid: '' },
    payload: {
      schemaVersion: 'jinn-repo-verdict.v2',
      passed: true,
      gates: { applies: true, typecheck: true, tests: true },
    },
  };
  const meta = parseVerdictEnvelopeLite(body);
  expect(meta?.actualPassed).toBe(true);
  expect(meta?.evaluatorVerdict).toBe('PASS');
  expect(meta?.passedCount).toBe(0);
  expect(meta?.totalCount).toBe(0);
});

it('recognizes jinn-repo via schemaVersion even if solverType is odd', () => {
  const body = {
    solverType: 'mystery.v1',
    task: { requestId: '0x111' },
    payload: {
      schemaVersion: 'jinn-repo-verdict.v3',
      passed: false,
      gates: { applies: true, typecheck: true, tests: false },
      passedCount: 1,
      totalCount: 2,
    },
  };
  const meta = parseVerdictEnvelopeLite(body);
  expect(meta?.actualPassed).toBe(false);
  expect(meta?.passedCount).toBe(1);
  expect(meta?.totalCount).toBe(2);
});
```

Regression note: today's generic branch reads `payload.verdict`, so jinn-repo `payload.passed` is missed — these tests lock the fix.

- [ ] **Step 2: Run to verify fail**

Run: `cd packages/indexer && yarn vitest run test/handlers.test.ts -t 'jinn-repo'`
Expected: FAIL (`actualPassed` false-negative / counts 0).

- [ ] **Step 3: Implement branch**

In `parseVerdictEnvelopeLite`, after building `payloadObj`, detect jinn-repo:

```typescript
const schemaVersion = safeStr(payloadObj['schemaVersion']);
const isJinnRepo =
  solverType.startsWith('jinn-repo') || schemaVersion.startsWith('jinn-repo-verdict.');

if (solverType.startsWith('swe-rebench-v2')) {
  // existing swe-rebench branch unchanged
} else if (isJinnRepo) {
  const passedRaw = payloadObj['passed'];
  if (typeof passedRaw === 'boolean') {
    actualPassed = passedRaw;
  } else if (typeof passedRaw === 'string') {
    actualPassed = passedRaw.toLowerCase() === 'true' || passedRaw === '1';
  }
  const pc = payloadObj['passedCount'] ?? payloadObj['passed_count'];
  const tc = payloadObj['totalCount'] ?? payloadObj['total_count'];
  // Only materialize when both present; else leave 0/0 (column defaults).
  if (pc !== undefined && tc !== undefined) {
    passedCount = Math.max(0, safeInt(pc, 0));
    totalCount = Math.max(0, safeInt(tc, 0));
  }
  evaluatorVerdict = actualPassed ? 'PASS' : 'FAIL';
} else {
  // existing generic payload.verdict branch
}
```

No new Ponder columns — reuse `verdictEnvelopeMeta.passedCount` / `totalCount`.

- [ ] **Step 4: Run tests**

Run: `cd packages/indexer && yarn vitest run test/handlers.test.ts -t 'parseVerdictEnvelopeLite'`
Expected: PASS (including existing swe-rebench graded tests).

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/src/enrichment-parse.ts packages/indexer/test/handlers.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): parse jinn-repo verdict passed + graded counts

EOF
)"
```

### Task F3.2: Generalize task-body fetch for join keys (handler + enrichment worker)

**Files:**
- Modify: `packages/indexer/src/handlers.ts` (evaluation enrichment branch ~1574)
- Modify: `packages/indexer-enrichment/src/enrich.ts` (~line 101)
- Test: `packages/indexer-enrichment/test/enrich.test.ts` (update the test that asserts non-swe-rebench skips fetch; add jinn-repo positive case)

**Interfaces:**
- Consumes: `resolveInstanceFields(taskBody)` (already returns `solutionRequestId` / `solverNetManifestCid`)
- Produces: `verdictEnvelopeMeta.solutionRequestId` populated for jinn-repo evaluations when task body has `restorationRequestId`

- [ ] **Step 1: Write / update failing tests**

In `packages/indexer-enrichment/test/enrich.test.ts`:
- Change or replace `does NOT fetch the task body for a non-swe-rebench-v2 verdict` so prediction/other types still skip, **but** `jinn-repo.v1` with `taskCid` **does** fetch.
- Add: jinn-repo task body with `restorationRequestId` → persisted `solutionRequestId`.

- [ ] **Step 2: Run to verify fail**

Run: `cd packages/indexer-enrichment && yarn vitest run test/enrich.test.ts`
Expected: FAIL on jinn-repo fetch expectation.

- [ ] **Step 3: Widen the gate (identical predicate in both call sites)**

Replace:

```typescript
if (meta.solverType.startsWith('swe-rebench-v2') && meta.taskCid) {
```

with a shared predicate (inline or tiny helper next to `resolveInstanceFields`):

```typescript
function shouldFetchTaskBodyForVerdictMeta(solverType: string): boolean {
  return (
    solverType.startsWith('swe-rebench-v2') || solverType.startsWith('jinn-repo')
  );
}
```

Use in **both** `handlers.ts` and `enrich.ts`. `instance_id` may stay empty for jinn-repo; `solutionRequestId` and `solverNetManifestCid` still populate when present. Keep graceful degrade on fetch failure.

- [ ] **Step 4: Run enrichment + indexer tests**

Run:
```bash
cd packages/indexer-enrichment && yarn vitest run test/enrich.test.ts
cd packages/indexer && yarn vitest run test/handlers.test.ts -t 'parseVerdictEnvelopeLite'
```
Expected: PASS. Design hop assertions 5–6.

- [ ] **Step 5: Commit**

```bash
git add packages/indexer/src/handlers.ts packages/indexer-enrichment/src/enrich.ts packages/indexer-enrichment/test/enrich.test.ts
git commit -m "$(cat <<'EOF'
feat(indexer): fetch jinn-repo task bodies for solutionRequestId join

EOF
)"
```

**F3 success criteria:** v3 envelope → correct `actualPassed` + counts; v2 historical → `0/0`; jinn-repo eval with `restorationRequestId` → `solutionRequestId` set; handler and enrichment worker stay lockstep.

---

## Phase F4 — `feat(discovery+corpus): surface jinn-repo gradedScores for learning`

**Depends on:** F3  
**Session sizing:** one Autopilot implement session  
**Proposed Issue title:** `feat(discovery+corpus): surface jinn-repo gradedScores for learning`  
**Q3:** human chooses verified GraphQL rewards route vs corpus-local graded path; implement the chosen path only.

### Task F4.1: Discovery / learning read path

**Files (choose path per Q3):**
- If restoring GraphQL rewards: `client/src/discovery/http.ts` (`getCodeDigestRewards`), types already have `gradedScores: number[]` on `CodeDigestRewardRow`
- If corpus-local: `client/src/mcp/search-records.ts` and/or `client/src/harnesses/engine/corpus-knowledge.ts` — document that graded counts flow via `scoreMetadata` from verdict payload / meta join, not via unverified reward rows
- Test: extend `client/test/discovery/http.codedigest-rewards.test.ts` if present; else add corpus/search-records tests for graded fields

**Interfaces:**
- Consumes: indexer `passedCount`/`totalCount` (or payload fields on corpus inspect)
- Produces: `gradedScores` entries where `totalCount > 0` → `passedCount / totalCount`; omit/null when `totalCount === 0` (Lever A convention)

- [ ] **Step 1: Write failing tests for the chosen path**

Example for GraphQL path (if Q3 restores it):

```typescript
it('includes gradedScores for jinn-repo attempts when totalCount > 0', async () => {
  // mock GQL rows: one jinn-repo verdict meta passedCount=18 totalCount=20
  const rows = await api.getCodeDigestRewards({ codeDigests: ['0xdigest'] });
  expect(rows[0].gradedScores).toContain(0.9);
});

it('omits graded entry when totalCount is 0 (pre-v3 / short-circuit)', async () => {
  // mock totalCount 0 → gradedScores does not invent 0 from absent
});
```

Example for corpus-local path:

```typescript
it('exposes passedCount/totalCount on scoreMetadata for a jinn-repo verdict record', () => {
  // given a projected verdict envelope / meta with counts
  // expect scoreMetadata.passedCount === 18 && scoreMetadata.totalCount === 20
});
```

- [ ] **Step 2: Run to verify fail**

Run the new/extended discovery or corpus test file.
Expected: FAIL.

- [ ] **Step 3: Implement the minimal read path**

Derive score only when `totalCount > 0`. Do not treat column `0/0` as a real grade. Keep `onchain.ts` stub returning `gradedScores: []` unless a floor path is intentionally added (out of scope unless already patterned for Lever A).

Wire corpus association: consumers join
`verdictEnvelopeMeta.solutionRequestId === attemptEnvelopeMeta.requestId`
(already the #1433 contract once F3 populates the field). Document in a short code comment at the read site — no new canonical doc required for #1976.

- [ ] **Step 4: Run tests**

Run the F4 discovery/corpus tests + `cd client && yarn typecheck` if types change.
Expected: PASS. Design hop assertion 7.

- [ ] **Step 5: Commit**

```bash
git add client/src/discovery/ client/src/mcp/ client/src/harnesses/engine/ client/test/
git commit -m "$(cat <<'EOF'
feat(discovery): surface jinn-repo gradedScores for learning consumers

EOF
)"
```

### Task F4.2: Emissions boundary regression

**Files:**
- Test: `client/test/learner/emissions-boundary.test.ts` (usually no production change)

- [ ] **Step 1: Run existing boundary test**

Run: `cd client && yarn vitest run test/learner/emissions-boundary.test.ts`
Expected: PASS. If F4 introduced new identifiers into `earning/` / `distribution/` / reward-claim, that is a **product bug** — remove the import; do not weaken the test.

- [ ] **Step 2: Optional jinn-repo note**

If useful, add one `it` docstring comment that jinn-repo graded fields share the same Lever A invariant — no separate regex required unless new symbol names appear.

- [ ] **Step 3: Commit only if the test file changed**

```bash
git add client/test/learner/emissions-boundary.test.ts
git commit -m "$(cat <<'EOF'
test(learner): affirm emissions boundary covers jinn-repo graded fields

EOF
)"
```

**F4 success criteria:** learning surfaces see non-null graded scores for v3 counts; pre-v3 / short-circuit degrade honestly; emissions boundary still green (hop assertion 8).

---

## Self-review (plan vs design)

| Design requirement | Plan coverage |
|---|---|
| A1 signal = within-tests `passedCount`/`totalCount`; keep `gates` | F1 schema + F2 emit |
| Absent ≠ zero; unscorable unpublished | F2 short-circuit + harness skip |
| C1 `jinn-repo-verdict.v3` union | F1 |
| Carry path hops + assertions 1–8 | F2 (1–3), F1 (4), F3 (5–6), F4 (7–8) |
| F1–F4 one-session units + deps | Phases F1–F4 + sequencing section |
| No Phase B.2 emissions | Global constraints + F4.2 |
| #1976 does not ship F* code | Phase 0 + header callout |
| Q1–Q3 ratification | Open questions table |

**Placeholder scan:** none intentional — Q3 branches are explicit alternative implementations, not TBDs.

**Type consistency:** `passedCount`/`totalCount` optional on payload; indexer columns int default 0; discovery derives float only when `totalCount > 0`.

---

## Execution handoff

After human ratification and Phase 0 Issue filing, implement **F1 → (F2 ∥ F3) → F4** using `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`, one F* Issue per session.

**Do not implement F1–F4 under #1976.** Close #1976 once the design is ratified and F* Issues exist.
