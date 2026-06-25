# Merge Batch Large Batch Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `merge-batch` so it can handle 30-50 ready PRs by planning deterministic waves, preserving resumable state, and moving fragile GitHub/Project/ordering mechanics into tested helpers.

**Architecture:** Add a typed `packages/eng-loop/src/merge-batch/` planner that turns PR metadata into a batch manifest with waves, skips, risk classes, and resume state. Keep actual merges human-invoked and PR-path compliant, but change the skill from a serial one-PR playbook into a wave executor: plan, preflight wave, execute wave, checkpoint, continue.

**Tech Stack:** TypeScript, Vitest, `gh` CLI through the existing `CommandRunner` seam, git command output captured by runners, Markdown skill documentation.

---

## File Structure

- Create `packages/eng-loop/src/merge-batch/types.ts` for the planner domain model: PR inputs, review decisions, risk classes, waves, manifest, execution state.
- Create `packages/eng-loop/src/merge-batch/risk.ts` for large-PR and solo-lane classification.
- Create `packages/eng-loop/src/merge-batch/waves.ts` for dependency, overlap, and wave planning.
- Create `packages/eng-loop/src/merge-batch/approval-preservation.ts` for the clean-rebase review-preservation rule.
- Create `packages/eng-loop/src/merge-batch/manifest.ts` for manifest creation, resume validation, and state transitions.
- Create `packages/eng-loop/src/merge-batch/cli.ts` and `packages/eng-loop/bin/jinn-merge-batch.ts` for `plan` and fixture-driven dry runs.
- Add tests under `packages/eng-loop/test/merge-batch/`.
- Modify `packages/eng-loop/package.json` to expose `jinn-merge-batch`.
- Modify `.claude/skills/merge-batch/SKILL.md` to use the planner and wave execution model.
- Modify `.claude/skills/merge-batch/references/merge-mechanics.md` to document wave preflight, checkpointing, `range-diff`, and safe merge commands.
- Append large-batch pressure results to `.claude/skills/merge-batch/references/RESULTS.md`.

---

### Task 1: Add Merge Batch Domain Types

**Files:**
- Create: `packages/eng-loop/src/merge-batch/types.ts`
- Test: `packages/eng-loop/test/merge-batch/types.test.ts`

- [ ] **Step 1: Write the failing type-shape test**

Create `packages/eng-loop/test/merge-batch/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { MergeBatchManifest, MergeBatchPr } from '../../src/merge-batch/types.js';

describe('merge-batch types', () => {
  it('models a resumable wave manifest', () => {
    const pr: MergeBatchPr = {
      number: 101,
      title: 'fix(api): correct pagination',
      headRefName: 'fix/101-pagination',
      headRefOid: 'aaa111',
      author: 'contributor',
      linkedIssueNumber: 501,
      blockedOn: 'Nothing',
      files: ['client/src/api/server.ts'],
      additions: 42,
      deletions: 9,
      dependsOnPrNumbers: [],
      review: { kind: 'satisfied', approvers: ['oaksprout'] },
      ci: { kind: 'green' },
      risk: 'normal',
    };

    const manifest: MergeBatchManifest = {
      schemaVersion: 1,
      repo: 'Jinn-Network/mono',
      baseBranch: 'next',
      baseNextSha: 'base123',
      createdAt: '2026-06-17T10:00:00.000Z',
      waves: [
        {
          id: 'wave-1',
          kind: 'independent',
          prs: [pr],
          reason: 'one independent PR',
          status: 'planned',
        },
      ],
      skipped: [],
    };

    expect(manifest.waves[0]?.prs[0]?.number).toBe(101);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/types.test.ts
```

Expected: TypeScript/Vitest fails because `src/merge-batch/types.ts` does not exist.

- [ ] **Step 3: Add the minimal type definitions**

Create `packages/eng-loop/src/merge-batch/types.ts`:

```ts
import type { BlockedOn } from '../dispatcher/types.js';

export type MergeBatchCi =
  | { kind: 'green' }
  | { kind: 'pending'; checks: string[] }
  | { kind: 'red'; checks: string[] };

export type MergeBatchReview =
  | { kind: 'satisfied'; approvers: string[] }
  | { kind: 'awaiting-code-owner-review'; missingOwnerSets: string[][] }
  | { kind: 'awaiting-maintainer-review' };

export type MergeBatchRisk = 'small' | 'normal' | 'large' | 'solo';

export interface MergeBatchPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  author: string;
  linkedIssueNumber: number | null;
  blockedOn: BlockedOn | null;
  files: string[];
  additions: number;
  deletions: number;
  dependsOnPrNumbers: number[];
  review: MergeBatchReview;
  ci: MergeBatchCi;
  risk: MergeBatchRisk;
}

export type MergeBatchSkipReason =
  | 'awaiting-ci'
  | 'ci-red'
  | 'blocked-on-human'
  | 'awaiting-code-owner-review'
  | 'awaiting-maintainer-review'
  | 'missing-linked-issue'
  | 'ambiguous-linked-issue';

export interface MergeBatchSkippedPr {
  pr: MergeBatchPr;
  reason: MergeBatchSkipReason;
  detail: string;
}

export type MergeBatchWaveKind =
  | 'dependency-stack'
  | 'refactor-stack'
  | 'reactive-overlap'
  | 'independent'
  | 'solo-large';

export type MergeBatchWaveStatus =
  | 'planned'
  | 'preflighted'
  | 'executing'
  | 'merged'
  | 'split'
  | 'blocked';

export interface MergeBatchWave {
  id: string;
  kind: MergeBatchWaveKind;
  prs: MergeBatchPr[];
  reason: string;
  status: MergeBatchWaveStatus;
}

export interface MergeBatchManifest {
  schemaVersion: 1;
  repo: 'Jinn-Network/mono';
  baseBranch: 'next';
  baseNextSha: string;
  createdAt: string;
  waves: MergeBatchWave[];
  skipped: MergeBatchSkippedPr[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/merge-batch/types.ts packages/eng-loop/test/merge-batch/types.test.ts
git commit -m "feat(eng-loop): add merge-batch manifest types"
```

---

### Task 2: Implement Large PR Risk Classification

**Files:**
- Create: `packages/eng-loop/src/merge-batch/risk.ts`
- Test: `packages/eng-loop/test/merge-batch/risk.test.ts`

- [ ] **Step 1: Write the failing risk tests**

Create `packages/eng-loop/test/merge-batch/risk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyMergeBatchRisk } from '../../src/merge-batch/risk.js';
import type { MergeBatchPr } from '../../src/merge-batch/types.js';

function pr(overrides: Partial<MergeBatchPr>): MergeBatchPr {
  return {
    number: 1,
    title: 'fix(client): example',
    headRefName: 'fix/example',
    headRefOid: 'sha',
    author: 'author',
    linkedIssueNumber: 1,
    blockedOn: 'Nothing',
    files: ['client/src/foo.ts'],
    additions: 10,
    deletions: 2,
    dependsOnPrNumbers: [],
    review: { kind: 'satisfied', approvers: ['oaksprout'] },
    ci: { kind: 'green' },
    risk: 'normal',
    ...overrides,
  };
}

describe('classifyMergeBatchRisk', () => {
  it('marks tiny PRs as small', () => {
    expect(classifyMergeBatchRisk(pr({ files: ['client/src/foo.ts'], additions: 8, deletions: 2 }))).toBe('small');
  });

  it('marks broad PRs as large', () => {
    const files = Array.from({ length: 21 }, (_, i) => `client/src/file-${i}.ts`);
    expect(classifyMergeBatchRisk(pr({ files, additions: 100, deletions: 20 }))).toBe('large');
  });

  it('marks high-churn PRs as large', () => {
    expect(classifyMergeBatchRisk(pr({ additions: 650, deletions: 220 }))).toBe('large');
  });

  it('puts release and workflow edits in the solo lane', () => {
    expect(classifyMergeBatchRisk(pr({ files: ['.github/workflows/npm-publish.yml'] }))).toBe('solo');
    expect(classifyMergeBatchRisk(pr({ files: ['client/package.json'] }))).toBe('solo');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/risk.test.ts
```

Expected: FAIL because `risk.ts` does not exist.

- [ ] **Step 3: Implement the classifier**

Create `packages/eng-loop/src/merge-batch/risk.ts`:

```ts
import type { MergeBatchPr, MergeBatchRisk } from './types.js';

const SOLO_PATHS = [
  '.github/workflows/',
  'client/package.json',
  'packages/eng-loop/package.json',
  'packages/sdk/package.json',
  'contracts/',
];

export function classifyMergeBatchRisk(pr: Pick<MergeBatchPr, 'files' | 'additions' | 'deletions'>): MergeBatchRisk {
  if (pr.files.some((path) => SOLO_PATHS.some((prefix) => path === prefix || path.startsWith(prefix)))) {
    return 'solo';
  }

  if (pr.files.length >= 20) return 'large';
  if (pr.additions + pr.deletions >= 800) return 'large';
  if (pr.files.length <= 2 && pr.additions + pr.deletions <= 50) return 'small';

  return 'normal';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/risk.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/merge-batch/risk.ts packages/eng-loop/test/merge-batch/risk.test.ts
git commit -m "feat(eng-loop): classify merge-batch PR risk"
```

---

### Task 3: Implement Wave Planning

**Files:**
- Create: `packages/eng-loop/src/merge-batch/waves.ts`
- Test: `packages/eng-loop/test/merge-batch/waves.test.ts`

- [ ] **Step 1: Write the failing wave planner tests**

Create `packages/eng-loop/test/merge-batch/waves.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planMergeBatchWaves } from '../../src/merge-batch/waves.js';
import type { MergeBatchPr } from '../../src/merge-batch/types.js';

function pr(number: number, files: string[], overrides: Partial<MergeBatchPr> = {}): MergeBatchPr {
  return {
    number,
    title: `pr ${number}`,
    headRefName: `branch-${number}`,
    headRefOid: `sha-${number}`,
    author: 'author',
    linkedIssueNumber: number + 1000,
    blockedOn: 'Nothing',
    files,
    additions: 10,
    deletions: 1,
    dependsOnPrNumbers: [],
    review: { kind: 'satisfied', approvers: ['oaksprout'] },
    ci: { kind: 'green' },
    risk: 'normal',
    ...overrides,
  };
}

describe('planMergeBatchWaves', () => {
  it('groups dependency stacks consecutively', () => {
    const waves = planMergeBatchWaves([
      pr(10, ['a.ts']),
      pr(11, ['b.ts'], { dependsOnPrNumbers: [10] }),
      pr(12, ['c.ts']),
    ], { maxWaveSize: 10 });

    expect(waves.map((w) => w.prs.map((p) => p.number))).toEqual([[10, 11], [12]]);
    expect(waves[0]?.kind).toBe('dependency-stack');
    expect(waves[1]?.kind).toBe('independent');
  });

  it('keeps overlapping PRs in the same reactive-overlap wave', () => {
    const waves = planMergeBatchWaves([
      pr(20, ['client/src/store.ts']),
      pr(21, ['client/src/store.ts']),
      pr(22, ['client/src/api.ts']),
    ], { maxWaveSize: 10 });

    expect(waves.map((w) => w.prs.map((p) => p.number))).toEqual([[20, 21], [22]]);
    expect(waves[0]?.kind).toBe('reactive-overlap');
    expect(waves[1]?.kind).toBe('independent');
  });

  it('splits independent PRs by max wave size', () => {
    const waves = planMergeBatchWaves([
      pr(1, ['a.ts']),
      pr(2, ['b.ts']),
      pr(3, ['c.ts']),
      pr(4, ['d.ts']),
      pr(5, ['e.ts']),
    ], { maxWaveSize: 2 });

    expect(waves.map((w) => w.prs.map((p) => p.number))).toEqual([[1, 2], [3, 4], [5]]);
    expect(waves.every((w) => w.kind === 'independent')).toBe(true);
  });

  it('puts large and solo PRs in single-PR waves', () => {
    const waves = planMergeBatchWaves([
      pr(1, ['a.ts']),
      pr(2, ['client/package.json'], { risk: 'solo' }),
      pr(3, ['c.ts'], { risk: 'large' }),
      pr(4, ['d.ts']),
    ], { maxWaveSize: 10 });

    expect(waves.map((w) => w.prs.map((p) => p.number))).toEqual([[1, 4], [2], [3]]);
    expect(waves[1]?.kind).toBe('solo-large');
    expect(waves[2]?.kind).toBe('solo-large');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/waves.test.ts
```

Expected: FAIL because `waves.ts` does not exist.

- [ ] **Step 3: Implement deterministic wave planning**

Create `packages/eng-loop/src/merge-batch/waves.ts`:

```ts
import type { MergeBatchPr, MergeBatchWave, MergeBatchWaveKind } from './types.js';

export interface PlanWaveOptions {
  maxWaveSize: number;
}

export function planMergeBatchWaves(prs: MergeBatchPr[], opts: PlanWaveOptions): MergeBatchWave[] {
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  const solo = sorted.filter((pr) => pr.risk === 'large' || pr.risk === 'solo');
  const regular = sorted.filter((pr) => pr.risk !== 'large' && pr.risk !== 'solo');

  const groups = buildRegularGroups(regular);
  const independent: MergeBatchPr[] = [];
  const waves: MergeBatchWave[] = [];

  for (const group of groups) {
    if (group.kind === 'independent') {
      independent.push(...group.prs);
      continue;
    }
    waves.push(toWave(waves.length + 1, group.kind, group.prs, group.reason));
  }

  for (let i = 0; i < independent.length; i += opts.maxWaveSize) {
    const chunk = independent.slice(i, i + opts.maxWaveSize);
    waves.push(toWave(waves.length + 1, 'independent', chunk, `up to ${opts.maxWaveSize} independent PRs`));
  }

  for (const pr of solo) {
    waves.push(toWave(waves.length + 1, 'solo-large', [pr], `${pr.risk} PR requires its own lane`));
  }

  return waves.sort((a, b) => minPr(a) - minPr(b)).map((wave, i) => ({
    ...wave,
    id: `wave-${i + 1}`,
  }));
}

interface Group {
  kind: MergeBatchWaveKind;
  prs: MergeBatchPr[];
  reason: string;
}

function buildRegularGroups(prs: MergeBatchPr[]): Group[] {
  const remaining = new Map(prs.map((pr) => [pr.number, pr]));
  const groups: Group[] = [];

  for (const pr of prs) {
    if (!remaining.has(pr.number)) continue;
    const component = collectComponent(pr, remaining);
    for (const item of component) remaining.delete(item.number);

    const hasDependency = component.some((item) => item.dependsOnPrNumbers.length > 0);
    const hasOverlap = hasFileOverlap(component);
    const kind: MergeBatchWaveKind = hasDependency
      ? 'dependency-stack'
      : hasOverlap
        ? 'reactive-overlap'
        : 'independent';

    groups.push({
      kind,
      prs: orderComponent(component),
      reason: groupReason(kind),
    });
  }

  return groups;
}

function collectComponent(seed: MergeBatchPr, remaining: Map<number, MergeBatchPr>): MergeBatchPr[] {
  const out = new Map<number, MergeBatchPr>();
  const queue = [seed];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (out.has(current.number)) continue;
    out.set(current.number, current);

    for (const other of remaining.values()) {
      if (out.has(other.number)) continue;
      if (connected(current, other)) queue.push(other);
    }
  }

  return [...out.values()];
}

function connected(a: MergeBatchPr, b: MergeBatchPr): boolean {
  if (a.dependsOnPrNumbers.includes(b.number)) return true;
  if (b.dependsOnPrNumbers.includes(a.number)) return true;
  return a.files.some((file) => b.files.includes(file));
}

function hasFileOverlap(prs: MergeBatchPr[]): boolean {
  const seen = new Set<string>();
  for (const pr of prs) {
    for (const file of pr.files) {
      if (seen.has(file)) return true;
      seen.add(file);
    }
  }
  return false;
}

function orderComponent(prs: MergeBatchPr[]): MergeBatchPr[] {
  return [...prs].sort((a, b) => {
    const aDepends = a.dependsOnPrNumbers.includes(b.number);
    const bDepends = b.dependsOnPrNumbers.includes(a.number);
    if (aDepends && !bDepends) return 1;
    if (bDepends && !aDepends) return -1;
    return a.number - b.number;
  });
}

function groupReason(kind: MergeBatchWaveKind): string {
  if (kind === 'dependency-stack') return 'dependency stack kept consecutive';
  if (kind === 'reactive-overlap') return 'overlapping files kept consecutive';
  return 'independent PRs';
}

function toWave(index: number, kind: MergeBatchWaveKind, prs: MergeBatchPr[], reason: string): MergeBatchWave {
  return {
    id: `wave-${index}`,
    kind,
    prs,
    reason,
    status: 'planned',
  };
}

function minPr(wave: MergeBatchWave): number {
  return Math.min(...wave.prs.map((pr) => pr.number));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/waves.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/merge-batch/waves.ts packages/eng-loop/test/merge-batch/waves.test.ts
git commit -m "feat(eng-loop): plan merge-batch waves"
```

---

### Task 4: Add Approval Preservation for Clean Rebases

**Files:**
- Create: `packages/eng-loop/src/merge-batch/approval-preservation.ts`
- Test: `packages/eng-loop/test/merge-batch/approval-preservation.test.ts`

- [ ] **Step 1: Write failing tests for range-diff interpretation**

Create `packages/eng-loop/test/merge-batch/approval-preservation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyApprovalPreservation } from '../../src/merge-batch/approval-preservation.js';

describe('classifyApprovalPreservation', () => {
  it('preserves approval when range-diff reports equal commits', () => {
    const output = [
      '1:  abc123 = 1:  def456 fix(api): correct pagination',
      '2:  bcd234 = 2:  efg567 test(api): cover pagination',
    ].join('\n');

    expect(classifyApprovalPreservation(output)).toEqual({
      kind: 'preserved',
      reason: 'range-diff shows patch-equivalent commits',
    });
  });

  it('requires review when range-diff reports changed commits', () => {
    const output = [
      '1:  abc123 ! 1:  def456 fix(api): correct pagination',
      '    @@ client/src/api/server.ts @@',
    ].join('\n');

    expect(classifyApprovalPreservation(output)).toEqual({
      kind: 'requires-review',
      reason: 'range-diff shows changed patch content',
    });
  });

  it('requires review when conflict resolution added commits', () => {
    const output = [
      '1:  abc123 = 1:  def456 fix(api): correct pagination',
      '-:  ------ > 2:  efg567 fix merge conflict',
    ].join('\n');

    expect(classifyApprovalPreservation(output)).toEqual({
      kind: 'requires-review',
      reason: 'range-diff shows added or removed commits',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/approval-preservation.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the classifier**

Create `packages/eng-loop/src/merge-batch/approval-preservation.ts`:

```ts
export type ApprovalPreservation =
  | { kind: 'preserved'; reason: string }
  | { kind: 'requires-review'; reason: string };

export function classifyApprovalPreservation(rangeDiffOutput: string): ApprovalPreservation {
  const lines = rangeDiffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.some((line) => line.includes('!'))) {
    return { kind: 'requires-review', reason: 'range-diff shows changed patch content' };
  }

  if (lines.some((line) => line.startsWith('-:') || line.includes('>'))) {
    return { kind: 'requires-review', reason: 'range-diff shows added or removed commits' };
  }

  return { kind: 'preserved', reason: 'range-diff shows patch-equivalent commits' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/approval-preservation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/merge-batch/approval-preservation.ts packages/eng-loop/test/merge-batch/approval-preservation.test.ts
git commit -m "feat(eng-loop): classify clean rebase approval preservation"
```

---

### Task 5: Add Manifest Creation and Resume Validation

**Files:**
- Create: `packages/eng-loop/src/merge-batch/manifest.ts`
- Test: `packages/eng-loop/test/merge-batch/manifest.test.ts`

- [ ] **Step 1: Write failing manifest tests**

Create `packages/eng-loop/test/merge-batch/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMergeBatchManifest, validateResume } from '../../src/merge-batch/manifest.js';
import type { MergeBatchPr } from '../../src/merge-batch/types.js';

function pr(number: number, overrides: Partial<MergeBatchPr> = {}): MergeBatchPr {
  return {
    number,
    title: `pr ${number}`,
    headRefName: `branch-${number}`,
    headRefOid: `sha-${number}`,
    author: 'author',
    linkedIssueNumber: number + 1000,
    blockedOn: 'Nothing',
    files: [`file-${number}.ts`],
    additions: 10,
    deletions: 1,
    dependsOnPrNumbers: [],
    review: { kind: 'satisfied', approvers: ['oaksprout'] },
    ci: { kind: 'green' },
    risk: 'normal',
    ...overrides,
  };
}

describe('merge-batch manifest', () => {
  it('creates waves and skips not-ready PRs', () => {
    const manifest = createMergeBatchManifest({
      baseNextSha: 'base',
      createdAt: '2026-06-17T10:00:00.000Z',
      prs: [
        pr(1),
        pr(2, { ci: { kind: 'pending', checks: ['build'] } }),
        pr(3, { review: { kind: 'awaiting-maintainer-review' } }),
      ],
      maxWaveSize: 5,
    });

    expect(manifest.waves.map((w) => w.prs.map((item) => item.number))).toEqual([[1]]);
    expect(manifest.skipped.map((s) => [s.pr.number, s.reason])).toEqual([
      [2, 'awaiting-ci'],
      [3, 'awaiting-maintainer-review'],
    ]);
  });

  it('allows resume when next still equals the manifest base', () => {
    const manifest = createMergeBatchManifest({
      baseNextSha: 'base',
      createdAt: '2026-06-17T10:00:00.000Z',
      prs: [pr(1)],
      maxWaveSize: 5,
    });

    expect(validateResume(manifest, 'base')).toEqual({ kind: 'valid' });
  });

  it('rejects resume when next advanced outside the batch', () => {
    const manifest = createMergeBatchManifest({
      baseNextSha: 'base',
      createdAt: '2026-06-17T10:00:00.000Z',
      prs: [pr(1)],
      maxWaveSize: 5,
    });

    expect(validateResume(manifest, 'other')).toEqual({
      kind: 'invalid',
      reason: 'origin/next changed since manifest creation',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/manifest.test.ts
```

Expected: FAIL because `manifest.ts` does not exist.

- [ ] **Step 3: Implement manifest creation**

Create `packages/eng-loop/src/merge-batch/manifest.ts`:

```ts
import { planMergeBatchWaves } from './waves.js';
import type { MergeBatchManifest, MergeBatchPr, MergeBatchSkipReason, MergeBatchSkippedPr } from './types.js';

export interface CreateManifestInput {
  baseNextSha: string;
  createdAt: string;
  prs: MergeBatchPr[];
  maxWaveSize: number;
}

export type ResumeValidation =
  | { kind: 'valid' }
  | { kind: 'invalid'; reason: string };

export function createMergeBatchManifest(input: CreateManifestInput): MergeBatchManifest {
  const skipped: MergeBatchSkippedPr[] = [];
  const candidates: MergeBatchPr[] = [];

  for (const pr of input.prs) {
    const reason = skipReason(pr);
    if (reason == null) {
      candidates.push(pr);
    } else {
      skipped.push({ pr, reason, detail: skipDetail(pr, reason) });
    }
  }

  return {
    schemaVersion: 1,
    repo: 'Jinn-Network/mono',
    baseBranch: 'next',
    baseNextSha: input.baseNextSha,
    createdAt: input.createdAt,
    waves: planMergeBatchWaves(candidates, { maxWaveSize: input.maxWaveSize }),
    skipped,
  };
}

export function validateResume(manifest: MergeBatchManifest, currentNextSha: string): ResumeValidation {
  if (manifest.baseNextSha !== currentNextSha) {
    return { kind: 'invalid', reason: 'origin/next changed since manifest creation' };
  }
  return { kind: 'valid' };
}

function skipReason(pr: MergeBatchPr): MergeBatchSkipReason | null {
  if (pr.linkedIssueNumber == null) return 'missing-linked-issue';
  if (pr.blockedOn === 'Human') return 'blocked-on-human';
  if (pr.ci.kind === 'pending') return 'awaiting-ci';
  if (pr.ci.kind === 'red') return 'ci-red';
  if (pr.review.kind === 'awaiting-code-owner-review') return 'awaiting-code-owner-review';
  if (pr.review.kind === 'awaiting-maintainer-review') return 'awaiting-maintainer-review';
  return null;
}

function skipDetail(pr: MergeBatchPr, reason: MergeBatchSkipReason): string {
  if (reason === 'awaiting-ci' && pr.ci.kind === 'pending') {
    return `pending checks: ${pr.ci.checks.join(', ')}`;
  }
  if (reason === 'ci-red' && pr.ci.kind === 'red') {
    return `red checks: ${pr.ci.checks.join(', ')}`;
  }
  if (reason === 'awaiting-code-owner-review' && pr.review.kind === 'awaiting-code-owner-review') {
    return `missing owner sets: ${pr.review.missingOwnerSets.map((set) => set.join('/')).join(', ')}`;
  }
  if (reason === 'awaiting-maintainer-review') return 'needs OWNER or MEMBER approval';
  if (reason === 'blocked-on-human') return 'linked issue is already paused';
  if (reason === 'missing-linked-issue') return 'PR has no linked issue reference';
  return 'PR needs manual review before batch planning';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/eng-loop/src/merge-batch/manifest.ts packages/eng-loop/test/merge-batch/manifest.test.ts
git commit -m "feat(eng-loop): create merge-batch manifests"
```

---

### Task 6: Add Fixture-Driven CLI Planning

**Files:**
- Create: `packages/eng-loop/src/merge-batch/cli.ts`
- Create: `packages/eng-loop/bin/jinn-merge-batch.ts`
- Test: `packages/eng-loop/test/merge-batch/cli.test.ts`
- Modify: `packages/eng-loop/package.json`

- [ ] **Step 1: Write the failing CLI test**

Create `packages/eng-loop/test/merge-batch/cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runMergeBatchCli } from '../../src/merge-batch/cli.js';

describe('runMergeBatchCli', () => {
  it('prints a manifest from fixture JSON', async () => {
    const writes: string[] = [];
    const code = await runMergeBatchCli({
      argv: ['plan', '--fixture-json', JSON.stringify({
        baseNextSha: 'base',
        createdAt: '2026-06-17T10:00:00.000Z',
        maxWaveSize: 2,
        prs: [
          {
            number: 1,
            title: 'pr 1',
            headRefName: 'b1',
            headRefOid: 's1',
            author: 'author',
            linkedIssueNumber: 1001,
            blockedOn: 'Nothing',
            files: ['a.ts'],
            additions: 1,
            deletions: 1,
            dependsOnPrNumbers: [],
            review: { kind: 'satisfied', approvers: ['oaksprout'] },
            ci: { kind: 'green' },
            risk: 'small',
          },
        ],
      })],
      write: (text) => writes.push(text),
      writeError: (text) => writes.push(`ERR:${text}`),
    });

    expect(code).toBe(0);
    expect(JSON.parse(writes.join('')).waves[0].prs[0].number).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/cli.test.ts
```

Expected: FAIL because `cli.ts` does not exist.

- [ ] **Step 3: Implement the CLI**

Create `packages/eng-loop/src/merge-batch/cli.ts`:

```ts
import { createMergeBatchManifest } from './manifest.js';
import type { MergeBatchPr } from './types.js';

export interface MergeBatchCliIo {
  argv: string[];
  write: (text: string) => void;
  writeError: (text: string) => void;
}

interface FixtureInput {
  baseNextSha: string;
  createdAt: string;
  maxWaveSize: number;
  prs: MergeBatchPr[];
}

export async function runMergeBatchCli(io: MergeBatchCliIo): Promise<number> {
  const [command, flag, value] = io.argv;
  if (command !== 'plan' || flag !== '--fixture-json' || value == null) {
    io.writeError('usage: jinn-merge-batch plan --fixture-json <json>\n');
    return 2;
  }

  const fixture = JSON.parse(value) as FixtureInput;
  const manifest = createMergeBatchManifest(fixture);
  io.write(`${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}
```

Create `packages/eng-loop/bin/jinn-merge-batch.ts`:

```ts
#!/usr/bin/env tsx
import { runMergeBatchCli } from '../src/merge-batch/cli.js';

const code = await runMergeBatchCli({
  argv: process.argv.slice(2),
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
});

process.exitCode = code;
```

Modify `packages/eng-loop/package.json`:

```json
{
  "bin": {
    "jinn-triage-check": "./bin/jinn-triage-check.ts",
    "jinn-merge-batch": "./bin/jinn-merge-batch.ts"
  },
  "scripts": {
    "merge:batch": "tsx bin/jinn-merge-batch.ts"
  }
}
```

Keep the existing keys and add only the shown entries.

- [ ] **Step 4: Run the CLI test**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/cli.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run package typecheck**

Run:

```bash
cd packages/eng-loop
yarn typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add packages/eng-loop/src/merge-batch/cli.ts packages/eng-loop/bin/jinn-merge-batch.ts packages/eng-loop/test/merge-batch/cli.test.ts packages/eng-loop/package.json
git commit -m "feat(eng-loop): add merge-batch planning CLI"
```

---

### Task 7: Update the Merge Batch Skill for Waves

**Files:**
- Modify: `.claude/skills/merge-batch/SKILL.md`
- Modify: `.claude/skills/merge-batch/references/merge-mechanics.md`

- [ ] **Step 1: Rewrite the skill overview**

Replace the serial overview with this model:

```md
You are the coordinating agent for one batch integration into `next`. For small batches you may execute one wave. For large batches, especially 30-50 PRs, you plan deterministic waves first: survey PRs, build a manifest, group dependency/overlap/refactor components, isolate large PRs, preflight each wave, execute one wave at a time, checkpoint, and continue only while gates stay green. You do not bypass review, branch protection, or the Monday `next` -> `main` cut.
```

- [ ] **Step 2: Add the large-batch command path**

Add this section near Step 1:

```md
### Large-batch mode

Use large-batch mode when there are more than 10 candidate PRs, any PR is `large` or `solo`, or the human asks to integrate multiple batches. Large-batch mode is:

1. Produce a manifest with `jinn-merge-batch plan`.
2. Show waves and skipped PRs to the human.
3. Execute one wave at a time.
4. After each wave, verify `origin/next`, canary trigger, and manifest state.
5. Stop when drift, CI failure, semantic conflict, or human review need makes the next wave unsafe.
```

- [ ] **Step 3: Replace two-queue language**

Replace the two-queue property with:

```md
### End-state property

At wrap-up, every PR from the manifest is in exactly one state:

- `merged` - integrated into `next`.
- `blocked-human` - semantic conflict or decision needed; linked issue set to `Blocked on: Human`.
- `awaiting-review` - review gate not satisfied; no Project mutation.
- `awaiting-ci` - CI pending or red; no Project mutation unless the failure is a semantic merge-batch finding.
- `deferred-large` - explicitly left for a solo wave.

No PR is left partially rebased, silently dropped, or merged without a matching manifest entry.
```

- [ ] **Step 4: Add clean-rebase approval preservation**

Add this rule to the rebase section:

```md
A clean rebase may preserve the skill's review gate only when `git range-diff <old-base>..<old-head> <new-base>..<new-head>` shows patch-equivalent commits (`=` lines only). If `range-diff` shows changed, added, or removed commits, the PR moves to `awaiting-review` and is not merged in this wave. If GitHub branch protection itself dismisses approvals after push, GitHub wins; do not bypass it.
```

- [ ] **Step 5: Add safe merge command**

Replace bare merge commands with:

```bash
gh pr merge <N> --rebase --repo Jinn-Network/mono --match-head-commit <headRefOid>
```

- [ ] **Step 6: Fix local gate path**

Replace root-level `yarn typecheck && yarn test && yarn build` with:

```bash
cd client && yarn typecheck && yarn test && yarn build
```

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/merge-batch/SKILL.md .claude/skills/merge-batch/references/merge-mechanics.md
git commit -m "docs(eng-loop): upgrade merge-batch for large batches"
```

---

### Task 8: Add Large-Batch Pressure Verification

**Files:**
- Modify: `.claude/skills/merge-batch/references/RESULTS.md`
- Create: `packages/eng-loop/test/merge-batch/large-batch-fixture.test.ts`

- [ ] **Step 1: Write the large-batch fixture test**

Create `packages/eng-loop/test/merge-batch/large-batch-fixture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMergeBatchManifest } from '../../src/merge-batch/manifest.js';
import type { MergeBatchPr } from '../../src/merge-batch/types.js';

function pr(number: number, file: string, overrides: Partial<MergeBatchPr> = {}): MergeBatchPr {
  return {
    number,
    title: `pr ${number}`,
    headRefName: `branch-${number}`,
    headRefOid: `sha-${number}`,
    author: 'author',
    linkedIssueNumber: number + 1000,
    blockedOn: 'Nothing',
    files: [file],
    additions: 12,
    deletions: 2,
    dependsOnPrNumbers: [],
    review: { kind: 'satisfied', approvers: ['oaksprout'] },
    ci: { kind: 'green' },
    risk: 'normal',
    ...overrides,
  };
}

describe('large-batch fixture', () => {
  it('plans 50 PRs into bounded waves with solo lanes and review skips', () => {
    const prs: MergeBatchPr[] = Array.from({ length: 50 }, (_, i) => {
      const number = i + 1;
      return pr(number, `client/src/module-${number}.ts`);
    });

    prs[4] = pr(5, 'client/package.json', { risk: 'solo' });
    prs[9] = pr(10, 'client/src/store.ts');
    prs[10] = pr(11, 'client/src/store.ts');
    prs[19] = pr(20, 'client/src/feature.ts', { dependsOnPrNumbers: [19] });
    prs[29] = pr(30, 'client/src/review.ts', { review: { kind: 'awaiting-maintainer-review' } });

    const manifest = createMergeBatchManifest({
      baseNextSha: 'base',
      createdAt: '2026-06-17T10:00:00.000Z',
      prs,
      maxWaveSize: 8,
    });

    expect(manifest.skipped.map((skip) => skip.pr.number)).toEqual([30]);
    expect(manifest.waves.every((wave) => wave.prs.length <= 8 || wave.kind === 'dependency-stack')).toBe(true);
    expect(manifest.waves.some((wave) => wave.kind === 'solo-large' && wave.prs[0]?.number === 5)).toBe(true);
    expect(manifest.waves.some((wave) => wave.kind === 'reactive-overlap' && wave.prs.some((item) => item.number === 10) && wave.prs.some((item) => item.number === 11))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the large-batch fixture test**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch/large-batch-fixture.test.ts
```

Expected: PASS.

- [ ] **Step 3: Record pressure result**

Append this section to `.claude/skills/merge-batch/references/RESULTS.md`:

```md
## Large-batch wave planning verification (2026-06-17)

Scope: planner only, no real merges, no writes to `next`.

Fixture: 50 PRs, max wave size 8, one solo package PR, one overlapping store pair, one dependency edge, and one PR awaiting maintainer review.

Expected:
- PR awaiting maintainer review is skipped without Project mutation.
- Solo package PR is isolated in its own wave.
- Overlapping store PRs stay together in a reactive-overlap wave.
- Independent PRs are split into bounded waves.

Verdict: PASS when `cd packages/eng-loop && yarn test test/merge-batch/large-batch-fixture.test.ts` passes.
```

- [ ] **Step 4: Commit**

```bash
git add packages/eng-loop/test/merge-batch/large-batch-fixture.test.ts .claude/skills/merge-batch/references/RESULTS.md
git commit -m "test(eng-loop): verify large merge-batch planning"
```

---

### Task 9: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run merge-batch tests**

Run:

```bash
cd packages/eng-loop
yarn test test/merge-batch
```

Expected: PASS.

- [ ] **Step 2: Run eng-loop typecheck**

Run:

```bash
cd packages/eng-loop
yarn typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 3: Run full eng-loop test suite**

Run:

```bash
cd packages/eng-loop
yarn test
```

Expected: PASS.

- [ ] **Step 4: Manual doc review**

Read:

```bash
sed -n '1,260p' .claude/skills/merge-batch/SKILL.md
sed -n '1,340p' .claude/skills/merge-batch/references/merge-mechanics.md
```

Expected:
- `SKILL.md` no longer describes the normal 30-50 PR path as a single serial loop.
- Large-batch mode names manifest, waves, checkpoints, and solo lanes.
- Review preservation is tied to `git range-diff`.
- End states include merged, blocked-human, awaiting-review, awaiting-ci, and deferred-large.

- [ ] **Step 5: Commit any final corrections**

If verification required doc or test corrections:

```bash
git add packages/eng-loop .claude/skills/merge-batch
git commit -m "fix(eng-loop): tighten large merge-batch upgrade"
```

---

## Self-Review

**Spec coverage:** The plan covers the large-batch requirements: deterministic manifest, waves, large PR solo lanes, conflict/overlap grouping, clean-rebase approval preservation, resumability, and skill documentation.

**Placeholder scan:** No task uses unspecified future work as a dependency. Every code task includes file paths, test commands, and implementation snippets.

**Type consistency:** Type names are consistent across tasks: `MergeBatchPr`, `MergeBatchManifest`, `MergeBatchWave`, `MergeBatchReview`, `MergeBatchRisk`, and `classifyApprovalPreservation`.

**Scope:** This plan deliberately stops at planning and dry-run helpers. Live GitHub survey and mutation helpers can be added after this lands, using the same domain model and `CommandRunner` seam.
