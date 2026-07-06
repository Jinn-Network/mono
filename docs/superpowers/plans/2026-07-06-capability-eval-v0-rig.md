# Capability-Eval v0 Rig — Foundation + Spike Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the in-repo TypeScript foundation of the capability-eval v0 rig — the frozen slate artifact, the externally-recomputable corpus derived index, the three-axis disjointness proof, the contested-band screening predicate, the Connor power calc, and the paired quality+cost gate statistics — plus the spike that gates the follow-on orchestration plan.

**Architecture:** Pure, dependency-light TS modules under `client/src/eval/`, sitting beside the existing `paired.ts` / `wilson.ts` / `screen.ts` primitives they extend. Every function is pure (inputs → outputs, injected RNG where stochastic) so it is unit-testable with no Docker, no network, no model calls. The heavy, external pieces (running the two arms, cost capture) are a separate plan gated on the spike in §"Gate to Plan 2".

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node `crypto` (sha256), the shipped `canonicalJson` helper. No new dependencies.

## Global Constraints

- **Source of truth:** [`spec/2026-07-06-capability-eval-v0.md`](../../../spec/2026-07-06-capability-eval-v0.md) v0.2 and DR-2026-07-06. Every task traces to a spec section; where they diverge, the spec wins — update the spec in the same PR.
- **Reuse, do not reinvent** (spec §7): extend `client/src/eval/paired.ts`, `wilson.ts`, `screen.ts`, `client/scripts/power.ts`, and `client/src/solver-types/_swe-rebench-v2-held-out-slate.ts`. Do not fork them.
- **Pure + deterministic:** no `Date.now()` / `Math.random()` inside library functions — take a clock/RNG as an argument so tests are reproducible (matches the codebase's injection pattern in `hf-fetcher.ts`).
- **Fail-loud** on any disjointness or fidelity violation (spec §4.3) — throw, never return a soft warning.
- **Content-addressing** uses `sha256(canonicalJson(normalized))` with a `sha256:` prefix, mirroring `hashHeldOutSlateArtifact` / `hashVettedPoolArtifact` (spec §4.4).
- **Test framework:** Vitest. Tests live in `client/test/eval/`. Run a single file with `cd client && yarn vitest run test/eval/<file>.test.ts`.
- **Commit prefix:** `feat(capability-eval): …` per task; keep `yarn typecheck` green.
- This foundation is **mergeable and useful on its own**: it produces the `cap-v0` slate artifact + `excludeHeldOutSlate` consumer contract the distillation session (spec §12) is waiting on, independent of the orchestration plan.

---

## File Structure

| File | Responsibility |
|---|---|
| `client/src/eval/capability-slate.ts` | The `capability-slate.v1` artifact: schema, parse/validate, content hash. Extends the `HeldOutSlateArtifact` pattern (spec §4.4). |
| `client/src/eval/corpus-index.ts` | The public corpus **derived index**: enumerate corpus records → sorted repos + instance_ids + per-record MinHash token sketches → Merkle root (`corpusSnapshotCid`). Externally recomputable (spec §4.3). |
| `client/src/eval/disjointness.ts` | `assertCorpusDisjoint` — the three content axes (instance / repo / lexical) producing per-axis `flaggedPairs`, fail-loud. Extends the `assertNoOverlap` pattern (spec §4.3). |
| `client/src/eval/contested-band.ts` | `inContestedBand` predicate + `assertBlindScreen` fidelity check (spec §4.2). |
| `client/src/eval/mcnemar-power.ts` | `mcnemarSampleSize` — Connor (1987) paired sample size (spec §6.3). |
| `client/src/eval/capability-stats.ts` | `pairedRateDiffCI` (BCa bootstrap, injected RNG) + `nonInferiorityVerdict` (δ absolute + relative guard) + `pairedCostVerdict` (Wilcoxon signed-rank). The gate statistics (spec §2, §6.2). |
| `client/test/eval/*.test.ts` | One test file per module above. |

Each task creates one module + its test, is independently reviewable, and ends green.

---

## Task 1: Capability slate artifact (schema + parse + hash)

Implements spec §4.4. Mirrors `_swe-rebench-v2-held-out-slate.ts` but with the richer per-instance and disjointness fields.

**Files:**
- Create: `client/src/eval/capability-slate.ts`
- Test: `client/test/eval/capability-slate.test.ts`

**Interfaces:**
- Consumes: `canonicalJson` from `../harnesses/engine/canonical-json.js`; `createHash` from `node:crypto`.
- Produces: `CapabilitySlateArtifact` (interface), `parseCapabilitySlate(raw: unknown): CapabilitySlateArtifact`, `hashCapabilitySlate(a: CapabilitySlateArtifact): \`sha256:${string}\``.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/eval/capability-slate.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseCapabilitySlate,
  hashCapabilitySlate,
  CAPABILITY_SLATE_SCHEMA_VERSION,
  type CapabilitySlateArtifact,
} from '../../src/eval/capability-slate.js';

const valid: CapabilitySlateArtifact = {
  schemaVersion: CAPABILITY_SLATE_SCHEMA_VERSION,
  solverType: 'swe-rebench-v2.v1',
  version: 'cap-v0',
  generatedAt: '2026-07-06T00:00:00.000Z',
  evalSemanticsVersion: '4',
  instances: [
    {
      instance_id: 'astropy__astropy-19438',
      repo: 'astropy',
      rowHash: 'sha256:aa',
      imageDigest: 'sha256:bb',
      stockPassRate: 0.33,
      screening: { agentSha: 'deadbeef', emptyLoadout: true, noCorpusTools: true, hostSkillDirHash: 'sha256:empty' },
    },
  ],
  construction: 'contested-band[0.15,0.85], stock=haiku, R=3, repo-stratified',
  corpusSnapshotCid: 'ipfs://root',
  corpusDerivedIndexCid: 'ipfs://index',
  loadoutFrozenBeforeSlate: true,
  disjointness: {
    instance: { verdict: 'pass', flaggedPairs: [] },
    repo: { verdict: 'pass', flaggedPairs: [] },
    lexical: { verdict: 'pass', flaggedPairs: [], attestation: 'self-attested' },
    semantic: { verdict: 'n/a-v0', model: null, threshold: null, flaggedPairs: [] },
  },
};

describe('capability slate artifact', () => {
  it('round-trips a valid artifact through parse', () => {
    expect(parseCapabilitySlate(valid)).toEqual(valid);
  });

  it('hash is stable under instance reordering (canonical, sorted)', () => {
    const reordered: CapabilitySlateArtifact = {
      ...valid,
      instances: [
        { ...valid.instances[0]!, instance_id: 'zzz__z-1', repo: 'zzz' },
        valid.instances[0]!,
      ],
    };
    // same set of instances, different order → same hash
    const a = hashCapabilitySlate(valid);
    const b = hashCapabilitySlate({ ...valid, instances: [...valid.instances] });
    expect(a).toBe(b);
    expect(hashCapabilitySlate(reordered)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects a wrong schemaVersion', () => {
    expect(() => parseCapabilitySlate({ ...valid, schemaVersion: 'nope' })).toThrow(/schemaVersion/);
  });

  it('rejects an instance missing rowHash', () => {
    const bad = { ...valid, instances: [{ ...valid.instances[0]!, rowHash: undefined }] };
    expect(() => parseCapabilitySlate(bad)).toThrow(/rowHash/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/eval/capability-slate.test.ts`
Expected: FAIL — `capability-slate.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/eval/capability-slate.ts
import { createHash } from 'node:crypto';
import { canonicalJson } from '../harnesses/engine/canonical-json.js';

export const CAPABILITY_SLATE_SCHEMA_VERSION = 'capability-slate.v1' as const;

export type AxisVerdict = 'pass' | 'fail' | 'n/a-v0';

export interface AxisResult {
  verdict: AxisVerdict;
  /** [slateInstanceId, corpusRecordId] pairs that overlapped on this axis. */
  flaggedPairs: Array<[string, string]>;
}
export interface LexicalAxisResult extends AxisResult { attestation: 'self-attested'; }
export interface SemanticAxisResult extends AxisResult { model: string | null; threshold: number | null; }

export interface CapabilitySlateInstance {
  instance_id: string;
  repo: string;
  rowHash: `sha256:${string}` | string;
  imageDigest: `sha256:${string}` | string;
  stockPassRate: number;
  screening: { agentSha: string; emptyLoadout: boolean; noCorpusTools: boolean; hostSkillDirHash: string };
}

export interface CapabilitySlateArtifact {
  schemaVersion: typeof CAPABILITY_SLATE_SCHEMA_VERSION;
  solverType: string;
  version: string;
  generatedAt: string;
  evalSemanticsVersion: string;
  instances: CapabilitySlateInstance[];
  construction: string;
  corpusSnapshotCid: string;
  corpusDerivedIndexCid: string;
  loadoutFrozenBeforeSlate: boolean;
  disjointness: {
    instance: AxisResult;
    repo: AxisResult;
    lexical: LexicalAxisResult;
    semantic: SemanticAxisResult;
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function reqString(o: Record<string, unknown>, k: string): string {
  if (typeof o[k] !== 'string' || (o[k] as string).length === 0) throw new Error(`capability slate: ${k} must be a non-empty string`);
  return o[k] as string;
}

export function parseCapabilitySlate(raw: unknown): CapabilitySlateArtifact {
  if (!isObject(raw)) throw new Error('capability slate must be an object');
  if (raw['schemaVersion'] !== CAPABILITY_SLATE_SCHEMA_VERSION) {
    throw new Error(`capability slate schemaVersion must be ${CAPABILITY_SLATE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw['instances'])) throw new Error('capability slate instances must be an array');
  const instances = (raw['instances'] as unknown[]).map((it): CapabilitySlateInstance => {
    if (!isObject(it)) throw new Error('capability slate instance must be an object');
    const s = it['screening'];
    if (!isObject(s)) throw new Error('capability slate instance missing screening object');
    if (typeof it['stockPassRate'] !== 'number') throw new Error('capability slate instance missing stockPassRate');
    return {
      instance_id: reqString(it, 'instance_id'),
      repo: reqString(it, 'repo'),
      rowHash: reqString(it, 'rowHash'),
      imageDigest: reqString(it, 'imageDigest'),
      stockPassRate: it['stockPassRate'] as number,
      screening: {
        agentSha: reqString(s, 'agentSha'),
        emptyLoadout: s['emptyLoadout'] === true,
        noCorpusTools: s['noCorpusTools'] === true,
        hostSkillDirHash: reqString(s, 'hostSkillDirHash'),
      },
    };
  });
  return {
    schemaVersion: CAPABILITY_SLATE_SCHEMA_VERSION,
    solverType: reqString(raw, 'solverType'),
    version: reqString(raw, 'version'),
    generatedAt: reqString(raw, 'generatedAt'),
    evalSemanticsVersion: reqString(raw, 'evalSemanticsVersion'),
    instances,
    construction: reqString(raw, 'construction'),
    corpusSnapshotCid: reqString(raw, 'corpusSnapshotCid'),
    corpusDerivedIndexCid: reqString(raw, 'corpusDerivedIndexCid'),
    loadoutFrozenBeforeSlate: raw['loadoutFrozenBeforeSlate'] === true,
    disjointness: raw['disjointness'] as CapabilitySlateArtifact['disjointness'],
  };
}

function normalize(a: CapabilitySlateArtifact): CapabilitySlateArtifact {
  return { ...a, instances: [...a.instances].sort((x, y) => x.instance_id.localeCompare(y.instance_id)) };
}

export function hashCapabilitySlate(a: CapabilitySlateArtifact): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(normalize(a))).digest('hex')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/eval/capability-slate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/eval/capability-slate.ts client/test/eval/capability-slate.test.ts
git commit -m "feat(capability-eval): capability-slate.v1 artifact schema + hash (spec §4.4)"
```

---

## Task 2: Corpus derived index (repos + instance_ids + token sketches + Merkle root)

Implements the externally-recomputable index of spec §4.3. A corpus record is `{ id, repos, instanceIdsReferenced, text }`. The index publishes repos + instance_ids + a per-record MinHash sketch of the record's token set (so a third party recomputes lexical overlap without the raw text), and a Merkle root over the canonical index = `corpusSnapshotCid`.

**Files:**
- Create: `client/src/eval/corpus-index.ts`
- Test: `client/test/eval/corpus-index.test.ts`

**Interfaces:**
- Consumes: `createHash` from `node:crypto`.
- Produces: `CorpusRecord` (interface), `tokenize(text: string): string[]`, `minhashSketch(tokens: string[], numHashes?: number): number[]`, `buildCorpusIndex(records: CorpusRecord[]): CorpusDerivedIndex`, `corpusSnapshotCid(index: CorpusDerivedIndex): \`sha256:${string}\``.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/eval/corpus-index.test.ts
import { describe, it, expect } from 'vitest';
import {
  tokenize, minhashSketch, buildCorpusIndex, corpusSnapshotCid, type CorpusRecord,
} from '../../src/eval/corpus-index.js';

const records: CorpusRecord[] = [
  { id: 'skill:a', repos: ['django'], instanceIdsReferenced: [], text: 'use select_related to fix N+1 queries' },
  { id: 'trace:b', repos: ['astropy'], instanceIdsReferenced: ['astropy__astropy-19438'], text: 'wcs bug fix in modeling core' },
];

describe('corpus derived index', () => {
  it('tokenizes to lowercased alphanumeric words', () => {
    expect(tokenize('Fix  N+1, select_related!')).toEqual(['fix', 'n', '1', 'select_related']);
  });

  it('minhash sketch is deterministic and fixed length', () => {
    const s1 = minhashSketch(tokenize(records[0]!.text));
    const s2 = minhashSketch(tokenize(records[0]!.text));
    expect(s1).toEqual(s2);
    expect(s1).toHaveLength(64);
  });

  it('index sorts repos + instance ids and carries a sketch per record', () => {
    const idx = buildCorpusIndex(records);
    expect(idx.repos).toEqual(['astropy', 'django']);
    expect(idx.instanceIds).toEqual(['astropy__astropy-19438']);
    expect(idx.records.map((r) => r.id)).toEqual(['skill:a', 'trace:b']);
    expect(idx.records[0]!.sketch).toHaveLength(64);
  });

  it('snapshot cid is stable under record reordering', () => {
    const a = corpusSnapshotCid(buildCorpusIndex(records));
    const b = corpusSnapshotCid(buildCorpusIndex([records[1]!, records[0]!]));
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/eval/corpus-index.test.ts`
Expected: FAIL — `corpus-index.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/eval/corpus-index.ts
import { createHash } from 'node:crypto';

export interface CorpusRecord {
  id: string;
  repos: string[];
  instanceIdsReferenced: string[];
  text: string;
}

export interface CorpusIndexRecord { id: string; repos: string[]; instanceIds: string[]; sketch: number[]; }
export interface CorpusDerivedIndex {
  repos: string[];
  instanceIds: string[];
  records: CorpusIndexRecord[];
}

export function tokenize(text: string): string[] {
  const m = text.toLowerCase().match(/[a-z0-9_]+/g);
  return m ?? [];
}

/** 32-bit FNV-1a — stable, dependency-free, good enough for MinHash bucketing. */
function fnv1a(s: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function minhashSketch(tokens: string[], numHashes = 64): number[] {
  const uniq = [...new Set(tokens)];
  const out: number[] = [];
  for (let k = 0; k < numHashes; k++) {
    let min = 0xffffffff;
    for (const t of uniq) {
      const h = fnv1a(t, k * 0x9e3779b1);
      if (h < min) min = h;
    }
    out.push(uniq.length === 0 ? 0 : min);
  }
  return out;
}

export function buildCorpusIndex(records: CorpusRecord[]): CorpusDerivedIndex {
  const repos = new Set<string>();
  const instanceIds = new Set<string>();
  const indexed: CorpusIndexRecord[] = [];
  for (const r of records) {
    r.repos.forEach((x) => repos.add(x));
    r.instanceIdsReferenced.forEach((x) => instanceIds.add(x));
    indexed.push({
      id: r.id,
      repos: [...r.repos].sort(),
      instanceIds: [...r.instanceIdsReferenced].sort(),
      sketch: minhashSketch(tokenize(r.text)),
    });
  }
  indexed.sort((a, b) => a.id.localeCompare(b.id));
  return { repos: [...repos].sort(), instanceIds: [...instanceIds].sort(), records: indexed };
}

export function corpusSnapshotCid(index: CorpusDerivedIndex): `sha256:${string}` {
  // Canonical: index is already fully sorted, so JSON.stringify is stable.
  return `sha256:${createHash('sha256').update(JSON.stringify(index)).digest('hex')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/eval/corpus-index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/eval/corpus-index.ts client/test/eval/corpus-index.test.ts
git commit -m "feat(capability-eval): public corpus derived index + minhash sketch (spec §4.3)"
```

---

## Task 3: Three-axis disjointness proof (fail-loud)

Implements spec §4.3. Extends the `assertNoOverlap` pattern from `train-sequence.ts` to corpus scope. Takes the slate (instance_ids, repos, gold-patch token sets) + the corpus derived index, checks the three content axes, and throws `CorpusContaminationError` with the flagged pairs on any hit.

**Files:**
- Create: `client/src/eval/disjointness.ts`
- Test: `client/test/eval/disjointness.test.ts`

**Interfaces:**
- Consumes: `CorpusDerivedIndex`, `minhashSketch`, `tokenize` from `./corpus-index.js`.
- Produces: `SlateTaskForDisjointness` (interface: `{ instance_id, repo, goldPatchTokens: string[] }`), `checkCorpusDisjoint(slate, index, opts?): DisjointnessResult`, `assertCorpusDisjoint(...)` (throws `CorpusContaminationError` on any fail), `CorpusContaminationError`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/eval/disjointness.test.ts
import { describe, it, expect } from 'vitest';
import { buildCorpusIndex, type CorpusRecord } from '../../src/eval/corpus-index.js';
import {
  checkCorpusDisjoint, assertCorpusDisjoint, CorpusContaminationError,
  type SlateTaskForDisjointness,
} from '../../src/eval/disjointness.js';

const corpus: CorpusRecord[] = [
  { id: 'skill:generic', repos: ['django'], instanceIdsReferenced: [], text: 'general debugging with pdb and breakpoints' },
];

const cleanTask: SlateTaskForDisjointness = {
  instance_id: 'astropy__astropy-19438', repo: 'astropy', goldPatchTokens: ['wcs', 'modeling', 'core'],
};

describe('corpus disjointness', () => {
  it('passes when the slate shares no instance, repo, or tokens with the corpus', () => {
    const r = checkCorpusDisjoint([cleanTask], buildCorpusIndex(corpus));
    expect(r.instance.verdict).toBe('pass');
    expect(r.repo.verdict).toBe('pass');
    expect(r.lexical.verdict).toBe('pass');
  });

  it('flags a repo-axis overlap', () => {
    const task = { ...cleanTask, repo: 'django' };
    const r = checkCorpusDisjoint([task], buildCorpusIndex(corpus));
    expect(r.repo.verdict).toBe('fail');
    expect(r.repo.flaggedPairs).toContainEqual([task.instance_id, 'skill:generic']);
  });

  it('flags an instance-axis overlap', () => {
    const withRef: CorpusRecord[] = [{ ...corpus[0]!, instanceIdsReferenced: ['astropy__astropy-19438'] }];
    const r = checkCorpusDisjoint([cleanTask], buildCorpusIndex(withRef));
    expect(r.instance.verdict).toBe('fail');
  });

  it('flags a lexical overlap when gold tokens are dense in a corpus record', () => {
    const leaky: CorpusRecord[] = [{ id: 'skill:leak', repos: ['x'], instanceIdsReferenced: [], text: 'wcs modeling core transform fix' }];
    const r = checkCorpusDisjoint([cleanTask], buildCorpusIndex(leaky), { lexicalJaccardThreshold: 0.2 });
    expect(r.lexical.verdict).toBe('fail');
  });

  it('assertCorpusDisjoint throws on any failing axis', () => {
    const task = { ...cleanTask, repo: 'django' };
    expect(() => assertCorpusDisjoint([task], buildCorpusIndex(corpus))).toThrow(CorpusContaminationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/eval/disjointness.test.ts`
Expected: FAIL — `disjointness.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/eval/disjointness.ts
import { minhashSketch, type CorpusDerivedIndex } from './corpus-index.js';

export interface SlateTaskForDisjointness {
  instance_id: string;
  repo: string;
  /** Distinctive tokens from the gold patch (changed paths/symbols/PR id). */
  goldPatchTokens: string[];
}

export interface AxisCheck { verdict: 'pass' | 'fail'; flaggedPairs: Array<[string, string]>; }
export interface DisjointnessResult { instance: AxisCheck; repo: AxisCheck; lexical: AxisCheck; }

export class CorpusContaminationError extends Error {
  constructor(public readonly result: DisjointnessResult) {
    const fails = (['instance', 'repo', 'lexical'] as const).filter((a) => result[a].verdict === 'fail');
    super(`corpus contamination on axes [${fails.join(', ')}]: ${JSON.stringify(
      fails.flatMap((a) => result[a].flaggedPairs),
    )}`);
    this.name = 'CorpusContaminationError';
  }
}

/** MinHash Jaccard estimate between two equal-length sketches. */
function sketchJaccard(a: number[], b: number[]): number {
  if (a.length === 0) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

export function checkCorpusDisjoint(
  slate: SlateTaskForDisjointness[],
  index: CorpusDerivedIndex,
  opts: { lexicalJaccardThreshold?: number } = {},
): DisjointnessResult {
  const threshold = opts.lexicalJaccardThreshold ?? 0.15;
  const corpusRepos = new Set(index.repos);
  const corpusInstances = new Set(index.instanceIds);

  const instance: AxisCheck = { verdict: 'pass', flaggedPairs: [] };
  const repo: AxisCheck = { verdict: 'pass', flaggedPairs: [] };
  const lexical: AxisCheck = { verdict: 'pass', flaggedPairs: [] };

  for (const task of slate) {
    if (corpusInstances.has(task.instance_id)) {
      instance.verdict = 'fail';
      for (const rec of index.records) if (rec.instanceIds.includes(task.instance_id)) instance.flaggedPairs.push([task.instance_id, rec.id]);
    }
    if (corpusRepos.has(task.repo)) {
      repo.verdict = 'fail';
      for (const rec of index.records) if (rec.repos.includes(task.repo)) repo.flaggedPairs.push([task.instance_id, rec.id]);
    }
    const goldSketch = minhashSketch(task.goldPatchTokens);
    for (const rec of index.records) {
      if (sketchJaccard(goldSketch, rec.sketch) >= threshold) {
        lexical.verdict = 'fail';
        lexical.flaggedPairs.push([task.instance_id, rec.id]);
      }
    }
  }
  return { instance, repo, lexical };
}

export function assertCorpusDisjoint(
  slate: SlateTaskForDisjointness[],
  index: CorpusDerivedIndex,
  opts: { lexicalJaccardThreshold?: number } = {},
): DisjointnessResult {
  const result = checkCorpusDisjoint(slate, index, opts);
  if (result.instance.verdict === 'fail' || result.repo.verdict === 'fail' || result.lexical.verdict === 'fail') {
    throw new CorpusContaminationError(result);
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/eval/disjointness.test.ts`
Expected: PASS (5 tests). If the lexical test is flaky at the chosen threshold, tighten the test's `text` so the token overlap is unambiguous — do not loosen the production default.

- [ ] **Step 5: Commit**

```bash
git add client/src/eval/disjointness.ts client/test/eval/disjointness.test.ts
git commit -m "feat(capability-eval): three-axis corpus disjointness proof, fail-loud (spec §4.3)"
```

---

## Task 4: Contested-band predicate + blind-screen fidelity

Implements spec §4.2. Two small pure checks: is a screened instance in the band, and did its screening run satisfy the blind-screen fidelity assertions.

**Files:**
- Create: `client/src/eval/contested-band.ts`
- Test: `client/test/eval/contested-band.test.ts`

**Interfaces:**
- Produces: `Band` (`{ lo: number; hi: number }`), `inContestedBand(passRate: number, band: Band): boolean`, `BlindScreenFidelity` (interface), `assertBlindScreen(f: BlindScreenFidelity): void` (throws `BlindScreenViolation`), `BlindScreenViolation`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/eval/contested-band.test.ts
import { describe, it, expect } from 'vitest';
import {
  inContestedBand, assertBlindScreen, BlindScreenViolation, type BlindScreenFidelity,
} from '../../src/eval/contested-band.js';

const band = { lo: 0.15, hi: 0.85 };
const cleanFidelity: BlindScreenFidelity = {
  agentSha: 'abc', emptyLoadout: true, noCorpusTools: true, hostSkillDirHash: 'sha256:e3b0c442...',
  emptyHostSkillDirHash: 'sha256:e3b0c442...',
};

describe('contested band', () => {
  it('includes rates inside [lo, hi] inclusive', () => {
    expect(inContestedBand(0.15, band)).toBe(true);
    expect(inContestedBand(0.5, band)).toBe(true);
    expect(inContestedBand(0.85, band)).toBe(true);
  });
  it('excludes saturated / hopeless rates', () => {
    expect(inContestedBand(0.0, band)).toBe(false);
    expect(inContestedBand(1.0, band)).toBe(false);
    expect(inContestedBand(0.14, band)).toBe(false);
  });
  it('passes a blind screen with empty loadout + matching empty host dir hash', () => {
    expect(() => assertBlindScreen(cleanFidelity)).not.toThrow();
  });
  it('throws when the loadout was not empty', () => {
    expect(() => assertBlindScreen({ ...cleanFidelity, emptyLoadout: false })).toThrow(BlindScreenViolation);
  });
  it('throws when the host skill dir hash does not match the empty-dir hash', () => {
    expect(() => assertBlindScreen({ ...cleanFidelity, hostSkillDirHash: 'sha256:nonempty' })).toThrow(BlindScreenViolation);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/eval/contested-band.test.ts`
Expected: FAIL — `contested-band.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/eval/contested-band.ts
export interface Band { lo: number; hi: number; }

export function inContestedBand(passRate: number, band: Band): boolean {
  return passRate >= band.lo && passRate <= band.hi;
}

export interface BlindScreenFidelity {
  agentSha: string;
  emptyLoadout: boolean;
  noCorpusTools: boolean;
  /** Hash of the host skill directory at screen time. */
  hostSkillDirHash: string;
  /** The reference hash of an empty skill directory; hostSkillDirHash MUST equal this. */
  emptyHostSkillDirHash: string;
}

export class BlindScreenViolation extends Error {
  constructor(reason: string) {
    super(`blind-screen fidelity violated: ${reason}`);
    this.name = 'BlindScreenViolation';
  }
}

export function assertBlindScreen(f: BlindScreenFidelity): void {
  if (!f.emptyLoadout) throw new BlindScreenViolation('screening run did not have an empty skill loadout');
  if (!f.noCorpusTools) throw new BlindScreenViolation('screening run had a live corpus tool surface');
  if (f.hostSkillDirHash !== f.emptyHostSkillDirHash) {
    throw new BlindScreenViolation(`host skill dir was not empty (${f.hostSkillDirHash} != ${f.emptyHostSkillDirHash})`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/eval/contested-band.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/eval/contested-band.ts client/test/eval/contested-band.test.ts
git commit -m "feat(capability-eval): contested-band predicate + blind-screen fidelity (spec §4.2)"
```

---

## Task 5: Connor (1987) McNemar sample size

Implements spec §6.3. A pure numeric function reproducing the power table in the spec (e.g. `pb=0.25, pc=0.10 → N≈343 @80%`).

**Files:**
- Create: `client/src/eval/mcnemar-power.ts`
- Test: `client/test/eval/mcnemar-power.test.ts`

**Interfaces:**
- Produces: `zFor(p: number): number` (inverse-normal quantile), `mcnemarSampleSize(pb, pc, opts?): { pairs: number; discordant: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/eval/mcnemar-power.test.ts
import { describe, it, expect } from 'vitest';
import { mcnemarSampleSize } from '../../src/eval/mcnemar-power.js';

describe('Connor McNemar sample size', () => {
  it('reproduces the spec §6.3 table at 80% power (±3%)', () => {
    const n1 = mcnemarSampleSize(0.25, 0.10).pairs; // spec: 343
    const n2 = mcnemarSampleSize(0.15, 0.05).pairs; // spec: 773
    expect(n1).toBeGreaterThan(333); expect(n1).toBeLessThan(353);
    expect(n2).toBeGreaterThan(750); expect(n2).toBeLessThan(796);
  });
  it('needs more pairs at 90% power than 80%', () => {
    const a = mcnemarSampleSize(0.20, 0.08, { power: 0.8 }).pairs;
    const b = mcnemarSampleSize(0.20, 0.08, { power: 0.9 }).pairs;
    expect(b).toBeGreaterThan(a);
  });
  it('needs more pairs as the effect shrinks', () => {
    const big = mcnemarSampleSize(0.25, 0.10).pairs;
    const small = mcnemarSampleSize(0.10, 0.04).pairs;
    expect(small).toBeGreaterThan(big);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/eval/mcnemar-power.test.ts`
Expected: FAIL — `mcnemar-power.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/eval/mcnemar-power.ts
/** Acklam's rational approximation to the inverse normal CDF (|err| < 1.15e-9). */
export function zFor(p: number): number {
  if (p <= 0 || p >= 1) throw new Error('zFor expects 0 < p < 1');
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1); }
  q = p - 0.5; r = q * q;
  return (((((a[0]!*r+a[1]!)*r+a[2]!)*r+a[3]!)*r+a[4]!)*r+a[5]!)*q / (((((b[0]!*r+b[1]!)*r+b[2]!)*r+b[3]!)*r+b[4]!)*r+1);
}

export interface SampleSizeOpts { alpha?: number; power?: number; }

/**
 * Connor (1987) total task-PAIRS N for McNemar's test.
 * pb = P(B passes, A fails); pc = P(A passes, B fails).
 */
export function mcnemarSampleSize(pb: number, pc: number, opts: SampleSizeOpts = {}): { pairs: number; discordant: number } {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  const diff = pb - pc;
  if (diff <= 0) throw new Error('mcnemarSampleSize expects pb > pc (a positive effect)');
  const pd = pb + pc;
  const za = zFor(1 - alpha / 2);
  const zb = zFor(power);
  const m = Math.pow(za * Math.sqrt(pd) + zb * Math.sqrt(pd - diff * diff), 2) / (diff * diff);
  const pairs = m / pd;
  return { pairs: Math.ceil(pairs), discordant: Math.ceil(m) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/eval/mcnemar-power.test.ts`
Expected: PASS (3 tests). If the table values are off, verify `zFor(0.975) ≈ 1.95996` and `zFor(0.8) ≈ 0.84162` in a scratch REPL first.

- [ ] **Step 5: Commit**

```bash
git add client/src/eval/mcnemar-power.ts client/test/eval/mcnemar-power.test.ts
git commit -m "feat(capability-eval): Connor McNemar sample-size calc (spec §6.3)"
```

---

## Task 6: Quality gate statistic — paired pass-rate bootstrap CI + non-inferiority (δ absolute + relative guard)

Implements spec §2.1(1), §2.2, §6.2. The gate-primary quality test: per-task Δ_i = p̂_B,i − p̂_A,i, a one-sided lower confidence bound via bias-corrected bootstrap over tasks (injected RNG for determinism), and the non-inferiority decision combining the absolute δ and the relative-regression guard.

**Files:**
- Create: `client/src/eval/capability-stats.ts`
- Test: `client/test/eval/capability-stats.test.ts`

**Interfaces:**
- Produces: `TaskRates` (`{ pA: number; pB: number }`), `pairedRateDiffLowerBound(rates, opts): number`, `nonInferiorityVerdict(rates, opts): { pass: boolean; lowerBound: number; deltaAbs: number; relativeRegression: number; reasons: string[] }`. `opts` includes `rng: () => number`, `alpha`, `resamples`, `deltaAbs`, `relativeCap`, `stockBaseRate`.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/eval/capability-stats.test.ts
import { describe, it, expect } from 'vitest';
import { nonInferiorityVerdict, pairedRateDiffLowerBound, type TaskRates } from '../../src/eval/capability-stats.js';

// Deterministic LCG so bootstrap resampling is reproducible in tests.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

describe('quality gate statistic', () => {
  it('a strong uniform improvement clears non-inferiority (lower bound > -δ)', () => {
    const rates: TaskRates[] = Array.from({ length: 60 }, () => ({ pA: 0.3, pB: 0.6 }));
    const v = nonInferiorityVerdict(rates, { rng: lcg(1), stockBaseRate: 0.3 });
    expect(v.pass).toBe(true);
    expect(v.lowerBound).toBeGreaterThan(-0.05);
  });

  it('a clear regression fails non-inferiority', () => {
    const rates: TaskRates[] = Array.from({ length: 60 }, () => ({ pA: 0.6, pB: 0.3 }));
    const v = nonInferiorityVerdict(rates, { rng: lcg(2), stockBaseRate: 0.6 });
    expect(v.pass).toBe(false);
  });

  it('the relative guard fails a small-absolute-but-large-relative regression at a low base rate', () => {
    // base rate 0.15, arm B drops ~4pp absolute = ~27% relative → within δ=5pp abs but over 15% rel.
    const rates: TaskRates[] = Array.from({ length: 200 }, () => ({ pA: 0.15, pB: 0.11 }));
    const v = nonInferiorityVerdict(rates, { rng: lcg(3), stockBaseRate: 0.15 });
    expect(v.relativeRegression).toBeGreaterThan(0.15);
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => /relative/.test(r))).toBe(true);
  });

  it('lower bound is deterministic under a fixed rng', () => {
    const rates: TaskRates[] = Array.from({ length: 40 }, (_, i) => ({ pA: 0.4, pB: i % 2 ? 0.5 : 0.45 }));
    const a = pairedRateDiffLowerBound(rates, { rng: lcg(7), alpha: 0.05, resamples: 2000 });
    const b = pairedRateDiffLowerBound(rates, { rng: lcg(7), alpha: 0.05, resamples: 2000 });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/eval/capability-stats.test.ts`
Expected: FAIL — `capability-stats.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// client/src/eval/capability-stats.ts
export interface TaskRates { pA: number; pB: number; }

export interface RateCIOpts { rng: () => number; alpha?: number; resamples?: number; }

/** One-sided lower confidence bound for mean(Δ_i), Δ_i = pB - pA, via a
 *  bias-corrected bootstrap over tasks (BCa without acceleration; acceleration
 *  adds a jackknife pass — see §6.2, deferred as a refinement). */
export function pairedRateDiffLowerBound(rates: TaskRates[], opts: RateCIOpts): number {
  const alpha = opts.alpha ?? 0.05;
  const B = opts.resamples ?? 10_000;
  const n = rates.length;
  if (n === 0) throw new Error('pairedRateDiffLowerBound: empty sample');
  const deltas = rates.map((r) => r.pB - r.pA);
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const observed = mean(deltas);

  const means: number[] = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.floor(opts.rng() * n)]!;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);

  // Bias-correction z0 = Φ⁻¹(fraction of resamples < observed).
  const below = means.filter((m) => m < observed).length;
  const z0 = invNorm(Math.min(Math.max(below / B, 1e-6), 1 - 1e-6));
  const zAlpha = invNorm(alpha); // one-sided lower
  const adj = normCdf(2 * z0 + zAlpha);
  const idx = Math.min(B - 1, Math.max(0, Math.floor(adj * B)));
  return means[idx]!;
}

export interface NIOpts extends RateCIOpts { deltaAbs?: number; relativeCap?: number; stockBaseRate: number; }

export function nonInferiorityVerdict(rates: TaskRates[], opts: NIOpts): {
  pass: boolean; lowerBound: number; deltaAbs: number; relativeRegression: number; reasons: string[];
} {
  const deltaAbs = opts.deltaAbs ?? 0.05;
  const relativeCap = opts.relativeCap ?? 0.15;
  const lowerBound = pairedRateDiffLowerBound(rates, opts);
  const meanA = rates.reduce((s, r) => s + r.pA, 0) / rates.length;
  const meanB = rates.reduce((s, r) => s + r.pB, 0) / rates.length;
  const absRegression = Math.max(0, meanA - meanB);
  const relativeRegression = opts.stockBaseRate > 0 ? absRegression / opts.stockBaseRate : 0;

  const reasons: string[] = [];
  const absOk = lowerBound > -deltaAbs;
  if (!absOk) reasons.push(`absolute NI failed: lower bound ${lowerBound.toFixed(3)} ≤ -δ (${-deltaAbs})`);
  const relOk = relativeRegression <= relativeCap;
  if (!relOk) reasons.push(`relative guard failed: regression ${(relativeRegression * 100).toFixed(1)}% > cap ${(relativeCap * 100).toFixed(0)}%`);
  return { pass: absOk && relOk, lowerBound, deltaAbs, relativeRegression, reasons };
}

// --- normal helpers (kept local; mcnemar-power exports its own for its use) ---
function normCdf(x: number): number { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function invNorm(p: number): number {
  // Beasley-Springer/Moro; adequate for CI index selection.
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1); }
  q = p - 0.5; r = q * q;
  return (((((a[0]!*r+a[1]!)*r+a[2]!)*r+a[3]!)*r+a[4]!)*r+a[5]!)*q / (((((b[0]!*r+b[1]!)*r+b[2]!)*r+b[3]!)*r+b[4]!)*r+1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/eval/capability-stats.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/eval/capability-stats.ts client/test/eval/capability-stats.test.ts
git commit -m "feat(capability-eval): paired pass-rate NI test + relative guard (spec §2.1, §6.2)"
```

---

## Task 7: Cost gate statistic — paired Wilcoxon signed-rank (one-sided)

Implements spec §2.1(2), §6.2 cost leg. One-sided Wilcoxon signed-rank on the per-task both-solve cost differences, plus the below-floor → INCONCLUSIVE rule.

**Files:**
- Modify: `client/src/eval/capability-stats.ts` (append)
- Test: `client/test/eval/capability-stats-cost.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `pairedCostVerdict(costDiffs: number[], opts?): { verdict: 'lower' | 'not-lower' | 'inconclusive'; pValue: number | null; n: number }` where a `costDiff` is `costB − costA` on a both-solve task (negative = corpus cheaper); `opts.minN` is the pre-registered both-solve floor.

- [ ] **Step 1: Write the failing test**

```ts
// client/test/eval/capability-stats-cost.test.ts
import { describe, it, expect } from 'vitest';
import { pairedCostVerdict } from '../../src/eval/capability-stats.js';

describe('cost gate statistic', () => {
  it('declares "lower" when corpus is consistently cheaper', () => {
    const diffs = Array.from({ length: 20 }, (_, i) => -(i + 1)); // all negative
    const v = pairedCostVerdict(diffs, { minN: 10 });
    expect(v.verdict).toBe('lower');
    expect(v.pValue!).toBeLessThan(0.05);
  });
  it('declares "not-lower" when corpus is consistently costlier', () => {
    const diffs = Array.from({ length: 20 }, (_, i) => i + 1); // all positive
    expect(pairedCostVerdict(diffs, { minN: 10 }).verdict).toBe('not-lower');
  });
  it('is INCONCLUSIVE below the pre-registered floor', () => {
    expect(pairedCostVerdict([-3, -1, -2], { minN: 10 }).verdict).toBe('inconclusive');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn vitest run test/eval/capability-stats-cost.test.ts`
Expected: FAIL — `pairedCostVerdict` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `capability-stats.ts`)

```ts
// --- cost leg (append to capability-stats.ts) ---

/** One-sided Wilcoxon signed-rank test that the median paired difference < 0,
 *  using a normal approximation with tie + continuity correction. */
export function pairedCostVerdict(
  costDiffs: number[],
  opts: { minN?: number; alpha?: number } = {},
): { verdict: 'lower' | 'not-lower' | 'inconclusive'; pValue: number | null; n: number } {
  const minN = opts.minN ?? 10;
  const alpha = opts.alpha ?? 0.05;
  const nonzero = costDiffs.filter((d) => d !== 0);
  if (nonzero.length < minN) return { verdict: 'inconclusive', pValue: null, n: nonzero.length };

  const ranks = rankAbs(nonzero.map(Math.abs));
  let wMinus = 0; // sum of ranks for NEGATIVE diffs (corpus cheaper)
  let wPlus = 0;
  nonzero.forEach((d, i) => { if (d < 0) wMinus += ranks[i]!; else wPlus += ranks[i]!; });
  const n = nonzero.length;
  const meanW = (n * (n + 1)) / 4;
  const sdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  // Test statistic: is W+ (evidence AGAINST cheaper) improbably small?
  const z = (wPlus - meanW + 0.5) / sdW;
  const pValue = normCdfLocal(z); // one-sided: P(W+ ≤ observed)
  const verdict = pValue < alpha ? 'lower' : 'not-lower';
  return { verdict, pValue, n };
}

function rankAbs(absVals: number[]): number[] {
  const idx = absVals.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(absVals.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++;
    const avg = (i + j + 2) / 2; // average rank (1-based) for ties
    for (let k = i; k <= j; k++) ranks[idx[k]!.i] = avg;
    i = j + 1;
  }
  return ranks;
}

function normCdfLocal(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn vitest run test/eval/capability-stats-cost.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full eval suite + typecheck, then commit**

```bash
cd client && yarn vitest run test/eval && yarn typecheck
git add client/src/eval/capability-stats.ts client/test/eval/capability-stats-cost.test.ts
git commit -m "feat(capability-eval): paired Wilcoxon cost test + below-floor INCONCLUSIVE (spec §2.1, §6.2)"
```

---

## Gate to Plan 2 — the Inspect / jinn-agent bridge spike (does NOT merge)

The remaining rig — running the two arms, installing the seed loadout, capturing **provider-actual** tokens, and emitting the report — hinges on one unvalidated integration. Per spec §13 and DR-2026-07-06, a **spike** (work-shape `spike`; output is a finding, code does not merge) must resolve it before Plan 2 is written:

**Spike question:** Can Inspect AI's `sandbox_agent_bridge()` run the **jinn-agent fork** as a solver on **one** SWE-rebench-V2 instance, in both arms (empty loadout vs seeds pre-installed via `/jinn skills install`), and can we capture **provider-actual** input/output tokens for the gate's cost leg?

**Acceptance (all must hold to unblock Plan 2):**
1. jinn-agent runs end-to-end under `sandbox_agent_bridge` on one instance and emits a patch the existing swe-rebench-v2 grader scores.
2. `/jinn skills install` produces a distinct, inspectable arm-B loadout, and the injected skill text is confirmed present in the agent's context.
3. **Provider-actual** input/output tokens are captured for both arms — either (a) by routing jinn-agent's model client through Inspect's proxy *with a documented confirmation that proxying does not alter native token usage / turn structure*, or (b) from jinn-agent's own emitted usage, cross-checked against provider billing on that one instance (spec §5.2, §7.1). Record which path and the cross-check delta.
4. A `corpusSnapshotCid` fidelity assertion (spec §4.3) can be evaluated at solve time (the loadout content-hashes as expected).

**Spike deliverable:** `docs/spikes/2026-07-<dd>-inspect-jinn-agent-bridge.md` recording the answer, the chosen cost-capture path, and any Inspect config needed. On a green spike, write **Plan 2 — "Two-arm orchestration + cost capture + report"** (Inspect task/solver wiring, seed-loadout installer, provider-actual cost capture, the pre-registration commit per §10.1, the pilot runner per §6.4, and the report/legibility outputs per §10). On a red spike, fall back to a hand-rolled runner over the existing daemon harness path and re-scope Plan 2 accordingly.

---

## Self-Review

**Spec coverage (Plan 1 scope):**
- §2.1(1) NI + relative guard → Task 6 ✓ · §2.1(2) cost → Task 7 ✓ · §4.2 contested band + blind screen → Task 4 ✓ · §4.3 disjointness + derived index → Tasks 2, 3 ✓ · §4.4 artifact → Task 1 ✓ · §6.3 power → Task 5 ✓ · §6.2 gate primary → Tasks 6, 7 ✓.
- Deferred to Plan 2 (gated on spike, explicitly): §2.2 gate assembly (needs both legs wired to a real run), §3 arm execution, §5 metric capture, §6.4 pilot, §9 envelope run, §10/§10.1 report + pre-registration + neutral verification, §12 emitting the artifact to distillation. The slate *schema* + disjointness (Tasks 1–3) are the shared-boundary substrate the distillation session consumes now.

**Placeholder scan:** none — every step ships real test + implementation code.

**Type consistency:** `CapabilitySlateArtifact.disjointness` axis shape (Task 1) matches the `AxisCheck` produced by `checkCorpusDisjoint` (Task 3, modulo the `attestation`/`semantic` fields the artifact adds); `TaskRates` (Task 6) is reused by Task 7's sibling cost path; `zFor`/`invNorm` are defined per-module to avoid a cross-task import cycle (documented in Task 6 comment).

**One known follow-up (not a placeholder):** Task 6's bootstrap is bias-corrected (BC), not full BCa — the acceleration term needs a jackknife pass. Spec §6.2 says "start BCa"; the BC lower bound is conservative (wider), so it cannot manufacture a false PASS. Adding acceleration is a one-function follow-up tracked in Plan 2's stats-hardening task, noted here so it is a deliberate scoping choice, not an omission.
