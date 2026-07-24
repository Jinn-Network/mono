---
title: Graded verdict signal for jinn-repo (beyond the v2 gate vector)
date: 2026-07-23
author: cursor-grok (Stage 1 design for Autopilot issue #1976; headless)
status: human-ratified — follow-up implementation filed
version: 0.1
issue: https://github.com/Jinn-Network/mono/issues/1976
relates-to: >
  Lever A graded reward signal
  (docs/superpowers/specs/2026-06-03-graded-reward-signal-lever-a-design.md,
  issue #1019, swe-rebench-v2-verdict.v2 with passedCount/totalCount),
  jinn-repo mechanical live-issue gates (issue #1891, jinn-repo-verdict.v2),
  schema versioning (spec/2026-05-schema-versioning.md),
  corpus knowledge autoload / scoreMetadata seam (#1393 / #1396),
  (task, solution, verdict) join via solutionRequestId (#1433)
---

**Pre-reads (load-bearing):**

- **Lever A** — `docs/superpowers/specs/2026-06-03-graded-reward-signal-lever-a-design.md`
  and `packages/sdk/src/payloads/swe-rebench-v2.ts` (`swe-rebench-v2-verdict.v2`).
  Binary `score` stays authoritative; `passedCount`/`totalCount` are observational;
  graded never sizes emissions.
- **Current jinn-repo schemas** — `packages/sdk/src/payloads/jinn-repo.ts`:
  v1 boolean `passed`; v2 adds `gates: { applies, typecheck, tests }`.
- **Live evaluator** — `client/src/harnesses/impls/jinn-repo-evaluator/live-eval-runner.ts`:
  AND-gated applies → typecheck → tests; `unscorable` for infra / no-gated-package;
  currently collapses vitest runs to a boolean (does not parse per-test counts).
- **Vitest JSON parser already in-tree** — `client/src/task-creator/proofs/vitest-json-fixture.ts`
  (`parseVitestJsonV1`) — the production emit path should reuse this contract, not invent a
  parallel parser.
- **Indexer carry path (Lever A)** — `packages/indexer/src/enrichment-parse.ts`
  (`passedCount`, `totalCount`); `packages/indexer/ponder.schema.ts`
  (`verdictEnvelopeMeta.passedCount` / `totalCount`); handlers that materialize meta.
- **Corpus projection / discovery seam** —
  `client/src/corpus/envelope-projection.ts`,
  `client/src/mcp/search-records.ts` (`RecordSummary.scoreMetadata`), and
  `client/src/harnesses/engine/corpus-knowledge.ts`. Shape-parsed
  `CodeDigestRewardRow.gradedScores` is not trusted reward evidence.
- **Schema versioning** — `spec/2026-05-schema-versioning.md` (additive
  `schemaVersion` bumps; accept-both on the read path).

---

## 1. Summary

`jinn-repo-verdict.v2` already records the ordered mechanical gate vector
`{ applies, typecheck, tests }`. That answers *which stage failed*, but it does
not quantify variation **within** the tests stage: one failing assertion is
indistinguishable from an entire suite failure. Learning and revision consumers
therefore cannot rank near-miss solutions against total collapses.

This design locks a **graded observational signal** for jinn-repo that is
strictly richer than the v2 gate vector, reuses Lever A's vocabulary
(`passedCount` / `totalCount`), and specifies the full carry path from the live
evaluator through payload → signed envelope. The envelope then has two explicit
consumers: indexer/discovery metadata for public lookup and a locally projected,
signed-envelope association for learning.

**Two invariants (identical to Lever A):**

1. **Binary `passed` remains authoritative** for settlement and self-evaluation.
   The graded fields never overrule the bit.
2. **Graded is observational learning-only.** It does not size emissions,
   rewards, or any Phase B.2 economic policy. Out of scope here.

### Human ratification (2026-07-24)

The signal shape, v3 schema, null semantics, and carry path are accepted as written. The three open choices are resolved as follows:

1. Non-Vitest fallback scripts keep their authoritative boolean gate result and omit counts.
2. The jinn-repo task-body fetch generalization is part of F3 so handler and enrichment-worker joins remain in lockstep.
3. F4 uses authenticated signed envelopes and signed evaluation tasks for both
   local and discovery-returned records. It does not restore shape-parsed
   GraphQL projections as reward evidence.

Implementation is filed as [#2113](https://github.com/Jinn-Network/mono/issues/2113) → ([#2114](https://github.com/Jinn-Network/mono/issues/2114) ∥ [#2115](https://github.com/Jinn-Network/mono/issues/2115)) → [#2116](https://github.com/Jinn-Network/mono/issues/2116).

---

## 2. The gap, concretely

### 2.1 What v2 already gives

Live-issue grading (`live-eval-runner.ts`) AND-gates three stages:

1. **applies** — patch applies to `base_commit`
2. **typecheck** — full typecheck per touched gated package
3. **tests** — scoped vitest (or package fallback script) per touched package

`passed = applies ∧ typecheck ∧ tests`. The published v2 payload stores each
boolean. Consumers can tell "failed at typecheck" from "failed at tests."

### 2.2 Where the signal dies

When the tests gate runs, vitest already knows per-assertion outcomes. The
runner today only records whether the process exited zero:

```
const testsOk = testsFailLog.length === 0;
// … gates.tests = testsOk; no counts
```

So 1/40 failed and 40/40 failed both publish `{ tests: false, passed: false }`.
That is the exact loss Lever A named for swe-rebench — and the prior ambiguous
acceptance criteria for this issue ("which gate failed") are already satisfied
by v2. The intended richer signal is **within-gate test fraction**, not another
restatement of gate identity.

### 2.3 What this is not

- Not a replacement for `gates` (stage diagnosis stays).
- Not a composite "quality score" mixing applies/typecheck weights.
- Not reward / emissions sizing (Phase B.2 stays out).

---

## 3. Approaches considered (then locked)

### A — What is the richer signal?

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **A1 — Per-test `passedCount`/`totalCount` within the tests gate** | Same fields as Lever A; derived `gradedScore = passedCount/totalCount` at read time | Reuses shipped vocabulary + indexer columns; strictly richer than gate booleans; grounded in executable assertions (VeRPO / Lever A survey) | Requires vitest JSON (or equivalent) parse; early-gate failures leave counts absent |
| A2 — Ordered failure depth + within-gate fraction | e.g. `failureDepth ∈ {0,1,2,3}` + `testsFraction` | Encodes stage + fraction in one object | Parallel vocabulary to Lever A; depth restates `gates`; more invented surface |
| A3 — Composite derived score | Weighted blend of gate bits + test fraction | Single number for ranking | Invents policy; looks reward-like; miscalibrated across tasks; harder to audit |
| A4 — Per-package sub-scores | `{ pkg, passedCount, totalCount }[]` | Finer debugging | Heavier schema; learning consumers want one scalar per attempt first; can add later additive |

**Lock: A1.** Emit Lever A–identical `passedCount` / `totalCount` for the
aggregate of assertions the tests gate actually executed. Keep v2 `gates`
unchanged for stage diagnosis. Do not invent a composite score. Per-package
breakdown is a sequenced follow-on, not this design.

### B — Failed vs unscorable semantics

| Situation | Binary `passed` / publish | Graded fields |
|---|---|---|
| All gates pass | `passed: true`, verdict published | Present; `passedCount === totalCount` (and `totalCount ≥ 0`) |
| Applies fails | `passed: false`, gates reflect short-circuit | **Omitted** — tests never ran |
| Typecheck fails (applies ok) | `passed: false` | **Omitted** — tests short-circuited |
| Tests run; some assertions fail | `passed: false`, `gates.tests: false` | **Present** with real counts (`passedCount < totalCount` when `totalCount > 0`) |
| Tests run; zero assertions (`totalCount = 0`) | Boolean from exit status as today | Present as `0/0`; read-time `gradedScore = null` (Lever A guard) |
| Tests run; JSON unparseable | Boolean from exit status as today | **Omitted** — do not invent counts |
| `unscorable` (infra / no gated package) | **No verdict published** (existing `SkippableError` / skip) | N/A — nothing on-chain to enrich |

**Lock:** Absent ≠ zero. Omitting counts means "tests gate did not produce a
gradeable assertion set." Coercing early-gate failures to `0/N` would falsely
imply the suite ran and failed. Unscorable never becomes a FAIL and never
gets graded fields.

### C — Schema evolution

| Option | Pros | Cons |
|---|---|---|
| **C1 — New `jinn-repo-verdict.v3` additive over v2** | Matches Lever A v1→v2 and schema-versioning accept-both; clear producer bump | One more union member |
| C2 — Extend v2 in place | No version bump | Breaks "schemaVersion is the contract"; silent optional fields on a frozen version |
| C3 — Envelope-only sidecar | Avoids payload bump | Bypasses SDK validation; corpus inspect of payload misses the signal |

**Lock: C1.** Introduce `jinn-repo-verdict.v3` as a strict superset of v2:

- Retains `passed`, optional `test_log_excerpt`, and `gates`.
- Adds optional `passedCount` / `totalCount` (both present or both absent;
  `passedCount ≤ totalCount` when present).
- Live evaluator bumps producer to v3 when it can attempt count emission.
- Read path: `z.union([v1, v2, v3])`. v1/v2 consumers ignore unknown versions
  only if they already accept the union; typed consumers add v3. Indexer
  parses counts from payload regardless of whether the producer is v3, as long
  as the fields exist (defensive), but the **canonical producer contract** is v3.

Merged-pr **v1** gold-test grading is unchanged by this design (no gate vector
to enrich). A later feat may optionally add counts to a gold-test path; not
required for AC1.

### D — Carry path (locked hops + testable assertions)

```
live-eval-runner
  └─ runs applies → typecheck → tests (unchanged AND gate)
  └─ when tests execute: vitest --reporter=json (or dual) → parseVitestJsonV1
  └─ only when every executed package has parseable assertion output:
       aggregate passed[]/failed[] across all packages → passedCount/totalCount
       └─ harness publishes jinn-repo-verdict.v3 on IPFS payload
            + SignedEnvelope (role=verdict) as today
            ├─ indexer enrichment-parse (public lookup / inspection):
            │    • recognize jinn-repo / payload.passed (fix actualPassed today)
            │    • materialize passedCount/totalCount onto verdictEnvelopeMeta
            │    • generalize task-body fetch for solutionRequestId +
            │      solverNetManifestCid (today swe-rebench-only)
            │    └─ Discovery returns bounded manifest refs and join metadata;
            │         it does not turn shape-parsed rows into reward truth
            └─ authenticated corpus learning path:
                 • local: use engine-authored projections
                 • network: fetch + authenticate each signed envelope, then fetch +
                   authenticate its envelope.task.cid signed evaluation task
                 • project payload counts plus task.restorationRequestId as
                   metadata.solutionRequestId
                 • join verdict.metadata.solutionRequestId
                     = solution.requestId in local or in-memory projections
                 • overlay counts/derived grade on the solution RecordSummary.scoreMetadata
                   consumed by corpus knowledge
```

Per-hop assertions (implementation must make these fail the build if broken):

1. **Evaluator** — given a fixture vitest JSON with 18 passed / 2 failed,
   published payload has `schemaVersion: 'jinn-repo-verdict.v3'`,
   `passed: false`, `gates.tests: false`, `passedCount: 18`, `totalCount: 20`.
2. **Evaluator short-circuit** — applies fail → v3 payload has gates with
   `applies: false` and **no** `passedCount`/`totalCount` keys.
3. **Unscorable** — clone/install failure → no verdict artifact / skip path;
   no graded fields published.
4. **SDK** — v1 and v2 still parse; v3 parses with and without counts;
   `passedCount > totalCount` rejected; one-of-two counts rejected.
5. **Indexer** — v3 envelope materializes `actualPassed` from `payload.passed`,
   `passedCount`/`totalCount` from payload; v2 envelope → counts stay `0/0`
   (historical); `actualPassed` correct for jinn-repo (regression vs today's
   generic `payload.verdict` miss).
6. **Join** — jinn-repo evaluation task body with `restorationRequestId`
   populates indexer `solutionRequestId`; discovery can locate the verdict and
   solution manifest refs without asserting that shape-parsed rows are trusted
   reward evidence.
7. **Corpus association** — projecting an authenticated signed v3 verdict
   copies `passedCount`/`totalCount` and the authenticated signed evaluation
   task's top-level `restorationRequestId` into projection metadata. Locally,
   the engine already supplies that task when persisting projections. For
   network refs, corpus fetch authenticates the envelope, follows
   `envelope.task.cid`, authenticates the signed task, and constructs the same
   projections in memory. A bounded join matches `solutionRequestId` to a
   solution projection's `requestId` and overlays the counts plus derived grade
   on that solution's `RecordSummary.scoreMetadata`. Mixed
   v1/v2/short-circuit, failed-authentication, and missing-task records
   contribute no grade. `HttpDiscoveryAPI.getCodeDigestRewards` remains empty.
8. **Boundary** — no emissions / reward-claim / distributor module reads
   jinn-repo graded fields (same invariant test spirit as Lever A §5.5).

### E — Follow-up `feat` work units (do not implement here)

Each unit is sized for one implementation session:

| # | Proposed title | Scope | Depends on |
|---|---|---|---|
| **F1 / [#2113](https://github.com/Jinn-Network/mono/issues/2113)** | `feat(sdk): add jinn-repo-verdict.v3 graded counts` | Zod schemas + union + SDK unit tests (mirror swe-rebench v2 tests) | — |
| **F2 / [#2114](https://github.com/Jinn-Network/mono/issues/2114)** | `feat(evaluator): emit jinn-repo v3 passedCount/totalCount` | `live-eval-runner` + harness: JSON reporter, reuse `parseVitestJsonV1`, all-packages-or-omit aggregation, omit-on-short-circuit; unit tests with fixtures | F1 |
| **F3 / [#2115](https://github.com/Jinn-Network/mono/issues/2115)** | `feat(indexer): carry jinn-repo graded counts + join keys` | `enrichment-parse` jinn-repo branch (`payload.passed` → `actualPassed`, counts); generalize task-body fetch beyond swe-rebench for `solutionRequestId` / `solverNetManifestCid`; handler + enrichment-worker parity tests | F1 |
| **F4 / [#2116](https://github.com/Jinn-Network/mono/issues/2116)** | `feat(corpus): surface jinn-repo graded scores for learning` | Project counts + top-level `restorationRequestId` from authenticated signed verdict/task pairs; hydrate discovery-returned refs into the same in-memory projections; boundedly join verdicts to solutions and overlay `scoreMetadata`; keep unverified HTTP reward projections empty; emissions boundary test | F2 + F3 |

Optional sequenced (not blocking #1976 ACs): per-package count arrays; merged-pr
v1 gold-test counts; a separately verified discovery reward route; and
Consolidator Tier-2 sensitivity for jinn-repo specifically.

---

## 4. Locked design

### 4.1 Payload — `jinn-repo-verdict.v3`

```ts
// Conceptual — exact Zod lands in F1
{
  schemaVersion: 'jinn-repo-verdict.v3',
  passed: boolean,                 // authoritative bit
  test_log_excerpt?: string,
  gates: {
    applies: boolean,
    typecheck: boolean,
    tests: boolean,
  },
  // Present iff the tests gate executed and assertion counts were parsed.
  passedCount?: number,            // int ≥ 0
  totalCount?: number,             // int ≥ 0; passedCount ≤ totalCount
}
```

`gradedScore` is **never stored** in the payload (Lever A): derive
`passedCount / totalCount` when `totalCount > 0`; otherwise `null`.

### 4.2 Evaluator production

- Keep AND-gate order and unscorable conventions unchanged.
- When entering the tests gate, run vitest with JSON reporter output (dual
  reporter acceptable if human logs must stay). Prefer reusing
  `parseVitestJsonV1` (or extract a shared non-fixture helper in F2 without
  changing the parse contract).
- Multi-package: emit aggregate counts only when **every executed package**
  completed a parseable assertion run. Then sum `|passed|` and
  `|passed|+|failed|` across all executed packages. If any package uses a
  non-Vitest fallback or produces unparseable output, omit both aggregate
  fields; partial counts would be misleading. Skipped/pending/todo assertions
  are **not** counted in either numerator or denominator (matches
  `parseVitestJsonV1` today).
- Package script fallback (non-vitest): if JSON is unavailable, keep boolean
  `gates.tests` and **omit** counts (honest degradation).
- Harness `runLive` sets `schemaVersion: 'jinn-repo-verdict.v3'` and forwards
  counts when present. A test asserts the **published** payload (not only the
  in-memory grade result), mirroring Lever A's harness-republication pitfall.

### 4.3 Indexer materialization

- Extend `parseVerdictEnvelopeLite` with a jinn-repo branch:
  - `solverType` starts with `jinn-repo` **or** `payload.schemaVersion`
    matches `jinn-repo-verdict.v*`.
  - `actualPassed` ← `payload.passed` (boolean).
  - `evaluatorVerdict` ← `PASS`/`FAIL` from that bit.
  - `passedCount`/`totalCount` ← payload fields when present; else `0/0`
    (column defaults; consumers treat `totalCount === 0` as "no graded score").
- **Generalize** the task-body IPFS fetch that today is gated on
  `solverType.startsWith('swe-rebench-v2')` so jinn-repo evaluations also
  populate `solutionRequestId` and `solverNetManifestCid` (instance_id may
  still be empty for jinn-repo — that field is swe-rebench-shaped). This is
  required for AC4's corpus association path.
- Reuse existing `verdictEnvelopeMeta.passedCount` / `totalCount` columns —
  no new schema columns required for the graded scalar.

### 4.4 Discovery and authenticated corpus association

- The indexer materialization in §4.3 exists for public lookup, inspection, and
  locating signed envelope refs. Its shape-parsed rows are not promoted into
  reward or learning truth. `HttpDiscoveryAPI.getCodeDigestRewards` stays empty.
- `projectEnvelope` projects an authenticated signed jinn-repo verdict's
  `passedCount` and `totalCount`. With the evaluation `Task` supplied by the
  engine, it also projects top-level `task.restorationRequestId` as
  `metadata.solutionRequestId`.
- A pure bounded association helper (for example
  `client/src/corpus/jinn-repo-graded-association.ts`) accepts local
  `EnvelopeProjection` values. It accepts only jinn-repo `role=verdict`
  projections with both valid counts, indexes them by
  `metadata.solutionRequestId`, and joins them to jinn-repo `role=solution`
  projections whose `requestId` matches.
- `handleSearchRecords` queries the local projection store for both roles when
  returning jinn-repo solution records, uses the helper, and overlays
  `passedCount`, `totalCount`, and
  `gradedScore = passedCount / totalCount` (only when `totalCount > 0`) onto
  the solution `RecordSummary.scoreMetadata`. `loadCorpusKnowledge` already
  passes that field through to revision consumers.
- The corpus interface adds authenticated signed-task hydration by CID.
  `handleSearchRecords` retains the bounded set of discovery-returned manifest
  previews before role filtering. It authenticates network solution/verdict
  envelopes with the existing execution-envelope authenticator; for each
  verdict it follows `envelope.task.cid`, fetches the signed evaluation task,
  verifies its canonical hash/signature and `creator.agentEoa`, requires
  `role=evaluation` plus jinn-repo identity, and projects the top-level
  `restorationRequestId`. It then runs the same association helper over those
  in-memory network projections before returning solution records.
- A missing or invalid task CID, failed envelope/task authentication, identity
  mismatch, or unmatched request ID produces a warning and no grade. Counts
  always come from the authenticated verdict payload; raw GraphQL count
  columns never enter `scoreMetadata`.

### 4.5 Backward compatibility

| Producer | Consumer | Behavior |
|---|---|---|
| v1 (merged-pr) | any | Unchanged boolean `passed`; no gates; no counts |
| v2 (live, pre-upgrade) | v3-aware | Parses; counts absent → indexer `0/0` → `gradedScore null` |
| v3 without counts (short-circuit / unparseable) | any | Gates + bit only; graded absent |
| v3 with counts | v1-only naive reader | Must use union / ignore unknown version per schema-versioning; typed SDK bump in F1 |
| Historical chain data | learning | Degrades to binary-only — same as Lever A mixed windows |

### 4.6 Hard boundary (no Phase B.2)

Graded jinn-repo fields are read by learning / corpus / discovery surfaces only.
They must not appear on reward-claim, staking emissions, faucet, or distributor
paths. Documented in F4 as a regression assertion.

---

## 5. Acceptance criteria checklist

| AC | Status | Where satisfied |
|---|---|---|
| **1.** Design defines a signal strictly richer than the v2 gate vector, including meaning for failed and unscorable evaluations | **Pass** | §3 A1 lock; §3 B table; §4.1–4.2 |
| **2.** Binary pass/fail remains authoritative for settlement and self-eval; graded does not size emissions/rewards | **Pass** | §1 invariants; §4.6; out-of-scope Phase B.2 |
| **3.** Backward compatibility for v1/v2 producers and consumers is specified | **Pass** | §3 C1; §4.5 |
| **4.** Complete evaluator → payload/envelope → indexer/discovery → solution/verdict corpus-association path is specified and testable | **Pass** | §3 D hops + numbered assertions; §4.3–4.4 |
| **5.** Design identifies bounded follow-up `feat` work units (one session each) | **Pass** | §3 E table (F1–F4) |

---

## 6. Out of scope

- Phase B.2 reward economics / emissions sizing from graded scores.
- Changing AND-gate order or unscorable conventions.
- Per-package graded arrays (sequenced optional).
- Merged-pr v1 gold-test count emission (optional later).
- Replacing Lever A's Consolidator statistics or restoring
  `CodeDigestRewardRow.gradedScores` from unverified HTTP projections.
- Implementation of F1–F4 (separate Issues / sessions).

---

## 7. Ratified defaults

1. **Package fallback scripts that are not Vitest:** omit counts; the boolean
   `gates.tests` result remains authoritative.
2. **F3 task-body fetch generalization:** in scope for the indexer feat,
   because the `#1433` jinn-repo join requires it.
3. **Discovery auth posture:** use authenticated corpus association in F4:
   engine-authored projections locally, and authenticated envelope/task
   hydration for discovery-returned refs. `HttpDiscoveryAPI.getCodeDigestRewards`
   stays empty until a separately authenticated reward route exists.

No open ratification blockers remain: signal shape, null semantics, schema
bump, hop assertions, and the F1–F4 split are locked above.
