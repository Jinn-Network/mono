# Learning-approach SolverNet — Implementation Plan (Milestone 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the smallest closed loop that proves a learning-approach bundle can be programmatically novelty-evaluated against a 5-task swe-rebench-v2 probe set and registered (locally). Defers SolverNet manifest launch and on-chain ERC-8004 wiring to a Milestone 2 plan.

**Architecture:** A new SolverType `learning-approach-v0.v1` plus an evaluator-side library (`client/src/learning-approach/`) that reuses the existing eval orchestrator (`runEval` in `client/src/eval/orchestrator.ts`) with a custom `LearningApproachV0Evaluator`. The evaluator's verdict is **behavioural novelty**: run the bundle on a fixed 5-task swe-rebench-v2 probe slate, compute a `(PASS-vector, patch-SHAs)` signature, compute Hamming + Jaccard distance to the nearest existing registry entry, accept if above threshold. v0 registry is in-process / SQLite, not on-chain.

**Tech Stack:** TypeScript, Zod schemas, vitest, viem (for slate hashing), existing `client/src/solver-types/_swe-rebench-v2-held-out-slate.ts` slate primitive, existing `client/src/eval/orchestrator.ts` reusable boundaries.

**Spec reference:** [`spec/2026-06-10-learning-approach-solvernet.md`](../../../spec/2026-06-10-learning-approach-solvernet.md).

**Out of scope for this plan (deferred to a Milestone 2 plan):**
- SolverNet manifest creation + on-chain launch (`IdentityRegistry.setMetadata`).
- ERC-8004 ValidationRegistry write path.
- Operator-facing CLI commands (`jinn submit-learning-approach`).
- Bundle author back-attribution / royalties.
- Probe-set rotation cadence.

---

## File Structure

| Path | Responsibility |
|---|---|
| `client/src/types/learning-approach-v0.ts` | Zod schemas: bundle manifest, task spec, solution payload, verdict |
| `client/src/solver-types/learning-approach-v0.ts` | `SolverTypeDefinition` for `learning-approach-v0.v1` |
| `client/src/solver-types/index.ts` | Register the new SolverType |
| `client/src/solver-types/slates/held-out-slate.learning-approach-v0.v1.json` | The 5-task probe slate (instance_ids hand-picked from swe-rebench-v2) |
| `client/src/learning-approach/signature.ts` | `computeSignature` + `distance` (pure functions) |
| `client/src/learning-approach/registry.ts` | In-process novelty registry (SQLite-backed via existing `Store`) |
| `client/src/learning-approach/evaluator.ts` | `LearningApproachV0Evaluator` — the load-bearing class |
| `client/src/harnesses/impls/learning-approach-v0-evaluator/index.ts` | Evaluator-role harness shell (`supports({role:'evaluation'})`) |
| `client/src/harnesses/impls/index.ts` | Register the evaluator harness in `buildHarnesses` |
| `client/fixtures/learning-approach-v0/bundle-a.example.json` | Seed bundle A — baseline (claude-code + Haiku + learner plugin) |
| `client/fixtures/learning-approach-v0/bundle-b.example.json` | Seed bundle B — model swap (claude-code + Opus + learner plugin) |
| `client/test/unit/learning-approach/signature.test.ts` | Signature + distance unit tests |
| `client/test/unit/learning-approach/registry.test.ts` | Registry unit tests |
| `client/test/unit/learning-approach/evaluator.test.ts` | Evaluator unit tests (mocked harness) |
| `client/test/e2e/learning-approach-novelty-loop.test.ts` | E2E test: two bundles → evaluator → registry, mocked probe runs |
| `client/test/e2e/learning-approach-real-probe.test.ts` | Opt-in: real probe runs against actual swe-rebench-v2 tasks |
| `docs/runbooks/learning-approach-v0.md` | Operator-facing how-to-submit-a-bundle guide (M1 minimum) |

Tests follow the existing pyramid (`docs/runbooks/testing.md`). Mocked e2e gates CI; real-probe e2e is opt-in (env-gated).

---

## Task 1: Define the bundle / task / solution / verdict Zod schemas

**Files:**
- Create: `client/src/types/learning-approach-v0.ts`
- Test: `client/test/unit/learning-approach/types.test.ts`

- [ ] **Step 1: Write failing schema-parsing tests**

```typescript
// client/test/unit/learning-approach/types.test.ts
import { describe, expect, it } from 'vitest';
import {
  LearningApproachV0BundleManifestSchema,
  LearningApproachV0TaskSchema,
  LearningApproachV0SolutionSchema,
  LearningApproachV0VerdictSchema,
} from '../../../src/types/learning-approach-v0.js';

describe('LearningApproachV0 schemas', () => {
  it('accepts a minimal valid bundle manifest', () => {
    const valid = {
      schemaVersion: 'learning-approach-v0-bundle.v1',
      intervention_kind: 'harness-mutation',
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['jinn/learner@HEAD'],
      train_arm_tasks: 50,
      declared_compute_ceiling_usd: 25,
      description_freeform: 'baseline',
    };
    expect(() => LearningApproachV0BundleManifestSchema.parse(valid)).not.toThrow();
  });

  it('rejects a manifest missing required fields', () => {
    expect(() => LearningApproachV0BundleManifestSchema.parse({ harness: 'claude-code' }))
      .toThrow();
  });

  it('parses a task spec referencing a bundle CID', () => {
    const task = {
      schemaVersion: 'learning-approach-v0.v1',
      probe_slate_version: 'v1',
      novelty_threshold: 1,
    };
    expect(() => LearningApproachV0TaskSchema.parse(task)).not.toThrow();
  });

  it('parses a solution payload pointing at bundle CID + probe-outputs CID', () => {
    const solution = {
      schemaVersion: 'learning-approach-v0-solution.v1',
      bundleCid: 'bafy...',
      probeOutputsCid: 'bafy...',
    };
    expect(() => LearningApproachV0SolutionSchema.parse(solution)).not.toThrow();
  });

  it('parses a verdict with accept/reject and signature', () => {
    const verdict = {
      schemaVersion: 'learning-approach-v0-verdict.v1',
      accepted: true,
      reason: 'novelty_above_threshold',
      signature: {
        passVector: [true, false, true, true, false],
        patchSha256: ['sha256:a', 'sha256:b', 'sha256:c', 'sha256:d', 'sha256:e'],
      },
      nearestNeighbourBundleCid: null,
      distance: Infinity,
    };
    expect(() => LearningApproachV0VerdictSchema.parse(verdict)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd client && yarn vitest run test/unit/learning-approach/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the schemas**

```typescript
// client/src/types/learning-approach-v0.ts
import { z } from 'zod';

export const InterventionKindSchema = z.enum([
  'harness-mutation',
  'corpus-seed',
  'teacher-distill',
  'retrieval-policy',
  'hybrid',
  'other',
]);

export const LearningApproachV0BundleManifestSchema = z.object({
  schemaVersion: z.literal('learning-approach-v0-bundle.v1'),
  intervention_kind: InterventionKindSchema,
  harness: z.string().min(1),
  model: z.string().min(1),
  plugins: z.array(z.string().min(1)),
  train_arm_tasks: z.number().int().nonnegative(),
  declared_compute_ceiling_usd: z.number().positive(),
  description_freeform: z.string().min(1).max(2000),
});
export type LearningApproachV0BundleManifest = z.infer<typeof LearningApproachV0BundleManifestSchema>;

export const LearningApproachV0TaskSchema = z.object({
  schemaVersion: z.literal('learning-approach-v0.v1'),
  probe_slate_version: z.string().min(1),
  novelty_threshold: z.number().nonnegative(),
});
export type LearningApproachV0Task = z.infer<typeof LearningApproachV0TaskSchema>;

export const LearningApproachV0SolutionSchema = z.object({
  schemaVersion: z.literal('learning-approach-v0-solution.v1'),
  bundleCid: z.string().min(1),
  probeOutputsCid: z.string().min(1),
});
export type LearningApproachV0Solution = z.infer<typeof LearningApproachV0SolutionSchema>;

export const BehaviouralSignatureSchema = z.object({
  passVector: z.array(z.boolean()).length(5),
  patchSha256: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$|^sha256:[A-Za-z0-9]+$/)).length(5),
});
export type BehaviouralSignature = z.infer<typeof BehaviouralSignatureSchema>;

export const LearningApproachV0VerdictSchema = z.object({
  schemaVersion: z.literal('learning-approach-v0-verdict.v1'),
  accepted: z.boolean(),
  reason: z.enum(['novelty_above_threshold', 'too_similar', 'run_failed', 'malformed_bundle']),
  signature: BehaviouralSignatureSchema.nullable(),
  nearestNeighbourBundleCid: z.string().nullable(),
  distance: z.union([z.number().nonnegative(), z.literal(Infinity)]),
});
export type LearningApproachV0Verdict = z.infer<typeof LearningApproachV0VerdictSchema>;
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd client && yarn vitest run test/unit/learning-approach/types.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/types/learning-approach-v0.ts client/test/unit/learning-approach/types.test.ts
git commit -m "feat(learning-approach): zod schemas for bundle, task, solution, verdict

Defines the v0 wire-level types for the learning-approach SolverType.
Per spec/2026-06-10-learning-approach-solvernet.md §3.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Behavioural signature + distance metric (pure functions)

**Files:**
- Create: `client/src/learning-approach/signature.ts`
- Test: `client/test/unit/learning-approach/signature.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// client/test/unit/learning-approach/signature.test.ts
import { describe, expect, it } from 'vitest';
import { computeDistance, makeSignature } from '../../../src/learning-approach/signature.js';
import type { BehaviouralSignature } from '../../../src/types/learning-approach-v0.js';

const sig = (pass: boolean[], shas: string[]): BehaviouralSignature => ({
  passVector: pass,
  patchSha256: shas.map((s) => `sha256:${s}`),
});

describe('makeSignature', () => {
  it('produces a signature with the expected shape', () => {
    const got = makeSignature([
      { passed: true, patchSha256: 'sha256:a' },
      { passed: false, patchSha256: 'sha256:b' },
      { passed: true, patchSha256: 'sha256:c' },
      { passed: true, patchSha256: 'sha256:d' },
      { passed: false, patchSha256: 'sha256:e' },
    ]);
    expect(got.passVector).toEqual([true, false, true, true, false]);
    expect(got.patchSha256).toHaveLength(5);
  });
});

describe('computeDistance', () => {
  const s1 = sig([true, true, true, true, true], ['a', 'b', 'c', 'd', 'e']);
  const s1Copy = sig([true, true, true, true, true], ['a', 'b', 'c', 'd', 'e']);
  const s2 = sig([false, false, false, false, false], ['x', 'y', 'z', 'w', 'v']);
  const s3 = sig([true, true, true, true, true], ['x', 'y', 'z', 'w', 'v']);  // same pass, different patches

  it('identical signatures have distance 0', () => {
    expect(computeDistance(s1, s1Copy)).toBe(0);
  });

  it('completely-different signatures have distance > 1', () => {
    expect(computeDistance(s1, s2)).toBeGreaterThan(1);
  });

  it('same PASS vector but different patches still has non-zero distance', () => {
    expect(computeDistance(s1, s3)).toBeGreaterThan(0);
  });

  it('is symmetric', () => {
    expect(computeDistance(s1, s2)).toBe(computeDistance(s2, s1));
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd client && yarn vitest run test/unit/learning-approach/signature.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement signature + distance**

```typescript
// client/src/learning-approach/signature.ts
import type { BehaviouralSignature } from '../types/learning-approach-v0.js';

export interface ProbeTaskResult {
  passed: boolean;
  patchSha256: string;  // 'sha256:<hex>'
}

export function makeSignature(results: ProbeTaskResult[]): BehaviouralSignature {
  if (results.length !== 5) {
    throw new Error(`makeSignature expects 5 probe results, got ${results.length}`);
  }
  return {
    passVector: results.map((r) => r.passed),
    patchSha256: results.map((r) => r.patchSha256),
  };
}

// Hamming distance on PASS vector (range 0..5).
function hamming(a: boolean[], b: boolean[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d += 1;
  return d;
}

// Jaccard distance on patch SHA sets (range 0..1).
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const intersection = new Set([...A].filter((x) => B.has(x)));
  const union = new Set([...A, ...B]);
  if (union.size === 0) return 0;
  return 1 - intersection.size / union.size;
}

// Combined distance — Hamming (0..5) summed with Jaccard scaled to (0..5).
export function computeDistance(a: BehaviouralSignature, b: BehaviouralSignature): number {
  return hamming(a.passVector, b.passVector) + 5 * jaccard(a.patchSha256, b.patchSha256);
}
```

- [ ] **Step 4: Confirm pass**

Run: `cd client && yarn vitest run test/unit/learning-approach/signature.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/learning-approach/signature.ts client/test/unit/learning-approach/signature.test.ts
git commit -m "feat(learning-approach): behavioural signature + distance metric

Pure functions: 5-task PASS vector + patch SHA-256 set; distance is
Hamming-on-PASS + 5*Jaccard-on-patches. Tuneable, replaceable per
spec §3.3.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Probe slate fixture + reuse the generic slate loader

**Files:**
- Create: `client/src/solver-types/slates/held-out-slate.learning-approach-v0.v1.json`
- Test: `client/test/unit/learning-approach/probe-slate.test.ts`

- [ ] **Step 1: Pick 5 representative swe-rebench-v2 instance IDs**

Read the existing swe-rebench-v2 v2 slate to pick 5 covering the span:
```bash
cat client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v2.json | head -40
```

Pick 5 by hand spanning common difficulty bands (small / medium / large patch, common languages). Record the instance_ids as a comment in this task description before proceeding — the actual list is a curation judgment, not auto-derivable.

- [ ] **Step 2: Write failing slate-loader test**

```typescript
// client/test/unit/learning-approach/probe-slate.test.ts
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadHeldOutSlate } from '../../../src/solver-types/_swe-rebench-v2-held-out-slate.js';

const slateDir = path.resolve(__dirname, '../../../src/solver-types/slates');

describe('probe slate loader', () => {
  it('loads the learning-approach-v0 v1 probe slate with exactly 5 instances', () => {
    const slate = loadHeldOutSlate('learning-approach-v0.v1', 'v1', { dir: slateDir });
    expect(slate.instanceIds.size).toBe(5);
    expect(slate.version).toBe('v1');
    expect(slate.hash.startsWith('sha256:')).toBe(true);
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `cd client && yarn vitest run test/unit/learning-approach/probe-slate.test.ts`
Expected: FAIL — slate file not found.

- [ ] **Step 4: Write the slate JSON**

Replace `<instance_id_N>` with the 5 IDs chosen in Step 1:

```json
{
  "schemaVersion": "held-out-slate.v1",
  "solverType": "learning-approach-v0.v1",
  "version": "v1",
  "generatedAt": "2026-06-10T00:00:00Z",
  "instanceIds": [
    "<instance_id_1>",
    "<instance_id_2>",
    "<instance_id_3>",
    "<instance_id_4>",
    "<instance_id_5>"
  ]
}
```

Save at `client/src/solver-types/slates/held-out-slate.learning-approach-v0.v1.json`.

- [ ] **Step 5: Confirm pass**

Run: `cd client && yarn vitest run test/unit/learning-approach/probe-slate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/solver-types/slates/held-out-slate.learning-approach-v0.v1.json client/test/unit/learning-approach/probe-slate.test.ts
git commit -m "feat(learning-approach): v1 probe slate — 5 hand-picked swe-rebench tasks

Per spec §3.4. Public, fixed for v0. Reuses the generic slate loader
in _swe-rebench-v2-held-out-slate.ts.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: In-process novelty registry (SQLite-backed via existing `Store`)

**Files:**
- Modify: `client/src/store/store.ts` (add table + accessor methods)
- Create: `client/src/learning-approach/registry.ts`
- Test: `client/test/unit/learning-approach/registry.test.ts`

- [ ] **Step 1: Write failing registry tests**

```typescript
// client/test/unit/learning-approach/registry.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../../src/store/store.js';
import { NoveltyRegistry } from '../../../src/learning-approach/registry.js';
import type { BehaviouralSignature } from '../../../src/types/learning-approach-v0.js';

const sig = (pass: boolean[], shas: string[]): BehaviouralSignature => ({
  passVector: pass,
  patchSha256: shas.map((s) => `sha256:${s}`),
});

describe('NoveltyRegistry', () => {
  let store: Store;
  let reg: NoveltyRegistry;
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'novelty-'));
    store = new Store(path.join(dir, 'test.db'));
    reg = new NoveltyRegistry(store);
  });

  it('empty registry returns Infinity for nearest neighbour distance', () => {
    const got = reg.nearestNeighbour(sig([true, true, true, true, true], ['a', 'b', 'c', 'd', 'e']));
    expect(got.distance).toBe(Infinity);
    expect(got.bundleCid).toBeNull();
  });

  it('stores and returns matching signatures', () => {
    const s = sig([true, false, true, false, true], ['a', 'b', 'c', 'd', 'e']);
    reg.register('bafy-bundle-a', s);
    const got = reg.nearestNeighbour(s);
    expect(got.distance).toBe(0);
    expect(got.bundleCid).toBe('bafy-bundle-a');
  });

  it('picks the closer of two registered signatures', () => {
    reg.register('bafy-bundle-a', sig([true, true, true, true, true], ['a', 'b', 'c', 'd', 'e']));
    reg.register('bafy-bundle-b', sig([false, false, false, false, false], ['x', 'y', 'z', 'w', 'v']));
    const got = reg.nearestNeighbour(sig([true, true, true, true, true], ['a', 'b', 'c', 'd', 'e']));
    expect(got.bundleCid).toBe('bafy-bundle-a');
    expect(got.distance).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd client && yarn vitest run test/unit/learning-approach/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the SQLite table to Store**

Read `client/src/store/store.ts` first to follow existing patterns (table creation in constructor, prepared statements). Add:

```typescript
// In Store constructor's CREATE TABLE block (locate via existing CREATE TABLE statements):
this.db.exec(`
  CREATE TABLE IF NOT EXISTS learning_approach_registry (
    bundle_cid TEXT PRIMARY KEY,
    signature_json TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
```

Add two accessor methods:
```typescript
registerLearningApproachBundle(bundleCid: string, signatureJson: string): void {
  this.db
    .prepare(`INSERT OR REPLACE INTO learning_approach_registry (bundle_cid, signature_json) VALUES (?, ?)`)
    .run(bundleCid, signatureJson);
}

listLearningApproachRegistry(): { bundleCid: string; signatureJson: string }[] {
  return this.db
    .prepare(`SELECT bundle_cid as bundleCid, signature_json as signatureJson FROM learning_approach_registry`)
    .all() as { bundleCid: string; signatureJson: string }[];
}
```

- [ ] **Step 4: Implement NoveltyRegistry**

```typescript
// client/src/learning-approach/registry.ts
import type { Store } from '../store/store.js';
import {
  BehaviouralSignatureSchema,
  type BehaviouralSignature,
} from '../types/learning-approach-v0.js';
import { computeDistance } from './signature.js';

export interface NearestNeighbour {
  bundleCid: string | null;
  distance: number;
}

export class NoveltyRegistry {
  constructor(private readonly store: Store) {}

  register(bundleCid: string, signature: BehaviouralSignature): void {
    this.store.registerLearningApproachBundle(bundleCid, JSON.stringify(signature));
  }

  nearestNeighbour(candidate: BehaviouralSignature): NearestNeighbour {
    const rows = this.store.listLearningApproachRegistry();
    let best: NearestNeighbour = { bundleCid: null, distance: Infinity };
    for (const row of rows) {
      const sig = BehaviouralSignatureSchema.parse(JSON.parse(row.signatureJson));
      const d = computeDistance(candidate, sig);
      if (d < best.distance) best = { bundleCid: row.bundleCid, distance: d };
    }
    return best;
  }
}
```

- [ ] **Step 5: Confirm pass**

Run: `cd client && yarn vitest run test/unit/learning-approach/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/store/store.ts client/src/learning-approach/registry.ts client/test/unit/learning-approach/registry.test.ts
git commit -m "feat(learning-approach): in-process novelty registry backed by Store

SQLite table learning_approach_registry + NoveltyRegistry class with
register() / nearestNeighbour(). v0 local — ERC-8004 wiring deferred
to Milestone 2.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: SolverType definition + registration

**Files:**
- Create: `client/src/solver-types/learning-approach-v0.ts`
- Modify: `client/src/solver-types/index.ts`
- Test: `client/test/unit/learning-approach/solver-type.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// client/test/unit/learning-approach/solver-type.test.ts
import { describe, expect, it } from 'vitest';
import { learningApproachV0 } from '../../../src/solver-types/learning-approach-v0.js';
import { SOLVER_TYPES } from '../../../src/solver-types/index.js';

describe('learningApproachV0 SolverTypeDefinition', () => {
  it('has the expected solverType id', () => {
    expect(learningApproachV0.solverType).toBe('learning-approach-v0.v1');
  });

  it('parseSpec parses a minimal task spec', async () => {
    const parsed = await learningApproachV0.parseSpec({
      schemaVersion: 'learning-approach-v0.v1',
      probe_slate_version: 'v1',
      novelty_threshold: 1,
    });
    expect(parsed.spec.probe_slate_version).toBe('v1');
  });

  it('is registered in SOLVER_TYPES', () => {
    expect(SOLVER_TYPES['learning-approach-v0.v1']).toBe(learningApproachV0);
  });

  it('loadHeldOutSlate loads the probe slate', () => {
    const slate = learningApproachV0.loadHeldOutSlate!('v1');
    expect(slate.instanceIds.size).toBe(5);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd client && yarn vitest run test/unit/learning-approach/solver-type.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the SolverType**

```typescript
// client/src/solver-types/learning-approach-v0.ts
import type { SolverTypeDefinition } from './solver-type.js';
import { LearningApproachV0TaskSchema } from '../types/learning-approach-v0.js';
import { loadHeldOutSlate } from './_swe-rebench-v2-held-out-slate.js';

export const learningApproachV0: SolverTypeDefinition<unknown> = {
  solverType: 'learning-approach-v0.v1',
  async parseSpec(raw) {
    const task = LearningApproachV0TaskSchema.parse(raw);
    return { window: undefined, spec: task, eligibility: {} };
  },
  loadHeldOutSlate: (version) => loadHeldOutSlate('learning-approach-v0.v1', version),
  ui: {
    description: 'Propose a learning approach for swe-rebench-v2. Verdict: behavioural novelty.',
    category: 'meta',
  },
};
```

- [ ] **Step 4: Register**

Modify `client/src/solver-types/index.ts` — locate `SOLVER_TYPES` and add:

```typescript
import { learningApproachV0 } from './learning-approach-v0.js';
// inside SOLVER_TYPES:
'learning-approach-v0.v1': learningApproachV0,
```

- [ ] **Step 5: Confirm pass**

Run: `cd client && yarn vitest run test/unit/learning-approach/solver-type.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/solver-types/learning-approach-v0.ts client/src/solver-types/index.ts client/test/unit/learning-approach/solver-type.test.ts
git commit -m "feat(learning-approach): SolverTypeDefinition for learning-approach-v0.v1

Registers the new SolverType. parseSpec validates the task schema;
loadHeldOutSlate returns the 5-task probe set.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: LearningApproachV0Evaluator (mocked-harness flow)

**Files:**
- Create: `client/src/learning-approach/evaluator.ts`
- Test: `client/test/unit/learning-approach/evaluator.test.ts`

The evaluator's responsibility: take a bundle + a probe-runner callback, run the bundle on the 5 probe tasks, build a signature, query the registry, decide accept/reject. The probe-runner is INJECTED so tests use a mock; the e2e tests inject a real harness call.

- [ ] **Step 1: Write failing evaluator tests**

```typescript
// client/test/unit/learning-approach/evaluator.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../../src/store/store.js';
import { NoveltyRegistry } from '../../../src/learning-approach/registry.js';
import { LearningApproachV0Evaluator } from '../../../src/learning-approach/evaluator.js';
import type { LearningApproachV0BundleManifest } from '../../../src/types/learning-approach-v0.js';

const bundleA: LearningApproachV0BundleManifest = {
  schemaVersion: 'learning-approach-v0-bundle.v1',
  intervention_kind: 'harness-mutation',
  harness: 'claude-code',
  model: 'claude-haiku-4-5-20251001',
  plugins: ['jinn/learner@HEAD'],
  train_arm_tasks: 0,
  declared_compute_ceiling_usd: 25,
  description_freeform: 'baseline',
};

const bundleB: LearningApproachV0BundleManifest = { ...bundleA, model: 'claude-opus-4-8', description_freeform: 'opus' };

const PROBE_INSTANCE_IDS = new Set(['p1', 'p2', 'p3', 'p4', 'p5']);

describe('LearningApproachV0Evaluator', () => {
  let store: Store;
  let registry: NoveltyRegistry;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eval-'));
    store = new Store(path.join(dir, 'test.db'));
    registry = new NoveltyRegistry(store);
  });

  it('accepts the first bundle (empty registry → distance = Infinity)', async () => {
    const probeRunner = async () =>
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((_, i) => ({ passed: i % 2 === 0, patchSha256: `sha256:a${i}` }));
    const evaluator = new LearningApproachV0Evaluator({
      registry,
      probeInstanceIds: PROBE_INSTANCE_IDS,
      probeRunner,
      noveltyThreshold: 1,
    });
    const verdict = await evaluator.evaluate({ bundleCid: 'bafy-a', bundleManifest: bundleA });
    expect(verdict.accepted).toBe(true);
    expect(verdict.reason).toBe('novelty_above_threshold');
    expect(verdict.distance).toBe(Infinity);
  });

  it('accepts a second bundle that is far from the first', async () => {
    const probeRunner = async () =>
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((_, i) => ({ passed: i % 2 === 0, patchSha256: `sha256:a${i}` }));
    const evA = new LearningApproachV0Evaluator({ registry, probeInstanceIds: PROBE_INSTANCE_IDS, probeRunner, noveltyThreshold: 1 });
    await evA.evaluate({ bundleCid: 'bafy-a', bundleManifest: bundleA });

    const probeRunnerFar = async () =>
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((_, i) => ({ passed: i % 2 === 1, patchSha256: `sha256:b${i}` }));
    const evB = new LearningApproachV0Evaluator({ registry, probeInstanceIds: PROBE_INSTANCE_IDS, probeRunner: probeRunnerFar, noveltyThreshold: 1 });
    const verdict = await evB.evaluate({ bundleCid: 'bafy-b', bundleManifest: bundleB });
    expect(verdict.accepted).toBe(true);
    expect(verdict.distance).toBeGreaterThan(1);
  });

  it('rejects a duplicate of an existing entry (distance below threshold)', async () => {
    const probeRunner = async () =>
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((_, i) => ({ passed: i % 2 === 0, patchSha256: `sha256:a${i}` }));
    const ev = new LearningApproachV0Evaluator({ registry, probeInstanceIds: PROBE_INSTANCE_IDS, probeRunner, noveltyThreshold: 1 });
    await ev.evaluate({ bundleCid: 'bafy-a', bundleManifest: bundleA });
    const verdict = await ev.evaluate({ bundleCid: 'bafy-a-dup', bundleManifest: bundleA });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('too_similar');
    expect(verdict.distance).toBe(0);
  });

  it('rejects when the probe runner throws (run_failed)', async () => {
    const probeRunner = async () => { throw new Error('harness died'); };
    const ev = new LearningApproachV0Evaluator({ registry, probeInstanceIds: PROBE_INSTANCE_IDS, probeRunner, noveltyThreshold: 1 });
    const verdict = await ev.evaluate({ bundleCid: 'bafy-broken', bundleManifest: bundleA });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe('run_failed');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd client && yarn vitest run test/unit/learning-approach/evaluator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the evaluator**

```typescript
// client/src/learning-approach/evaluator.ts
import type { NoveltyRegistry } from './registry.js';
import { makeSignature, type ProbeTaskResult } from './signature.js';
import type {
  LearningApproachV0BundleManifest,
  LearningApproachV0Verdict,
} from '../types/learning-approach-v0.js';

export type ProbeRunner = (args: {
  bundleManifest: LearningApproachV0BundleManifest;
  probeInstanceIds: Set<string>;
}) => Promise<ProbeTaskResult[]>;

export interface LearningApproachV0EvaluatorOpts {
  registry: NoveltyRegistry;
  probeInstanceIds: Set<string>;
  probeRunner: ProbeRunner;
  noveltyThreshold: number;
}

export class LearningApproachV0Evaluator {
  constructor(private readonly opts: LearningApproachV0EvaluatorOpts) {}

  async evaluate(args: {
    bundleCid: string;
    bundleManifest: LearningApproachV0BundleManifest;
  }): Promise<LearningApproachV0Verdict> {
    let results: ProbeTaskResult[];
    try {
      results = await this.opts.probeRunner({
        bundleManifest: args.bundleManifest,
        probeInstanceIds: this.opts.probeInstanceIds,
      });
    } catch {
      return {
        schemaVersion: 'learning-approach-v0-verdict.v1',
        accepted: false,
        reason: 'run_failed',
        signature: null,
        nearestNeighbourBundleCid: null,
        distance: 0,
      };
    }

    if (results.length !== this.opts.probeInstanceIds.size) {
      return {
        schemaVersion: 'learning-approach-v0-verdict.v1',
        accepted: false,
        reason: 'malformed_bundle',
        signature: null,
        nearestNeighbourBundleCid: null,
        distance: 0,
      };
    }

    const signature = makeSignature(results);
    const nn = this.opts.registry.nearestNeighbour(signature);
    const accepted = nn.distance > this.opts.noveltyThreshold;

    if (accepted) this.opts.registry.register(args.bundleCid, signature);

    return {
      schemaVersion: 'learning-approach-v0-verdict.v1',
      accepted,
      reason: accepted ? 'novelty_above_threshold' : 'too_similar',
      signature,
      nearestNeighbourBundleCid: nn.bundleCid,
      distance: nn.distance,
    };
  }
}
```

- [ ] **Step 4: Confirm pass**

Run: `cd client && yarn vitest run test/unit/learning-approach/evaluator.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/learning-approach/evaluator.ts client/test/unit/learning-approach/evaluator.test.ts
git commit -m "feat(learning-approach): LearningApproachV0Evaluator with injected probe runner

The evaluator takes a bundle, runs it on the probe set via an
injected ProbeRunner (mocked in unit tests, real harness in e2e),
computes signature, queries registry, accepts if distance >
threshold. Probe runner injection is the seam for testing.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Evaluator harness shell + registration

**Files:**
- Create: `client/src/harnesses/impls/learning-approach-v0-evaluator/index.ts`
- Modify: `client/src/harnesses/impls/index.ts` (register in `buildHarnesses`)
- Test: `client/test/unit/harnesses/learning-approach-v0-evaluator.test.ts`

- [ ] **Step 1: Read existing evaluator harness for shape reference**

Run:
```bash
ls client/src/harnesses/impls/ | head
```
Pick the closest existing role:'evaluation' harness (likely a swe-rebench-v2 evaluator) and read its module to mirror the `supports` predicate + `run` shape. Take notes on:
- The `Harness` type signature
- The `supports({ solverType, role })` predicate
- The `run(ctx)` flow — what `ctx` exposes

- [ ] **Step 2: Write failing harness test**

```typescript
// client/test/unit/harnesses/learning-approach-v0-evaluator.test.ts
import { describe, expect, it } from 'vitest';
import { learningApproachV0EvaluatorHarness } from '../../../src/harnesses/impls/learning-approach-v0-evaluator/index.js';

describe('learning-approach-v0 evaluator harness', () => {
  it('supports solverType=learning-approach-v0.v1 + role=evaluation', () => {
    expect(learningApproachV0EvaluatorHarness.supports({
      solverType: 'learning-approach-v0.v1',
      role: 'evaluation',
    })).toBe(true);
  });

  it('does not support unrelated SolverTypes', () => {
    expect(learningApproachV0EvaluatorHarness.supports({
      solverType: 'swe-rebench-v2.v1',
      role: 'evaluation',
    })).toBe(false);
  });

  it('does not support the solver role for its own SolverType (v0 only evaluates)', () => {
    expect(learningApproachV0EvaluatorHarness.supports({
      solverType: 'learning-approach-v0.v1',
      role: 'restoration',
    })).toBe(false);
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `cd client && yarn vitest run test/unit/harnesses/learning-approach-v0-evaluator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the harness skeleton**

Mirror the existing evaluator harness shape exactly (see Step 1 notes). Skeleton:

```typescript
// client/src/harnesses/impls/learning-approach-v0-evaluator/index.ts
import type { Harness, HarnessContext } from '../../types.js';

export const learningApproachV0EvaluatorHarness: Harness = {
  name: 'learning-approach-v0-evaluator',
  supports({ solverType, role }) {
    return solverType === 'learning-approach-v0.v1' && role === 'evaluation';
  },
  async run(ctx: HarnessContext) {
    // TODO Task 9: wire LearningApproachV0Evaluator end-to-end here using a
    // real probe runner backed by runEval orchestrator. Until then this
    // harness will fail loudly on live invocation — which is correct, the
    // unit test only exercises `supports`. Real wiring is Task 9.
    throw new Error('learning-approach-v0-evaluator harness wiring lands in Task 9');
  },
};
```

(Adjust import paths to match the existing `Harness` / `HarnessContext` types — read the reference harness's imports.)

- [ ] **Step 5: Register in buildHarnesses**

Modify `client/src/harnesses/impls/index.ts` — locate the existing evaluator-harness registrations and add:

```typescript
import { learningApproachV0EvaluatorHarness } from './learning-approach-v0-evaluator/index.js';
// inside buildHarnesses, append to the harnesses list:
harnesses.push(learningApproachV0EvaluatorHarness);
```

- [ ] **Step 6: Confirm pass**

Run: `cd client && yarn vitest run test/unit/harnesses/learning-approach-v0-evaluator.test.ts && yarn typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add client/src/harnesses/impls/learning-approach-v0-evaluator/ client/src/harnesses/impls/index.ts client/test/unit/harnesses/learning-approach-v0-evaluator.test.ts
git commit -m "feat(learning-approach): evaluator-harness skeleton + buildHarnesses registration

Skeleton supports() works; run() throws until Task 9 wires the
real probe runner via runEval orchestrator. Tested at the supports
boundary only.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Seed bundle fixtures (A baseline + B model-swap)

**Files:**
- Create: `client/fixtures/learning-approach-v0/bundle-a.example.json`
- Create: `client/fixtures/learning-approach-v0/bundle-b.example.json`
- Test: `client/test/unit/learning-approach/seed-bundles.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// client/test/unit/learning-approach/seed-bundles.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LearningApproachV0BundleManifestSchema } from '../../../src/types/learning-approach-v0.js';

const fixDir = path.resolve(__dirname, '../../../fixtures/learning-approach-v0');

describe('seed bundle fixtures', () => {
  it('bundle-a (baseline) parses against the manifest schema', () => {
    const raw = JSON.parse(readFileSync(path.join(fixDir, 'bundle-a.example.json'), 'utf-8'));
    const parsed = LearningApproachV0BundleManifestSchema.parse(raw);
    expect(parsed.model).toBe('claude-haiku-4-5-20251001');
  });

  it('bundle-b (opus swap) parses and differs from A only in model', () => {
    const a = JSON.parse(readFileSync(path.join(fixDir, 'bundle-a.example.json'), 'utf-8'));
    const b = JSON.parse(readFileSync(path.join(fixDir, 'bundle-b.example.json'), 'utf-8'));
    const parsed = LearningApproachV0BundleManifestSchema.parse(b);
    expect(parsed.model).not.toBe(a.model);
    expect(parsed.harness).toBe(a.harness);
    expect(parsed.plugins).toEqual(a.plugins);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd client && yarn vitest run test/unit/learning-approach/seed-bundles.test.ts`
Expected: FAIL — files not found.

- [ ] **Step 3: Write bundle A (baseline)**

```json
{
  "schemaVersion": "learning-approach-v0-bundle.v1",
  "intervention_kind": "harness-mutation",
  "harness": "claude-code",
  "model": "claude-haiku-4-5-20251001",
  "plugins": ["jinn/learner@HEAD"],
  "train_arm_tasks": 0,
  "declared_compute_ceiling_usd": 25,
  "description_freeform": "Baseline. Production learner harness + Haiku. Seeds the registry."
}
```

Save at `client/fixtures/learning-approach-v0/bundle-a.example.json`.

- [ ] **Step 4: Write bundle B (Opus swap)**

```json
{
  "schemaVersion": "learning-approach-v0-bundle.v1",
  "intervention_kind": "harness-mutation",
  "harness": "claude-code",
  "model": "claude-opus-4-8",
  "plugins": ["jinn/learner@HEAD"],
  "train_arm_tasks": 0,
  "declared_compute_ceiling_usd": 100,
  "description_freeform": "Model-only swap to Opus 4.8. Tests whether model substitution produces behavioural novelty on the probe set without other changes."
}
```

Save at `client/fixtures/learning-approach-v0/bundle-b.example.json`.

- [ ] **Step 5: Confirm pass**

Run: `cd client && yarn vitest run test/unit/learning-approach/seed-bundles.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/fixtures/learning-approach-v0/ client/test/unit/learning-approach/seed-bundles.test.ts
git commit -m "feat(learning-approach): seed bundles A (baseline) and B (Opus swap)

Per spec §6 step 3. Two bundles ready for the v0 closed-loop demo.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Mocked-harness e2e — the closed loop

**Files:**
- Create: `client/test/e2e/learning-approach-novelty-loop.test.ts`

- [ ] **Step 1: Write the e2e test**

```typescript
// client/test/e2e/learning-approach-novelty-loop.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../src/store/store.js';
import { NoveltyRegistry } from '../../src/learning-approach/registry.js';
import { LearningApproachV0Evaluator, type ProbeRunner } from '../../src/learning-approach/evaluator.js';
import { LearningApproachV0BundleManifestSchema } from '../../src/types/learning-approach-v0.js';
import { learningApproachV0 } from '../../src/solver-types/learning-approach-v0.js';

const fixDir = path.resolve(__dirname, '../../fixtures/learning-approach-v0');

// Mock probe runner: returns deterministic per-bundle outputs so the test is
// reproducible. Real harness wiring lives in the real-probe e2e (Task 10).
const makeMockRunner = (passVector: boolean[], shaPrefix: string): ProbeRunner => async () =>
  passVector.map((passed, i) => ({ passed, patchSha256: `sha256:${shaPrefix}${i}` }));

describe('learning-approach v0 — closed novelty loop', () => {
  it('two distinct bundles → both accepted → duplicate rejected', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'la-loop-'));
    const store = new Store(path.join(dir, 'test.db'));
    const registry = new NoveltyRegistry(store);
    const probeInstanceIds = learningApproachV0.loadHeldOutSlate!('v1').instanceIds;
    expect(probeInstanceIds.size).toBe(5);

    const bundleA = LearningApproachV0BundleManifestSchema.parse(
      JSON.parse(readFileSync(path.join(fixDir, 'bundle-a.example.json'), 'utf-8')),
    );
    const bundleB = LearningApproachV0BundleManifestSchema.parse(
      JSON.parse(readFileSync(path.join(fixDir, 'bundle-b.example.json'), 'utf-8')),
    );

    // Bundle A: pass on 2 of 5 (Haiku baseline).
    const verdictA = await new LearningApproachV0Evaluator({
      registry,
      probeInstanceIds,
      probeRunner: makeMockRunner([true, false, true, false, false], 'a'),
      noveltyThreshold: 1,
    }).evaluate({ bundleCid: 'bafy-a', bundleManifest: bundleA });
    expect(verdictA.accepted).toBe(true);
    expect(verdictA.distance).toBe(Infinity);

    // Bundle B: pass on 4 of 5 (Opus) and different patches.
    const verdictB = await new LearningApproachV0Evaluator({
      registry,
      probeInstanceIds,
      probeRunner: makeMockRunner([true, true, true, true, false], 'b'),
      noveltyThreshold: 1,
    }).evaluate({ bundleCid: 'bafy-b', bundleManifest: bundleB });
    expect(verdictB.accepted).toBe(true);
    expect(verdictB.distance).toBeGreaterThan(1);

    // Duplicate of A → rejected.
    const verdictADup = await new LearningApproachV0Evaluator({
      registry,
      probeInstanceIds,
      probeRunner: makeMockRunner([true, false, true, false, false], 'a'),
      noveltyThreshold: 1,
    }).evaluate({ bundleCid: 'bafy-a-dup', bundleManifest: bundleA });
    expect(verdictADup.accepted).toBe(false);
    expect(verdictADup.reason).toBe('too_similar');
    expect(verdictADup.distance).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd client && yarn vitest run test/e2e/learning-approach-novelty-loop.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/test/e2e/learning-approach-novelty-loop.test.ts
git commit -m "test(learning-approach): e2e closed loop with mocked probe runner

Verifies the v0 closed loop end-to-end: two distinct bundles both
accepted (registry grows), exact duplicate rejected. Probe runner
is mocked — real harness wiring is in the real-probe e2e (separate
opt-in test).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Real-harness probe e2e (opt-in, env-gated)

**Files:**
- Create: `client/test/e2e/learning-approach-real-probe.test.ts`

This test exercises the real `runEval` orchestrator with the learning-approach-v0 SolverType. It runs the seed bundle A against the 5-task probe set with the actual claude-code harness. Slow + costs API tokens — gated behind `JINN_E2E_REAL_PROBE=1`.

- [ ] **Step 1: Read the closest existing e2e to mirror**

Read `client/test/e2e/train-arm-slope-swe-rebench-v2.ts` end-to-end. Note specifically:
- How it instantiates `runEval` from `client/src/eval/orchestrator.ts`
- How it constructs `EvalOrchestratorDeps` (harness, evaluator, runHarnessOnce, store)
- How it resolves slate tasks from the swe-rebench pool (via `resolveSlateAgainstPool`)
- Its env-gating pattern (likely `JINN_E2E_*` env var or `describe.skipIf(...)`)

- [ ] **Step 2: Write the real-probe e2e**

The structure mirrors `train-arm-slope-swe-rebench-v2.ts` but the eval-side dependency is the LearningApproachV0Evaluator wrapping the orchestrator output. Skeleton:

```typescript
// client/test/e2e/learning-approach-real-probe.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../src/store/store.js';
import { NoveltyRegistry } from '../../src/learning-approach/registry.js';
import { LearningApproachV0Evaluator, type ProbeRunner } from '../../src/learning-approach/evaluator.js';
import { learningApproachV0 } from '../../src/solver-types/learning-approach-v0.js';
import { LearningApproachV0BundleManifestSchema } from '../../src/types/learning-approach-v0.js';
import { runEval } from '../../src/eval/orchestrator.js';
// + the same imports the train-arm-slope test uses for harness, evaluator,
//   runHarnessOnce, slate resolution. Copy that import block verbatim.

const REAL = process.env.JINN_E2E_REAL_PROBE === '1';
const fixDir = path.resolve(__dirname, '../../fixtures/learning-approach-v0');

describe.skipIf(!REAL)('learning-approach v0 — real probe run against swe-rebench-v2', () => {
  it('runs bundle A against 5 probe tasks, produces a signature, registers it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'la-real-'));
    const store = new Store(path.join(dir, 'test.db'));
    const registry = new NoveltyRegistry(store);

    // Build a ProbeRunner that wraps runEval. It:
    //   1. Takes the bundle manifest's {harness, model, plugins}.
    //   2. Resolves the probe slate via learningApproachV0.loadHeldOutSlate('v1').
    //   3. Resolves slate instance_ids to ResolvedSlateTask[] (mirror train-arm-slope's helper).
    //   4. Calls runEval with the swe-rebench-v2 evaluator (because the probe tasks ARE swe-rebench tasks).
    //   5. Reads runEval's perTask output → maps each ResolvedSlateTask → ProbeTaskResult { passed, patchSha256 }.
    const probeRunner: ProbeRunner = async ({ bundleManifest, probeInstanceIds }) => {
      // ↓↓↓ THIS IS THE LOAD-BEARING WIRING ↓↓↓
      // Mirror the train-arm-slope test's setup of runEval deps. Pass the
      // bundleManifest's harness/model/plugins through `JoinedSolverNetConfig`
      // (or equivalent override surface) so the harness uses them.
      // Treat the slate as the 5 probe instance_ids.
      // Convert runEval's `perTask` results to ProbeTaskResult[].
      throw new Error('Implement runEval wiring per Step 1 notes — load-bearing for Task 10.');
    };

    const bundleA = LearningApproachV0BundleManifestSchema.parse(
      JSON.parse(readFileSync(path.join(fixDir, 'bundle-a.example.json'), 'utf-8')),
    );
    const evaluator = new LearningApproachV0Evaluator({
      registry,
      probeInstanceIds: learningApproachV0.loadHeldOutSlate!('v1').instanceIds,
      probeRunner,
      noveltyThreshold: 1,
    });

    const verdict = await evaluator.evaluate({ bundleCid: 'bafy-a-real', bundleManifest: bundleA });
    expect(verdict.signature).not.toBeNull();
    expect(verdict.signature!.passVector).toHaveLength(5);
    expect(verdict.signature!.patchSha256).toHaveLength(5);
    // Registry is empty → first bundle is always accepted.
    expect(verdict.accepted).toBe(true);
  }, 30 * 60 * 1000);  // 30-minute timeout — real probe runs are slow.
});
```

- [ ] **Step 3: Implement the runEval wiring inside `probeRunner`**

This is the load-bearing step. Open `client/test/e2e/train-arm-slope-swe-rebench-v2.ts` side-by-side and copy the `runEval` setup verbatim, then:
- Pass `bundleManifest.harness` as the harness override, `bundleManifest.model` as the model override, `bundleManifest.plugins` as the plugin list. Look for the test's `joinedSolverNets` / `HarnessContext` construction — that's where these go.
- After `runEval` returns, walk its `perTask: PerTaskResult[]` and convert each to a `ProbeTaskResult`: `{ passed: !!task.passed, patchSha256: sha256(task.solutionPayload.patch) }`. Use `node:crypto` for the SHA.

- [ ] **Step 4: Run gated**

Run (skipped by default):
```bash
cd client && yarn vitest run test/e2e/learning-approach-real-probe.test.ts
```
Expected: SKIPPED (env var unset).

Run with the env var:
```bash
cd client && JINN_E2E_REAL_PROBE=1 yarn vitest run test/e2e/learning-approach-real-probe.test.ts
```
Expected: PASS (~10-30 minutes; costs real model spend).

- [ ] **Step 5: Commit**

```bash
git add client/test/e2e/learning-approach-real-probe.test.ts
git commit -m "test(learning-approach): opt-in real-probe e2e via runEval orchestrator

Gated by JINN_E2E_REAL_PROBE=1. Runs seed bundle A through the real
claude-code harness against the 5 probe tasks, verifies a real
signature is produced and the bundle registers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: Operator-facing runbook

**Files:**
- Create: `docs/runbooks/learning-approach-v0.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Runbook — learning-approach-v0 (Milestone 1)

> Status: M1 (local-only registry, no SolverNet yet). M2 lands manifest + ERC-8004.

This SolverType lets you propose a *learning approach* — a runnable
bundle that configures a swe-rebench-v2 operator's harness, model,
and plugins. The evaluator grades bundles on **behavioural novelty**
(how different they behave on a public 5-task probe set), not on
quality. Whether a bundle is *actually good* is decided downstream
by swe-rebench-v2 operators who pull it from the registry and
measure with `jinn eval`.

## A bundle

A directory containing:
- `manifest.json` — the operator-config slice the bundle declares
  (harness, model, plugins, train-arm budget, intervention kind).
  Schema in `client/src/types/learning-approach-v0.ts`.
- `plugin/` — optional. A Jinn plugin (or a diff against
  `client/plugins/learner`).
- `probe-outputs.json` — required. The solver's own probe-set
  outputs as proof-of-attempt (the evaluator's run is authoritative).

See `client/fixtures/learning-approach-v0/bundle-{a,b}.example.json`
for concrete examples.

## Running the evaluator locally (M1)

There is no `jinn submit-learning-approach` yet (M2). For now:
1. Run the mocked closed-loop e2e:
   `cd client && yarn vitest run test/e2e/learning-approach-novelty-loop.test.ts`
2. Run the real-probe e2e (slow + spends real model budget):
   `cd client && JINN_E2E_REAL_PROBE=1 yarn vitest run test/e2e/learning-approach-real-probe.test.ts`

## Out of scope for M1

- SolverNet launch / manifest on testnet
- On-chain ERC-8004 verdict
- Operator-facing CLI submit command
- Probe-set rotation
- Royalty / back-attribution to bundle authors

See `docs/superpowers/plans/2026-06-10-learning-approach-solvernet.md`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/learning-approach-v0.md
git commit -m "docs(learning-approach): runbook for M1 evaluator usage

Minimum operator-facing doc covering the bundle shape, the two
M1 test entry points, and the explicit M1-vs-M2 scope split.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: Verification before completion + file Milestone 2 Issue

- [ ] **Step 1: Run the full vitest suite**

Run: `cd client && yarn typecheck && yarn vitest run`
Expected: zero typecheck errors; all new tests PASS; no existing tests regress.

- [ ] **Step 2: Run the opt-in real-probe e2e once**

Run: `cd client && JINN_E2E_REAL_PROBE=1 yarn vitest run test/e2e/learning-approach-real-probe.test.ts`
Expected: PASS. Capture the signature output (PASS vector + patch SHAs) into the M2 Issue body as the first real bundle measurement.

- [ ] **Step 3: File the Milestone 2 follow-up Issue**

Use `gh issue create` with title:
`feat(learning-approach): Milestone 2 — SolverNet launch + ERC-8004 wiring + proposer test`

Body should include:
- Acceptance criteria
  - SolverNet manifest stood up via the `solvernet-creation-and-launch` flow with `solverType: 'learning-approach-v0.v1'` and `openRoles: ['solver', 'evaluator']`
  - Evaluator-side daemon claims tasks on this SolverNet and writes verdicts on-chain via ERC-8004 ValidationRegistry (the wiring job flagged in this plan)
  - Operator-facing CLI: `jinn submit-learning-approach <bundle-dir>`
  - First non-team proposer submission within 14 days of SolverNet open — the empirical "is the SolverNet framing right" gate from spec §6 step 6
- Linkage
  - Parents [#601 EPIC](https://github.com/Jinn-Network/mono/issues/601), Milestone #2.
  - References this M1 plan and `spec/2026-06-10-learning-approach-solvernet.md`.

- [ ] **Step 4: Final commit (only if anything changed)**

If Step 3 produced no code changes, no commit needed. Otherwise:

```bash
git add <touched files>
git commit -m "chore(learning-approach): M1 verification + file M2 follow-up issue

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-review note (resolved)

- **Spec coverage check.** §3.1 task (Task 5), §3.2 bundle (Task 1 + 8), §3.3 verdict mechanism (Task 2 + 6), §3.4 probe set (Task 3), §3.5 registry (Task 4; ERC-8004 deferred per (R4) finding), §3.6 reward (deferred — M2), §4 downstream usage (deferred to operator action, documented in runbook), §5 anti-overfit (no action needed at this layer per spec), §6 v0 closed loop (Tasks 9 + 10), §7 not-in-scope items consistent with what's deferred to M2 in this plan, §8 open questions remain open as designed.
- **Placeholder scan.** Tasks 3 step 4 and 10 step 3 both contain `<placeholder>` strings — these are intentional human-judgement gates (the 5 instance_ids; the runEval wiring against an existing pattern). They are not implementation laziness; they are honestly-named curation work flagged in spec §7. The runbook makes M1-vs-M2 scope explicit; nothing else has a placeholder.
- **Type consistency.** `LearningApproachV0BundleManifest`, `LearningApproachV0Verdict`, `BehaviouralSignature`, `ProbeRunner`, `NoveltyRegistry`, `LearningApproachV0Evaluator` — names used consistently across Tasks 1, 2, 4, 6, 7, 9, 10. `learningApproachV0` (SolverTypeDefinition) — single name in Tasks 5, 9, 10.
