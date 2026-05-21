# SWE-rebench v2 eval admission plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Beads (`bd`) is the canonical task tracker per `cargo/CLAUDE.md`; do NOT use TodoWrite or TaskCreate.

**Goal:** Stop on-chain SWE-rebench v2 misclassifications where the eval container failed to grade but produced `Fail(2)` indistinguishable from real wrong-answer failures, by making public/launched task posting fail closed unless instances have been admitted against the exact eval substrate, and by rechecking substrate identity at verdict time.

**Architecture:** Three coordinated client-side changes — (1) extend the existing `validated-pool.json` admission record with `rowHash`, `imageDigest`, `upstreamEvalCommit`; (2) add an `admissionMode: 'required' | 'python-floor'` config field that defaults to `required` for launched generators; (3) recheck substrate identity in the evaluator before grading, with `SkippableError` (not `FAIL`) on any mismatch or HF outage. No SDK schema, contract, TEE, or on-chain verdict-code changes.

**Tech Stack:** TypeScript (client/, packages/sdk/), Vitest, Hono CLI, Docker, HuggingFace datasets-server. Tests use `cd client && yarn test`; typecheck is `cd client && yarn typecheck`.

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `client/src/solver-types/_swe-rebench-v2-validated-pool.ts` | Modify | Bumped `EVAL_SEMANTICS_VERSION`; extended `ValidatedPoolEntry` shape; atomic+merge writes |
| `client/src/solver-types/_swe-rebench-v2-substrate.ts` | Create | Pure helpers: `computeRowHash`, `resolveImageDigest`, `resolveUpstreamEvalCommit` |
| `client/src/solver-types/swe-rebench-v2.ts` | Modify | `admissionMode` config; fail-closed wiring through `filterToScorablePool`; startup warning |
| `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts` | Modify | Four new infra signatures; preserves load-bearing guardrail |
| `client/src/harnesses/impls/swe-rebench-v2-evaluator/harness.ts` | Modify | Verdict-time substrate recheck; HF retry budget; SkippableError on mismatch |
| `client/src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.ts` | Modify | Retry-with-backoff at fetch time |
| `client/src/cli/commands/solver-nets.ts` | Modify | New flags: `--instance-id` (repeatable), `--instances-file`, `--seed-positive`, `--known-bad`; doctor check |
| `client/scripts/swe-rebench-v2-seed-pool.json` | Create | Curated seed list of instance IDs (team-maintained) |
| `client/scripts/swe-rebench-v2-known-bad.json` | Create | The 6 known-broken instance IDs from the 2026-05-14 triage |
| `client/test/solver-types/swe-rebench-v2-validated-pool.test.ts` | Modify | New cases: extended record, atomic write, merge-on-record |
| `client/test/solver-types/swe-rebench-v2-substrate.test.ts` | Create | Tests for `computeRowHash`, digest/commit resolvers |
| `client/test/solver-types/swe-rebench-v2-generator-cooldown.test.ts` | Modify | `admissionMode: 'required'` fail-closed; positive-pool path |
| `client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts` | Modify | Four real-log fixtures throw `EvalCouldNotGradeError`; genuine FAIL still passes |
| `client/test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts` | Modify | Verdict-time mismatch → SkippableError; HF outage → SkippableError; retry budget |
| `client/test/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.test.ts` | Modify | Retry-on-transient + give-up-on-sustained |
| `client/test/cli/solver-nets-validate-pool.test.ts` | Create | CLI flag wiring tests (`--instance-id`, `--instances-file`, `--seed-positive`) |
| `log/decisions/2026-05-14-swe-rebench-eval-admission.md` | Create | DR ratifying admission + SkippableError residual (not `Invalid(3)`); revisit trigger |
| `CHANGELOG.md` (under the next Monday cut) | Modify | Operator-facing rollout notice: re-validate before public posting resumes |

---

## Task 1: Curated seed-pool data files (no code)

**Files:**
- Create: `client/scripts/swe-rebench-v2-seed-pool.json`
- Create: `client/scripts/swe-rebench-v2-known-bad.json`

**Rationale:** Provide a deterministic, reproducible input to the rollout. Every operator re-validating after the semantics bump runs against the same seed set.

- [ ] **Step 1: Create the known-bad list**

`client/scripts/swe-rebench-v2-known-bad.json`:

```json
{
  "comment": "Instance IDs known unscorable per the 2026-05-14 triage (jinn-mono-xw6i, jinn-mono-y4ah). validate-pool --known-bad records every entry below as scorable:false under the current semanticsVersion.",
  "source": "spike jinn-mono-fufn",
  "instance_ids": [
    "basicmachines-co__basic-memory-341",
    "basicmachines-co__basic-memory-484",
    "BerriAI__litellm-13868",
    "beeware__briefcase-2114",
    "beeware__briefcase-2302",
    "beeware__briefcase-2401"
  ]
}
```

- [ ] **Step 2: Create the seed-positive list**

`client/scripts/swe-rebench-v2-seed-pool.json` — start with a modest set covering the 3 most common Python project shapes in the leaderboard. The team can extend this file in follow-up PRs as we observe stable scorable instances. Initial seed:

```json
{
  "comment": "Curated Python instances expected to be scorable on the upstream swe-rebench-v2 substrate. validate-pool --seed-positive runs gold-eval against each entry below. Extend as new known-good instances surface.",
  "source": "spike jinn-mono-fufn",
  "instance_ids": [
    "django__django-15400",
    "django__django-15814",
    "django__django-16429",
    "django__django-16493",
    "django__django-16527",
    "django__django-16569",
    "scikit-learn__scikit-learn-25500",
    "scikit-learn__scikit-learn-25570",
    "scikit-learn__scikit-learn-25638",
    "scikit-learn__scikit-learn-25747",
    "scikit-learn__scikit-learn-25931",
    "scikit-learn__scikit-learn-26194",
    "sympy__sympy-22914",
    "sympy__sympy-22934",
    "sympy__sympy-23262",
    "sympy__sympy-23413",
    "sympy__sympy-23534",
    "sympy__sympy-23950",
    "matplotlib__matplotlib-25287",
    "matplotlib__matplotlib-25775"
  ]
}
```

(Final list to be confirmed by Captain before merge; the file is data, not code, so amendments are zero-risk.)

- [ ] **Step 3: Commit**

```bash
git add client/scripts/swe-rebench-v2-seed-pool.json client/scripts/swe-rebench-v2-known-bad.json
git commit -m "chore(fufn): seed pool + known-bad lists for swe-rebench-v2 admission

Per docs/superpowers/plans/2026-05-14-eval-substrate-admission.md Task 1."
```

---

## Task 2: Bump `EVAL_SEMANTICS_VERSION` + extend admission record shape

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-validated-pool.ts:30-44`
- Test: `client/test/solver-types/swe-rebench-v2-validated-pool.test.ts`

- [ ] **Step 1: Write the failing test for the extended record shape**

Append to `client/test/solver-types/swe-rebench-v2-validated-pool.test.ts`:

```typescript
describe('ValidatedPoolStore — extended substrate fields (semantics v3)', () => {
  it('persists rowHash, imageName, imageDigest, upstreamEvalCommit alongside scorable/reason/checkedAt', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record(
      'a__1',
      {
        scorable: true,
        reason: 'gold-patch-resolves',
        checkedAt: '2026-05-14T00:00:00Z',
        rowHash: 'sha256:abc123',
        imageName: 'swerebenchv2/sweb.eval.x86_64.a__1:latest',
        imageDigest: 'sha256:def456',
        upstreamEvalCommit: '0123456789abcdef',
      },
      EVAL_SEMANTICS_VERSION,
    );
    const entry = await store.getEntry('a__1', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: true,
      rowHash: 'sha256:abc123',
      imageName: 'swerebenchv2/sweb.eval.x86_64.a__1:latest',
      imageDigest: 'sha256:def456',
      upstreamEvalCommit: '0123456789abcdef',
    });
  });

  it('EVAL_SEMANTICS_VERSION === "3"', () => {
    expect(EVAL_SEMANTICS_VERSION).toBe('3');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-validated-pool.test.ts -t "extended substrate fields"`
Expected: FAIL — `EVAL_SEMANTICS_VERSION` is `'2'`, and `ValidatedPoolEntry` lacks the new fields.

- [ ] **Step 3: Bump the version and extend the entry shape**

Edit `client/src/solver-types/_swe-rebench-v2-validated-pool.ts:28-44`:

```typescript
/**
 * Bump when the eval grading semantics change (verdict re-derivation,
 * ungradeable classification, test-command construction) so cached validation
 * results from an older harness are treated as stale and re-checked.
 *
 *   '1' — original exact-set `passed_match`.
 *   '2' — SWE-bench "resolved" semantics + run-the-named-tests `test_cmd`
 *         override (jinn-mono-uy6v.8).
 *   '3' — adds verdict-time substrate recheck (`rowHash`, `imageDigest`,
 *         `upstreamEvalCommit`) and extended ungradeable classifier
 *         (venv collision, missing pytest, dependency warnings, conftest
 *         import/setup failures) — jinn-mono-fufn.
 */
export const EVAL_SEMANTICS_VERSION = '3';

const SCHEMA_VERSION = 'swe-rebench-v2-validated-pool.v1' as const;

export interface ValidatedPoolEntry {
  scorable: boolean;
  /** Why scorable/unscorable — `'gold-patch-resolves'`, `'ungradeable:<reason>'`, etc. */
  reason: string;
  checkedAt: string; // ISO timestamp
  /** Canonical-JSON SHA-256 over the HF row fields used for grading. v3+. */
  rowHash?: string;
  /** Image tag the validation pulled. v3+. */
  imageName?: string;
  /** Image digest resolved from `docker image inspect` after validation. v3+. */
  imageDigest?: string;
  /** `git rev-parse HEAD` of the enabled upstream SWE-rebench repo at validation time. v3+. */
  upstreamEvalCommit?: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-validated-pool.test.ts -t "extended substrate fields"`
Expected: PASS

- [ ] **Step 5: Run the full file to catch regressions**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-validated-pool.test.ts`
Expected: PASS for every case. The existing "stale semantics version" case still passes because the file's `evalSemanticsVersion: 'OLD'` does not match `'3'`.

- [ ] **Step 6: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-validated-pool.ts \
        client/test/solver-types/swe-rebench-v2-validated-pool.test.ts
git commit -m "feat(fufn): extend swe-rebench-v2 admission record with substrate fields

Bumps EVAL_SEMANTICS_VERSION '2' → '3'. Adds optional rowHash, imageName,
imageDigest, upstreamEvalCommit to ValidatedPoolEntry. Existing v2 entries
are treated as stale and will be re-validated when validate-pool runs."
```

---

## Task 3: Substrate-field computation helpers

**Files:**
- Create: `client/src/solver-types/_swe-rebench-v2-substrate.ts`
- Test: `client/test/solver-types/swe-rebench-v2-substrate.test.ts`

- [ ] **Step 1: Write the failing tests**

`client/test/solver-types/swe-rebench-v2-substrate.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  computeRowHash,
  resolveImageDigest,
  resolveUpstreamEvalCommit,
} from '../../src/solver-types/_swe-rebench-v2-substrate.js';

describe('computeRowHash', () => {
  it('is deterministic over field reorderings of the same input', () => {
    const a = computeRowHash({
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      instance_id: 'x__1',
      repo: 'acme/widget',
      base_commit: 'deadbeef',
      image_name: 'img:latest',
      patch: 'diff a',
      test_patch: 'diff b',
      install_config: { install: ['pip install .'], test_cmd: ['pytest'], log_parser: 'parse_log_pytest' },
      FAIL_TO_PASS: ['t::a', 't::b'],
      PASS_TO_PASS: ['t::c'],
    });
    const b = computeRowHash({
      // same data, different key order
      PASS_TO_PASS: ['t::c'],
      FAIL_TO_PASS: ['t::a', 't::b'],
      install_config: { log_parser: 'parse_log_pytest', test_cmd: ['pytest'], install: ['pip install .'] },
      test_patch: 'diff b',
      patch: 'diff a',
      image_name: 'img:latest',
      base_commit: 'deadbeef',
      repo: 'acme/widget',
      instance_id: 'x__1',
      hf_split: '2026_02',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
    });
    expect(a).toEqual(b);
  });

  it('changes when any covered field changes', () => {
    const base = computeRowHash({
      hf_dataset: 'd', hf_split: 's', instance_id: 'i', repo: 'r', base_commit: 'c',
      image_name: 'img', patch: 'p', test_patch: 'tp',
      install_config: { install: ['x'], test_cmd: ['y'], log_parser: 'parse_log_pytest' },
      FAIL_TO_PASS: ['a'], PASS_TO_PASS: ['b'],
    });
    expect(base).not.toEqual(computeRowHash({ ...basicArgs(), image_name: 'OTHER' }));
    expect(base).not.toEqual(computeRowHash({ ...basicArgs(), patch: 'p2' }));
    expect(base).not.toEqual(computeRowHash({ ...basicArgs(), FAIL_TO_PASS: ['z'] }));
  });

  function basicArgs() {
    return {
      hf_dataset: 'd', hf_split: 's', instance_id: 'i', repo: 'r', base_commit: 'c',
      image_name: 'img', patch: 'p', test_patch: 'tp',
      install_config: { install: ['x'], test_cmd: ['y'], log_parser: 'parse_log_pytest' },
      FAIL_TO_PASS: ['a'], PASS_TO_PASS: ['b'],
    };
  }

  it('has a sha256: prefix', () => {
    expect(computeRowHash(basicArgs())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  function basicArgs() {
    return {
      hf_dataset: 'd', hf_split: 's', instance_id: 'i', repo: 'r', base_commit: 'c',
      image_name: 'img', patch: 'p', test_patch: 'tp',
      install_config: { install: ['x'], test_cmd: ['y'], log_parser: 'parse_log_pytest' },
      FAIL_TO_PASS: ['a'], PASS_TO_PASS: ['b'],
    };
  }
});

describe('resolveImageDigest', () => {
  it('returns the first RepoDigest from docker image inspect', async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '["myimg@sha256:abc123def456"]',
      stderr: '',
    });
    const digest = await resolveImageDigest('myimg:latest', runner);
    expect(digest).toBe('sha256:abc123def456');
    expect(runner).toHaveBeenCalledWith('docker', [
      'image', 'inspect', 'myimg:latest', '--format', '{{json .RepoDigests}}',
    ]);
  });

  it('returns null when docker exits non-zero', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no such image' });
    expect(await resolveImageDigest('missing:latest', runner)).toBeNull();
  });

  it('returns null when RepoDigests is empty', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' });
    expect(await resolveImageDigest('myimg:latest', runner)).toBeNull();
  });
});

describe('resolveUpstreamEvalCommit', () => {
  it('returns the trimmed rev-parse output', async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '0123456789abcdef0123456789abcdef01234567\n',
      stderr: '',
    });
    const sha = await resolveUpstreamEvalCommit('/path/to/upstream', runner);
    expect(sha).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(runner).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], { cwd: '/path/to/upstream' });
  });

  it('returns null when git fails', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'not a git repo' });
    expect(await resolveUpstreamEvalCommit('/not/a/repo', runner)).toBeNull();
  });
});
```

(Note: the duplicated `basicArgs` is intentional. The plan-skill rule is to repeat code so tasks are independently readable; vitest hoists nested `function` declarations within a `describe`, but if your editor complains, lift `basicArgs` out and dedupe.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-substrate.test.ts`
Expected: FAIL — `_swe-rebench-v2-substrate.ts` does not exist.

- [ ] **Step 3: Implement the helpers**

`client/src/solver-types/_swe-rebench-v2-substrate.ts`:

```typescript
/**
 * Pure helpers for the swe-rebench-v2 admission record's substrate-identity
 * fields (`rowHash`, `imageDigest`, `upstreamEvalCommit`). v3 of
 * EVAL_SEMANTICS_VERSION (see _swe-rebench-v2-validated-pool.ts).
 *
 * These are extracted from `validatePoolInstances` so they can be unit-tested
 * independently and reused by the verdict-time substrate recheck in the
 * evaluator harness.
 */

import { createHash } from 'node:crypto';

export interface RowHashInput {
  hf_dataset: string;
  hf_split: string;
  instance_id: string;
  repo: string;
  base_commit: string;
  image_name: string;
  patch: string;
  test_patch: string;
  install_config: {
    install: string[] | string;
    test_cmd: string[] | string;
    log_parser: string;
  };
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
}

/**
 * Canonical-JSON SHA-256 over the HF row fields that affect grading.
 * Keys are sorted recursively so field-reorder produces the same hash.
 * Output is `sha256:<lowercase-hex>` (RFC 8785 JCS-compatible for these
 * primitive types — no float / Date / BigInt in the row).
 */
export function computeRowHash(row: RowHashInput): string {
  const canonical = JSON.stringify(row, sortedKeys);
  const hex = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${hex}`;
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  }
  return value;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  bin: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<CommandResult>;

/**
 * Resolve the digest of a local Docker image via `docker image inspect`.
 * Returns null when docker fails or the image has no RepoDigests entry
 * (e.g. local-only images that haven't been pulled from a registry).
 */
export async function resolveImageDigest(
  imageName: string,
  runner: CommandRunner,
): Promise<string | null> {
  const res = await runner('docker', [
    'image', 'inspect', imageName, '--format', '{{json .RepoDigests}}',
  ]);
  if (res.exitCode !== 0) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(res.stdout.trim()); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0];
  if (typeof first !== 'string') return null;
  // `RepoDigests` entries are `<name>@sha256:<hex>`; strip the name.
  const at = first.indexOf('@');
  return at === -1 ? null : first.slice(at + 1);
}

/**
 * Resolve the upstream SWE-rebench-V2 repo's HEAD commit via `git rev-parse`.
 * Returns null when git fails (not a repo, missing, etc.).
 */
export async function resolveUpstreamEvalCommit(
  upstreamRepoDir: string,
  runner: CommandRunner,
): Promise<string | null> {
  const res = await runner('git', ['rev-parse', 'HEAD'], { cwd: upstreamRepoDir });
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-substrate.test.ts`
Expected: PASS for every case.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-substrate.ts \
        client/test/solver-types/swe-rebench-v2-substrate.test.ts
git commit -m "feat(fufn): substrate-field helpers for swe-rebench-v2 admission

computeRowHash, resolveImageDigest, resolveUpstreamEvalCommit. Pure
helpers extracted so they're reusable by both validate-pool and the
verdict-time substrate recheck in the evaluator harness."
```

---

## Task 4: Persist extended fields during `validatePoolInstances`

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-validated-pool.ts:165-253` (the `validatePoolInstances` function)
- Test: `client/test/solver-types/swe-rebench-v2-validated-pool.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `client/test/solver-types/swe-rebench-v2-validated-pool.test.ts`:

```typescript
describe('validatePoolInstances — populates substrate fields', () => {
  it('records rowHash, imageName, imageDigest, upstreamEvalCommit on a successful validation', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const summary = await validatePoolInstances(
      [poolTask('a__1')],
      {
        fetcher: {
          fetchTaskRow: async () => ({
            instance_id: 'a__1',
            repo: 'acme/widget',
            image_name: 'acme/widget:latest',
            FAIL_TO_PASS: ['t::a'],
            PASS_TO_PASS: ['t::b'],
            test_patch: 'diff b',
            install_config: { install: ['pip install .'], test_cmd: ['pytest'], log_parser: 'parse_log_pytest' },
          }),
        },
        runner: {
          runEval: async () => ({ passed_match: true, passed: ['t::a'], failed: [], log: '', exitCode: 0 }),
        },
        store,
        semanticsVersion: EVAL_SEMANTICS_VERSION,
        upstreamRepoDir: '/fake/upstream',
        commandRunner: async (bin, args) => {
          if (bin === 'docker' && args[0] === 'image') {
            return { exitCode: 0, stdout: '["acme/widget@sha256:deadbeef"]', stderr: '' };
          }
          if (bin === 'git' && args[0] === 'rev-parse') {
            return { exitCode: 0, stdout: 'abcdef1234567890\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: 'unexpected' };
        },
      },
    );
    expect(summary.scorable).toBe(1);
    const entry = await store.getEntry('a__1', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: true,
      imageName: 'acme/widget:latest',
      imageDigest: 'sha256:deadbeef',
      upstreamEvalCommit: 'abcdef1234567890',
    });
    expect(entry!.rowHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('records the entry as unscorable when imageDigest cannot be resolved (required mode)', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await validatePoolInstances(
      [poolTask('a__1')],
      {
        fetcher: {
          fetchTaskRow: async () => ({
            instance_id: 'a__1', repo: 'acme/widget', image_name: 'acme/widget:latest',
            FAIL_TO_PASS: ['t::a'], PASS_TO_PASS: ['t::b'], test_patch: 'diff b',
            install_config: { install: ['pip install .'], test_cmd: ['pytest'], log_parser: 'parse_log_pytest' },
          }),
        },
        runner: { runEval: async () => ({ passed_match: true, passed: ['t::a'], failed: [], log: '', exitCode: 0 }) },
        store,
        semanticsVersion: EVAL_SEMANTICS_VERSION,
        upstreamRepoDir: '/fake/upstream',
        commandRunner: async (bin, args) => {
          if (bin === 'docker') return { exitCode: 1, stdout: '', stderr: 'no such image' };
          if (bin === 'git') return { exitCode: 0, stdout: 'abcdef1234567890\n', stderr: '' };
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      },
    );
    const entry = await store.getEntry('a__1', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({ scorable: false, reason: 'unresolvable-image-digest' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-validated-pool.test.ts -t "populates substrate fields"`
Expected: FAIL — `ValidatePoolDeps` does not accept `upstreamRepoDir` / `commandRunner`; `validatePoolInstances` doesn't compute substrate fields.

- [ ] **Step 3: Extend `ValidatePoolDeps` and wire the new fields in**

Edit `client/src/solver-types/_swe-rebench-v2-validated-pool.ts:165-253`:

```typescript
import { computeRowHash, resolveImageDigest, resolveUpstreamEvalCommit, type CommandRunner } from './_swe-rebench-v2-substrate.js';
import { spawn } from 'node:child_process';

export interface ValidatePoolDeps {
  fetcher: HfFetcher;
  runner: EvalRunner;
  store: ValidatedPoolStore;
  semanticsVersion: string;
  /** Required v3+: used to resolve `upstreamEvalCommit`. */
  upstreamRepoDir: string;
  /** Required v3+: defaults to spawn-based runner; tests inject a stub. */
  commandRunner?: CommandRunner;
  log?: (msg: string) => void;
}

const defaultCommandRunner: CommandRunner = (bin, args, opts) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { ...(opts ?? {}), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout?.on('data', (d) => { stdout += d.toString(); });
  child.stderr?.on('data', (d) => { stderr += d.toString(); });
  child.on('error', reject);
  child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
});

export async function validatePoolInstances(
  pool: PoolTask[],
  deps: ValidatePoolDeps,
  opts: { limit?: number; force?: boolean } = {},
): Promise<ValidatePoolSummary> {
  const log = deps.log ?? (() => {});
  const runner = deps.commandRunner ?? defaultCommandRunner;
  const summary: ValidatePoolSummary = { checked: 0, scorable: 0, unscorable: 0, skipped: 0 };

  // Resolve the upstream eval commit once per run — it doesn't change mid-run.
  const upstreamEvalCommit = await resolveUpstreamEvalCommit(deps.upstreamRepoDir, runner);

  for (const task of pool) {
    if (opts.limit != null && summary.checked >= opts.limit) break;
    if (!isPythonInstance(task)) {
      await deps.store.record(task.instance_id, { scorable: false, reason: 'non-pytest-unsupported', checkedAt: new Date().toISOString() }, deps.semanticsVersion);
      summary.skipped += 1;
      continue;
    }
    if (!opts.force && (await deps.store.getEntry(task.instance_id, deps.semanticsVersion))) continue;
    if (!task.patch || !task.test_patch) {
      await deps.store.record(task.instance_id, { scorable: false, reason: 'missing-gold-patch', checkedAt: new Date().toISOString() }, deps.semanticsVersion);
      summary.checked += 1; summary.unscorable += 1;
      continue;
    }

    log(`[validate-pool] ${task.instance_id} …`);
    let entry: ValidatedPoolEntry;
    try {
      const row = await deps.fetcher.fetchTaskRow({ hf_dataset: task.hf_dataset, hf_split: task.hf_split, instance_id: task.instance_id });
      const rowHash = computeRowHash({
        hf_dataset: task.hf_dataset,
        hf_split: task.hf_split,
        instance_id: task.instance_id,
        repo: task.repo ?? row.repo,
        base_commit: task.base_commit ?? '',
        image_name: row.image_name,
        patch: task.patch,
        test_patch: row.test_patch ?? task.test_patch,
        install_config: row.install_config,
        FAIL_TO_PASS: row.FAIL_TO_PASS,
        PASS_TO_PASS: row.PASS_TO_PASS,
      });
      const res = await deps.runner.runEval({
        instance_id: task.instance_id,
        repo: task.repo ?? row.repo,
        image: row.image_name,
        patch: task.patch,
        test_patch: row.test_patch ?? task.test_patch,
        install: row.install_config.install,
        test_cmd: row.install_config.test_cmd,
        log_parser: row.install_config.log_parser,
        fail_to_pass: row.FAIL_TO_PASS,
        pass_to_pass: row.PASS_TO_PASS,
      });
      // Resolve digest AFTER the eval ran — that's when the image is guaranteed
      // to be present locally with its RepoDigests populated.
      const imageDigest = await resolveImageDigest(row.image_name, runner);
      const checkedAt = new Date().toISOString();
      if (!imageDigest) {
        // Required-mode admissions must carry a digest. No digest → not admissible.
        entry = { scorable: false, reason: 'unresolvable-image-digest', checkedAt, rowHash, imageName: row.image_name, ...(upstreamEvalCommit ? { upstreamEvalCommit } : {}) };
      } else {
        entry = res.passed_match
          ? { scorable: true, reason: 'gold-patch-resolves', checkedAt, rowHash, imageName: row.image_name, imageDigest, ...(upstreamEvalCommit ? { upstreamEvalCommit } : {}) }
          : { scorable: false, reason: `gold-patch-not-resolved (f2p ${res.passed.length}, p2p_broke ${res.failed.length})`, checkedAt, rowHash, imageName: row.image_name, imageDigest, ...(upstreamEvalCommit ? { upstreamEvalCommit } : {}) };
      }
    } catch (err) {
      const reason = nameOf(err) === 'EvalCouldNotGradeError'
        ? `ungradeable:${reasonOf(err)}`
        : `error:${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
      entry = { scorable: false, reason, checkedAt: new Date().toISOString() };
    }
    await deps.store.record(task.instance_id, entry, deps.semanticsVersion);
    summary.checked += 1;
    if (entry.scorable) summary.scorable += 1; else summary.unscorable += 1;
    log(`[validate-pool] ${task.instance_id} → ${entry.scorable ? 'SCORABLE' : 'unscorable'} (${entry.reason})`);
  }
  return summary;
}
```

- [ ] **Step 4: Update the CLI invocation site to pass the new deps**

Edit `client/src/cli/commands/solver-nets.ts:314-323`:

```typescript
const summary = await validatePoolInstances(
  poolTasks,
  {
    fetcher: new HttpHfFetcher(),
    runner: new PythonEvalRunner({ upstreamRepoDir }),
    store,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    upstreamRepoDir,
    log: (m) => process.stderr.write(`${m}\n`),
  },
  { limit, force },
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-validated-pool.test.ts`
Expected: PASS

- [ ] **Step 6: Run typecheck to catch CLI breakage**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-validated-pool.ts \
        client/src/cli/commands/solver-nets.ts \
        client/test/solver-types/swe-rebench-v2-validated-pool.test.ts
git commit -m "feat(fufn): persist substrate fields during validate-pool

validatePoolInstances now computes rowHash, resolves imageDigest after
the eval runs, and records upstreamEvalCommit once per run. Required-mode
admissions without a resolvable image digest are recorded scorable:false."
```

---

## Task 5: Strengthen the ungradeable classifier

**Files:**
- Modify: `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:155-166`
- Test: `client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts`

- [ ] **Step 1: Write failing tests for the four real-log fingerprints**

Append to `client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { matchInfraSignature } from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';

// Real fingerprints from the 2026-05-14 triage on Base Sepolia.
const VENV_COLLISION = [
  'error: Failed to create virtual environment.',
  '  Caused by: A virtual environment already exists at /testbed/.venv',
  '  Use --clear to replace it',
].join('\n');

const MISSING_PYTEST =
  '/opt/conda/bin/python: No module named pytest';

const REQUESTS_DEP_WARNING =
  'requests.exceptions.RequestsDependencyWarning: urllib3 (2.2.2) or chardet (7.4.3)/charset_normalizer (3.3.2) doesn\'t match a supported version!';

const CONFTEST_IMPORT_ERROR =
  'ImportError while loading conftest \'/testbed/tests/conftest.py\'.';

describe('matchInfraSignature — 2026-05-14 triage fingerprints', () => {
  it('classifies venv-collision (jinn-mono-xw6i)', () => {
    expect(matchInfraSignature(VENV_COLLISION)).toBe('venv_collision');
  });
  it('classifies missing pytest in /opt/conda (jinn-mono-xw6i)', () => {
    expect(matchInfraSignature(MISSING_PYTEST)).toBe('pytest_missing');
  });
  it('classifies the urllib3/charset_normalizer dependency warning (jinn-mono-y4ah)', () => {
    expect(matchInfraSignature(REQUESTS_DEP_WARNING)).toBe('requests_dep_mismatch');
  });
  it('classifies conftest ImportError (jinn-mono-y4ah)', () => {
    expect(matchInfraSignature(CONFTEST_IMPORT_ERROR)).toBe('conftest_import_error');
  });

  it('still leaves a normal pytest FAIL session alone (returns null)', () => {
    const normalFail = [
      '=================== test session starts ===================',
      'tests/test_x.py::test_foo FAILED',
      '=================== 1 failed in 0.42s ===================',
    ].join('\n');
    expect(matchInfraSignature(normalFail)).toBeNull();
  });
});
```

- [ ] **Step 2: Export `matchInfraSignature` from the module**

The function is currently file-local. Make it exported at `eval-runner.ts:168` so the test can import it directly:

```typescript
export function matchInfraSignature(log: string): string | null {
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd client && yarn test test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts -t "2026-05-14"`
Expected: FAIL — the four signatures aren't in `INFRA_SIGNATURES`.

- [ ] **Step 4: Add the four new signatures**

Edit `client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts:155-166`:

```typescript
const INFRA_SIGNATURES: Array<{ rx: RegExp; reason: string }> = [
  { rx: /Cannot connect to the Docker daemon/i, reason: 'docker_unavailable' },
  { rx: /input\/output error/i, reason: 'docker_storage_io_error' },
  { rx: /No such image|manifest unknown|pull access denied/i, reason: 'image_pull_failed' },
  { rx: /error: corrupt patch at line|patch fragment without header/i, reason: 'patch_corrupt' },
  { rx: /patch does not apply|error: patch failed:/i, reason: 'patch_does_not_apply' },
  { rx: /Applied patch to .+ with conflicts|^U \S/m, reason: 'patch_merge_conflict' },
  { rx: /: command not found/i, reason: 'test_command_not_found' },
  { rx: /Failed building editable|Failed to build installable wheels/i, reason: 'install_build_failed' },
  { rx: /No virtual environment found/i, reason: 'venv_missing' },
  { rx: /exec format error|the requested image's platform .* does not match/i, reason: 'image_arch_mismatch' },
  // 2026-05-14 triage (jinn-mono-fufn) — failure fingerprints from real verdicts:
  { rx: /A virtual environment already exists at .+\.venv/i, reason: 'venv_collision' },
  { rx: /No module named pytest/i, reason: 'pytest_missing' },
  { rx: /RequestsDependencyWarning/i, reason: 'requests_dep_mismatch' },
  { rx: /ImportError while loading conftest/i, reason: 'conftest_import_error' },
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && yarn test test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts`
Expected: PASS for every case, including the "normal pytest FAIL" case (which must still return `null` — guardrail that the new patterns don't over-match).

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.ts \
        client/test/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.test.ts
git commit -m "fix(fufn): classify four 2026-05-14 triage fingerprints as ungradeable

Adds INFRA_SIGNATURES entries for venv_collision, pytest_missing,
requests_dep_mismatch, conftest_import_error. The load-bearing
'no expected tests passed AND a signature matches' guardrail is unchanged."
```

---

## Task 6: Atomic write + reload-merge for `ValidatedPoolStore`

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-validated-pool.ts:66-129` (`ValidatedPoolStore` class)
- Test: `client/test/solver-types/swe-rebench-v2-validated-pool.test.ts`

- [ ] **Step 1: Write the failing concurrency test**

Append to `client/test/solver-types/swe-rebench-v2-validated-pool.test.ts`:

```typescript
describe('ValidatedPoolStore — concurrent record() does not lose entries', () => {
  it('two concurrent record() calls for different instance ids leave both in the file', async () => {
    const dir = tmpDir();
    const storeA = new ValidatedPoolStore({ stateDir: dir });
    const storeB = new ValidatedPoolStore({ stateDir: dir });
    // Both stores load (empty), then both record concurrently.
    await Promise.all([
      storeA.record('a__1', { scorable: true, reason: 'ok', checkedAt: '2026-05-14T00:00:00Z' }, EVAL_SEMANTICS_VERSION),
      storeB.record('a__2', { scorable: true, reason: 'ok', checkedAt: '2026-05-14T00:00:01Z' }, EVAL_SEMANTICS_VERSION),
    ]);
    // A fresh store sees both entries on disk.
    const storeC = new ValidatedPoolStore({ stateDir: dir });
    expect(await storeC.getEntry('a__1', EVAL_SEMANTICS_VERSION)).not.toBeNull();
    expect(await storeC.getEntry('a__2', EVAL_SEMANTICS_VERSION)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-validated-pool.test.ts -t "concurrent record"`
Expected: FAIL — last `save()` wins; the earlier write's entry is lost.

- [ ] **Step 3: Change `record()` to reload-merge-write, and write atomically**

Replace the `save()` / `record()` methods in `ValidatedPoolStore`:

```typescript
import { rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Inside ValidatedPoolStore class:

async record(instanceId: string, entry: ValidatedPoolEntry, evalSemanticsVersion: string): Promise<void> {
  // Reload from disk so a concurrent write isn't lost. The in-memory cache
  // is invalidated; the next read re-loads.
  this.cache = null;
  this.scorableIdsCache = null;
  const raw = await this.readRaw();
  const file = isValidFile(raw, evalSemanticsVersion) ? raw : freshFile(evalSemanticsVersion);
  file.entries[instanceId] = entry;
  file.updatedAt = new Date().toISOString();
  await this.writeAtomic(file);
  this.cache = file;
}

private async writeAtomic(file: ValidatedPoolFile): Promise<void> {
  await mkdir(dirname(this.file), { recursive: true });
  const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2));
  await rename(tmp, this.file); // POSIX rename is atomic
}
```

Remove the now-unused `loadForWrite` method (or keep it for `getEntry` — adjust as needed). Drop the standalone `save()` method since `record` now owns the write path.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-validated-pool.test.ts`
Expected: PASS for every case, including the new concurrency test and all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-validated-pool.ts \
        client/test/solver-types/swe-rebench-v2-validated-pool.test.ts
git commit -m "fix(fufn): atomic write + reload-merge for ValidatedPoolStore

Concurrent record() calls against disjoint instance ids no longer lose
the other's entries. Write is tempfile + POSIX rename (atomic);
in-memory cache invalidated and reloaded per record()."
```

---

## Task 7: `validate-pool` CLI flags

**Files:**
- Modify: `client/src/cli/commands/solver-nets.ts:222-330` (the `validate-pool` subverb)
- Create: `client/test/cli/solver-nets-validate-pool.test.ts`

- [ ] **Step 1: Write the failing CLI test**

`client/test/cli/solver-nets-validate-pool.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The CLI handler dispatches through ctx.argv. These tests exercise a thin
// wrapper that resolves the instance-id input flags into a string[] — wired
// into the subverb. The unit-under-test is `resolveValidatePoolInstanceIds`
// in client/src/cli/commands/solver-nets.ts.
import { resolveValidatePoolInstanceIds } from '../../src/cli/commands/solver-nets.js';

describe('resolveValidatePoolInstanceIds', () => {
  it('returns repeated --instance-id values in order', () => {
    const ids = resolveValidatePoolInstanceIds({ instanceId: ['a__1', 'a__2'] });
    expect(ids).toEqual(['a__1', 'a__2']);
  });

  it('reads --instances-file (newline-delimited, ignores blanks and # comments)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'validate-pool-cli-'));
    const path = join(dir, 'ids.txt');
    writeFileSync(path, '# comment\na__1\n\na__2\n  a__3  \n');
    const ids = resolveValidatePoolInstanceIds({ instancesFile: path });
    expect(ids).toEqual(['a__1', 'a__2', 'a__3']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads --seed-positive from client/scripts/swe-rebench-v2-seed-pool.json', () => {
    const ids = resolveValidatePoolInstanceIds({ seedPositive: true });
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toMatch(/__/); // instance IDs look like `org__repo-NNNN`
  });

  it('reads --known-bad from client/scripts/swe-rebench-v2-known-bad.json', () => {
    const ids = resolveValidatePoolInstanceIds({ knownBad: true });
    expect(ids).toContain('basicmachines-co__basic-memory-341');
    expect(ids).toContain('beeware__briefcase-2114');
  });

  it('concatenates and de-duplicates across flags', () => {
    const ids = resolveValidatePoolInstanceIds({
      instanceId: ['basicmachines-co__basic-memory-341'],
      knownBad: true,
    });
    expect(ids.filter((id) => id === 'basicmachines-co__basic-memory-341')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/cli/solver-nets-validate-pool.test.ts`
Expected: FAIL — `resolveValidatePoolInstanceIds` is not exported.

- [ ] **Step 3: Add the resolver function + the four flags**

Edit `client/src/cli/commands/solver-nets.ts` — in the parseArgs options block (line ~241):

```typescript
options: {
  config: { type: 'string' },
  harness: { type: 'string' },
  'closed-window': { type: 'boolean' },
  limit: { type: 'string' },
  force: { type: 'boolean' },
  human: { type: 'boolean' },
  json: { type: 'boolean' },
  // Repeatable instance-id input flags (jinn-mono-fufn Task 7):
  'instance-id': { type: 'string', multiple: true },
  'instances-file': { type: 'string' },
  'seed-positive': { type: 'boolean' },
  'known-bad': { type: 'boolean' },
},
```

Add the resolver as a named export near the top of the file (after imports):

```typescript
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export function resolveValidatePoolInstanceIds(flags: {
  instanceId?: string[];
  instancesFile?: string;
  seedPositive?: boolean;
  knownBad?: boolean;
}): string[] {
  const collected: string[] = [];
  if (flags.instanceId) collected.push(...flags.instanceId);
  if (flags.instancesFile) {
    const body = readFileSync(flags.instancesFile, 'utf8');
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      collected.push(line);
    }
  }
  if (flags.seedPositive) {
    collected.push(...readInstanceIdFile('client/scripts/swe-rebench-v2-seed-pool.json'));
  }
  if (flags.knownBad) {
    collected.push(...readInstanceIdFile('client/scripts/swe-rebench-v2-known-bad.json'));
  }
  return Array.from(new Set(collected));
}

function readInstanceIdFile(relPath: string): string[] {
  // Resolve relative to the repo root the client lives in. In tests this
  // resolves to the worktree root; in production the file is bundled in
  // the published package's scripts/ directory.
  const candidates = [
    resolvePath(process.cwd(), relPath),
    resolvePath(__dirname, '..', '..', '..', relPath),
    resolvePath(__dirname, '..', '..', '..', '..', relPath),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { instance_ids?: string[] };
      if (Array.isArray(parsed.instance_ids)) return parsed.instance_ids;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Could not locate ${relPath} (looked in ${candidates.join(', ')})`);
}
```

Wire the resolver into the `validate-pool` subverb at line ~313 (replacing `loadSweRebenchV2Pool()` when explicit IDs are present):

```typescript
const instanceIds = resolveValidatePoolInstanceIds({
  instanceId: parsed.values['instance-id'] as string[] | undefined,
  instancesFile: parsed.values['instances-file'] as string | undefined,
  seedPositive: Boolean(parsed.values['seed-positive']),
  knownBad: Boolean(parsed.values['known-bad']),
});

process.stderr.write('[validate-pool] loading the SWE-rebench v2 pool…\n');
let poolTasks = await loadSweRebenchV2Pool();
if (instanceIds.length > 0) {
  const wanted = new Set(instanceIds);
  poolTasks = poolTasks.filter((t) => wanted.has(t.instance_id));
  process.stderr.write(`[validate-pool] restricted to ${poolTasks.length} of ${wanted.size} requested instance ids\n`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test test/cli/solver-nets-validate-pool.test.ts`
Expected: PASS for every case.

- [ ] **Step 5: Update the CLI usage string**

Edit the `usage` block at `client/src/cli/commands/solver-nets.ts:222`:

```typescript
  jinn solver-nets validate-pool swe-rebench-v2 [--limit <n>] [--force]
                                [--instance-id <id>]... [--instances-file <path>]
                                [--seed-positive] [--known-bad]
            Run the gold patch of each pool instance through the eval harness
            and cache which instances are scorable; the generator then posts
            only those. Requires Docker + `jinn harnesses enable
            swe-rebench-v2-evaluator`.
            --seed-positive runs against client/scripts/swe-rebench-v2-seed-pool.json;
            --known-bad records instances from .../swe-rebench-v2-known-bad.json
            as scorable:false. Repeatable --instance-id and --instances-file
            scope the run to a specific subset.
```

- [ ] **Step 6: Commit**

```bash
git add client/src/cli/commands/solver-nets.ts client/test/cli/solver-nets-validate-pool.test.ts
git commit -m "feat(fufn): validate-pool --instance-id / --instances-file / --seed-positive / --known-bad

Scope a validate-pool run to specific instances. --seed-positive and
--known-bad read from in-tree data files (client/scripts/) so every
operator's rollout validation is deterministic and reproducible."
```

---

## Task 8: `admissionMode` config + generator fail-closed

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-validated-pool.ts:131-150` (`filterToScorablePool`)
- Modify: `client/src/solver-types/swe-rebench-v2.ts` (`makeSweRebenchV2Generator`, config shape)
- Test: `client/test/solver-types/swe-rebench-v2-generator-cooldown.test.ts`

- [ ] **Step 1: Write failing tests for required-mode fail-closed**

Append to `client/test/solver-types/swe-rebench-v2-generator-cooldown.test.ts`:

```typescript
describe('swe-rebench-v2 generator — admissionMode: required', () => {
  it('posts nothing when validated-pool.json is absent in required mode', async () => {
    const dir = tmpDir();
    const gen = makeTestGenerator({ stateDir: dir, admissionMode: 'required' });
    const task = await gen.tick();
    expect(task).toBeNull();
  });

  it('posts nothing when validated-pool.json has no scorable entries in required mode', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('a__1', { scorable: false, reason: 'unscorable', checkedAt: '2026-05-14T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    const gen = makeTestGenerator({ stateDir: dir, admissionMode: 'required' });
    const task = await gen.tick();
    expect(task).toBeNull();
  });

  it('posts only admitted scorable instances in required mode', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('a__1', { scorable: true, reason: 'ok', checkedAt: '2026-05-14T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    const gen = makeTestGenerator({
      stateDir: dir,
      admissionMode: 'required',
      poolTasks: [poolTask('a__1'), poolTask('a__2')],
    });
    const task = await gen.tick();
    expect(task?.spec).toMatchObject({ instance_id: 'a__1' });
  });

  it('falls back to python-floor when admissionMode is python-floor and no validation data exists', async () => {
    const dir = tmpDir();
    const gen = makeTestGenerator({
      stateDir: dir,
      admissionMode: 'python-floor',
      poolTasks: [poolTask('a__1')],
    });
    // No admission data, python-floor enabled → posts.
    const task = await gen.tick();
    expect(task?.spec).toMatchObject({ instance_id: 'a__1' });
  });
});
```

(`makeTestGenerator` and `poolTask` helpers from the existing test file — add an `admissionMode` parameter to the helper.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-generator-cooldown.test.ts -t "admissionMode: required"`
Expected: FAIL — the generator doesn't accept `admissionMode`; today's default behaviour returns a Python-floor task even without validation data.

- [ ] **Step 3: Change `filterToScorablePool`'s signature to take `admissionMode`**

Edit `client/src/solver-types/_swe-rebench-v2-validated-pool.ts`:

```typescript
export type AdmissionMode = 'required' | 'python-floor';

/**
 * Restrict the generator's posting pool.
 *
 * Required mode (default for launched/public generators): only admitted
 * scorable instances are eligible. Absent or stale admission data → empty
 * pool. The generator is expected to surface a startup warning instructing
 * the operator to run `jinn solver-nets validate-pool`.
 *
 * Python-floor mode (local/dev opt-in): if admission data is present, use
 * it; otherwise fall back to Python-only instances (today's pre-fufn
 * behaviour). Preserved so contributors can iterate without running a
 * full validation pass.
 */
export function filterToScorablePool(
  pool: PoolTask[],
  scorableIds: Set<string> | null,
  admissionMode: AdmissionMode = 'required',
): { pool: PoolTask[]; mode: 'validated' | 'python-floor' | 'admission-required-no-data' } {
  if (scorableIds) {
    return { pool: pool.filter((t) => scorableIds.has(t.instance_id)), mode: 'validated' };
  }
  if (admissionMode === 'python-floor') {
    return { pool: pool.filter(isPythonInstance), mode: 'python-floor' };
  }
  return { pool: [], mode: 'admission-required-no-data' };
}
```

- [ ] **Step 4: Wire `admissionMode` through the generator config**

Edit `client/src/solver-types/swe-rebench-v2.ts`. Add `admissionMode` to the generator's runtime config (next to `N_max_postings_per_task`), default to `'required'`, and thread it into `filterToScorablePool`:

```typescript
const { pool: eligiblePool, mode: poolMode } = filterToScorablePool(
  pool,
  scorableIds,
  genConfig.admissionMode,
);
if (poolMode === 'admission-required-no-data' && !floorWarned) {
  floorWarned = true;
  console.warn(
    `[swe-rebench-v2-gen] no pool-validation data — admissionMode='required' is fail-closed.\n` +
    `  Run:  jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad\n` +
    `  Expected duration: ~1-2h (one gold-patch eval per seed instance).\n` +
    `  For local development, set solverNets.<name>.taskGenerator.admissionMode = "python-floor".`,
  );
}
if (poolMode === 'python-floor' && !floorWarned) {
  floorWarned = true;
  console.warn(
    `[swe-rebench-v2-gen] admissionMode='python-floor' (local/dev): restricting to ${eligiblePool.length} Python instance(s) of ${pool.length}; run \`jinn solver-nets validate-pool swe-rebench-v2 --seed-positive\` to advance to required mode.`,
  );
}
```

Add to `DEFAULT_GENERATOR_CONFIG`:

```typescript
const DEFAULT_GENERATOR_CONFIG = {
  N_max_postings_per_task: 3,
  admissionMode: 'required' as const,
};
```

- [ ] **Step 5: Update `normalizeGeneratorConfig` to accept and validate the field**

Wherever `normalizeGeneratorConfig` lives in `swe-rebench-v2.ts`, parse `admissionMode` from the input config and validate it's one of the two literals; default to `'required'`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd client && yarn test test/solver-types/swe-rebench-v2-generator-cooldown.test.ts`
Expected: PASS for every case.

- [ ] **Step 7: Run full test suite to catch regressions**

Run: `cd client && yarn test`
Expected: PASS for every existing test. Some pre-existing tests for `filterToScorablePool` may be using the 2-arg signature; bring them to the 3-arg version using the explicit default. Update those tests in this same step (do not change their semantics).

- [ ] **Step 8: Commit**

```bash
git add client/src/solver-types/_swe-rebench-v2-validated-pool.ts \
        client/src/solver-types/swe-rebench-v2.ts \
        client/test/solver-types/swe-rebench-v2-generator-cooldown.test.ts \
        client/test/solver-types/swe-rebench-v2-validated-pool.test.ts
git commit -m "feat(fufn): admissionMode required|python-floor on swe-rebench-v2 generator

Launched/public generators default to required: no posting unless
validated-pool.json has scorable entries under the current semantics
version. Local/dev keep python-floor via explicit config opt-in.
Emits an instructive startup warning when admission data is absent."
```

---

## Task 9: Verdict-time substrate recheck in the evaluator harness

**Files:**
- Modify: `client/src/harnesses/impls/swe-rebench-v2-evaluator/harness.ts:332-449` (`run` method)
- Test: `client/test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts`

- [ ] **Step 1: Write failing tests for verdict-time substrate recheck**

Append to `client/test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts`:

```typescript
describe('SweRebenchV2EvaluatorHarness — verdict-time substrate recheck', () => {
  it('throws SkippableError when no admission entry exists for the instance', async () => {
    const dir = tmpDir(); // ValidatedPoolStore with no entries
    const harness = makeTestHarness({ stateDir: dir });
    await expect(harness.run(makeCtx({ instance_id: 'a__1' }))).rejects.toThrow(/SkippableError/);
    // No artifact written
    expect(existsSync(join(harness.workingDir, 'swe-rebench-v2-verdict.json'))).toBe(false);
  });

  it('throws SkippableError when the admission entry is unscorable', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('a__1', { scorable: false, reason: 'unscorable', checkedAt: 'now', rowHash: 'sha256:x', imageName: 'img', imageDigest: 'sha256:y' }, EVAL_SEMANTICS_VERSION);
    const harness = makeTestHarness({ stateDir: dir });
    await expect(harness.run(makeCtx({ instance_id: 'a__1' }))).rejects.toThrow(/SkippableError/);
  });

  it('throws SkippableError when rowHash drifted between admission and verdict time', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('a__1', { scorable: true, reason: 'ok', checkedAt: 'now', rowHash: 'sha256:ADMITTED', imageName: 'img', imageDigest: 'sha256:y' }, EVAL_SEMANTICS_VERSION);
    const harness = makeTestHarness({
      stateDir: dir,
      // HF row at verdict time produces a different rowHash
      hfRow: { /* … fields that hash to something other than ADMITTED */ },
    });
    await expect(harness.run(makeCtx({ instance_id: 'a__1' }))).rejects.toThrow(/SkippableError.*rowHash/);
  });

  it('throws SkippableError when imageDigest drifted', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('a__1', { scorable: true, reason: 'ok', checkedAt: 'now', rowHash: 'sha256:OK', imageName: 'img', imageDigest: 'sha256:ADMITTED' }, EVAL_SEMANTICS_VERSION);
    const harness = makeTestHarness({
      stateDir: dir,
      currentDigest: 'sha256:DIFFERENT',
    });
    await expect(harness.run(makeCtx({ instance_id: 'a__1' }))).rejects.toThrow(/SkippableError.*imageDigest/);
  });

  it('grades normally when admission entry matches current substrate', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    // … set up admission with matching rowHash + digest …
    const harness = makeTestHarness({ stateDir: dir, /* matching substrate */ });
    const out = await harness.run(makeCtx({ instance_id: 'a__1' }));
    expect(out.gating?.passed_match).toBeDefined();
  });
});
```

(The test-helper functions `makeTestHarness`, `makeCtx`, `tmpDir` exist in the file already; extend them to accept `stateDir`, `hfRow`, `currentDigest`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts -t "substrate recheck"`
Expected: FAIL — harness doesn't check admission at verdict time.

- [ ] **Step 3: Add the substrate-recheck call before `evaluator.grade`**

Edit `client/src/harnesses/impls/swe-rebench-v2-evaluator/harness.ts`. After the `task` is parsed (line ~350) and before `evaluator.grade(...)` (line ~368), insert the recheck:

```typescript
import {
  ValidatedPoolStore,
  EVAL_SEMANTICS_VERSION,
} from '../../../solver-types/_swe-rebench-v2-validated-pool.js';
import {
  computeRowHash,
  resolveImageDigest,
} from '../../../solver-types/_swe-rebench-v2-substrate.js';

// In the run() method, after:
//   const task = SweRebenchV2TaskSchema.parse(ctx.task.spec);
//   const envelope = SignedEnvelopeSchema.parse(JSON.parse(manifestJson));
//   …
//   const solutionPayload = SweRebenchV2SolutionPayloadSchema.parse(envelope.payload);

// Substrate recheck (jinn-mono-fufn): refuse to grade if admission record
// is missing/unscorable, or if rowHash/imageDigest drifted since admission.
const stateDir = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ?? join(homedir(), '.jinn-client', 'solver-types', 'swe-rebench-v2');
const admissionStore = new ValidatedPoolStore({ stateDir });
const admission = await admissionStore.getEntry(task.instance_id, EVAL_SEMANTICS_VERSION);

if (!admission || !admission.scorable) {
  throw new SkippableError(
    'admission_missing_or_unscorable',
    `no scorable admission for ${task.instance_id} under semanticsVersion=${EVAL_SEMANTICS_VERSION}`,
  );
}

const fetcher: HfFetcher = this.deps.fetcher ?? new HttpHfFetcher();
let row: HfRow;
try {
  row = await fetcher.fetchTaskRow({
    hf_dataset: task.hf_dataset,
    hf_split: task.hf_split,
    instance_id: task.instance_id,
  });
} catch (err) {
  throw new SkippableError(
    'hf_fetch_failed',
    `cannot verify substrate (HF unreachable): ${err instanceof Error ? err.message : String(err)}`,
  );
}

const currentRowHash = computeRowHash({
  hf_dataset: task.hf_dataset,
  hf_split: task.hf_split,
  instance_id: task.instance_id,
  repo: row.repo,
  base_commit: task.base_commit ?? '',
  image_name: row.image_name,
  patch: solutionPayload.patch /* or whatever field holds the gold patch in the task */,
  test_patch: row.test_patch,
  install_config: row.install_config,
  FAIL_TO_PASS: row.FAIL_TO_PASS,
  PASS_TO_PASS: row.PASS_TO_PASS,
});
if (admission.rowHash && currentRowHash !== admission.rowHash) {
  throw new SkippableError(
    'substrate_drift_rowHash',
    `rowHash drift for ${task.instance_id}: admitted=${admission.rowHash}, current=${currentRowHash}`,
  );
}

if (admission.imageDigest) {
  const currentDigest = await resolveImageDigest(row.image_name, /* runCommand-style */ runCommand);
  if (currentDigest && currentDigest !== admission.imageDigest) {
    throw new SkippableError(
      'substrate_drift_imageDigest',
      `imageDigest drift for ${task.instance_id}: admitted=${admission.imageDigest}, current=${currentDigest}`,
    );
  }
  // currentDigest === null is tolerated here — pre-existing local cache may not
  // expose RepoDigests. The eval-runner will pull on demand if needed.
}

// All checks passed → continue to evaluator.grade(...).
```

(Note: `solutionPayload.patch` is illustrative; use the actual field from the parsed `Solution` envelope that mirrors the gold patch. If only `task.spec` carries the relevant patch field, use that — the rowHash inputs must match the ones used at validate-pool time exactly.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts -t "substrate recheck"`
Expected: PASS for every case.

- [ ] **Step 5: Run the full harness test file**

Run: `cd client && yarn test test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts`
Expected: PASS for every existing test. If existing tests didn't seed `ValidatedPoolStore`, fix them by writing a `scorable: true` entry with matching rowHash + digest during test setup, OR by setting `JINN_SWE_REBENCH_V2_STATE_DIR` to a fresh empty dir and skipping the recheck via a `_testDeps.skipSubstrateRecheck = true` injection. Pick the approach that minimises test-data setup; do not weaken the production check.

- [ ] **Step 6: Commit**

```bash
git add client/src/harnesses/impls/swe-rebench-v2-evaluator/harness.ts \
        client/test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts
git commit -m "feat(fufn): verdict-time substrate recheck in swe-rebench-v2 evaluator

Before grading, the harness re-fetches the HF row, recomputes rowHash,
and (when present) checks the local image digest against the admission
entry. Any mismatch — missing admission, unscorable, rowHash drift,
imageDigest drift, HF outage — throws SkippableError. Never fails open."
```

---

## Task 10: HF retry budget at verdict time

**Files:**
- Modify: `client/src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.ts`
- Test: `client/test/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.test.ts`

- [ ] **Step 1: Write failing test for retry behaviour**

Append to `client/test/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.test.ts`:

```typescript
describe('HttpHfFetcher — retry budget for transient failures', () => {
  it('retries on transient HTTP 5xx and succeeds on the third try', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) return new Response('', { status: 503 });
      return new Response(JSON.stringify({
        rows: [{ row: makeRow('a__1') }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [1, 2, 4] });
    const row = await fetcher.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' });
    expect(row.instance_id).toBe('a__1');
    expect(calls).toBe(3);
  });

  it('gives up after exhausting the retry budget and throws', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [1, 2, 4] });
    await expect(
      fetcher.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' }),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(4); // 1 initial + 3 retries
  });

  it('does not retry on 4xx (client errors are not transient)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const fetcher = new HttpHfFetcher({ fetchImpl, retryBackoffMs: [1, 2, 4] });
    await expect(
      fetcher.fetchTaskRow({ hf_dataset: 'd', hf_split: 's', instance_id: 'a__1' }),
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });
});

function makeRow(instance_id: string) {
  return {
    instance_id,
    repo: 'acme/widget',
    image_name: 'img:latest',
    FAIL_TO_PASS: [],
    PASS_TO_PASS: [],
    test_patch: '',
    install_config: { install: [], test_cmd: [], log_parser: 'parse_log_pytest' },
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && yarn test test/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.test.ts -t "retry budget"`
Expected: FAIL — `HttpHfFetcher` doesn't retry and doesn't accept `retryBackoffMs`.

- [ ] **Step 3: Add retry-with-backoff to `fetchTaskRow`**

Edit `client/src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.ts:14-77`:

```typescript
export interface HttpHfFetcherOptions {
  baseUrl?: string;
  pageSize?: number;
  maxRows?: number;
  fetchImpl?: typeof fetch;
  /**
   * Per-page retry backoff schedule (ms) for transient HTTP 5xx or network
   * errors. Default: [200, 800, 3200]. Each entry is the delay before the
   * Nth retry; an empty array disables retries. Non-5xx responses (e.g.
   * 404) are not retried — they're not transient.
   */
  retryBackoffMs?: number[];
}

const DEFAULT_RETRY_BACKOFF_MS = [200, 800, 3200];

export class HttpHfFetcher implements HfFetcher {
  // … existing fields …
  private readonly retryBackoffMs: number[];

  constructor(opts: HttpHfFetcherOptions = {}) {
    // … existing init …
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.retryBackoffMs.length; attempt += 1) {
      try {
        const res = await this.fetchImpl(url);
        if (res.ok || (res.status >= 400 && res.status < 500)) return res;
        // 5xx → retry-eligible
        lastErr = new Error(`HF returned ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (attempt < this.retryBackoffMs.length) {
        await new Promise((r) => setTimeout(r, this.retryBackoffMs[attempt]));
      }
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new Error('HF fetch failed after retries');
  }

  async fetchTaskRow(args: { hf_dataset: string; hf_split: string; instance_id: string }): Promise<HfRow> {
    let offset = 0;
    while (offset < this.maxRows) {
      const url = new URL(this.baseUrl);
      url.searchParams.set('dataset', args.hf_dataset);
      url.searchParams.set('config', 'default');
      url.searchParams.set('split', args.hf_split);
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('length', String(this.pageSize));

      const res = await this.fetchWithRetry(url.toString());
      if (!res.ok) {
        throw new Error(
          `HF datasets-server returned ${res.status} for ${args.hf_dataset}/${args.hf_split}`,
        );
      }
      // … rest unchanged …
    }
    throw new Error(/* … unchanged … */);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd client && yarn test test/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.test.ts`
Expected: PASS for every case.

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.ts \
        client/test/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.test.ts
git commit -m "feat(fufn): HF fetch retry budget for transient 5xx errors

HttpHfFetcher retries on 5xx with [200, 800, 3200]ms backoff before
giving up. 4xx errors are not retried (not transient). Reduces
spurious SkippableErrors at verdict time when HF is intermittently
flaky."
```

---

## Task 11: `jinn doctor` pool-freshness check

**Files:**
- Modify: `client/src/cli/commands/solver-nets.ts:365-385` (the `doctor` subverb)
- Test: `client/test/cli/solver-nets-doctor-pool-freshness.test.ts` (create)

- [ ] **Step 1: Write the failing test**

`client/test/cli/solver-nets-doctor-pool-freshness.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSweRebenchV2PoolFreshness } from '../../src/cli/commands/solver-nets.js';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'doctor-pool-freshness-'));
  tmps.push(d);
  return d;
}

describe('describeSweRebenchV2PoolFreshness', () => {
  it('reports "stale" when the file is absent', async () => {
    const dir = tmpDir();
    const r = await describeSweRebenchV2PoolFreshness({ stateDir: dir });
    expect(r.status).toBe('stale');
    expect(r.reason).toMatch(/absent/);
  });

  it('reports "stale" when the file has a different semantics version', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'validated-pool.json'), JSON.stringify({
      schemaVersion: 'swe-rebench-v2-validated-pool.v1',
      evalSemanticsVersion: 'OLD',
      updatedAt: '2026-01-01T00:00:00Z',
      entries: {},
    }));
    const r = await describeSweRebenchV2PoolFreshness({ stateDir: dir });
    expect(r.status).toBe('stale');
    expect(r.reason).toMatch(/OLD/);
  });

  it('reports "ready" with counts when the file is current', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'validated-pool.json'), JSON.stringify({
      schemaVersion: 'swe-rebench-v2-validated-pool.v1',
      evalSemanticsVersion: '3',
      updatedAt: '2026-05-14T00:00:00Z',
      entries: {
        'a__1': { scorable: true, reason: 'ok', checkedAt: 'now' },
        'a__2': { scorable: false, reason: 'nope', checkedAt: 'now' },
      },
    }));
    const r = await describeSweRebenchV2PoolFreshness({ stateDir: dir });
    expect(r.status).toBe('ready');
    expect(r.scorable).toBe(1);
    expect(r.unscorable).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && yarn test test/cli/solver-nets-doctor-pool-freshness.test.ts`
Expected: FAIL — `describeSweRebenchV2PoolFreshness` is not exported.

- [ ] **Step 3: Implement the freshness check**

Add to `client/src/cli/commands/solver-nets.ts`:

```typescript
export async function describeSweRebenchV2PoolFreshness(opts: {
  stateDir: string;
}): Promise<
  | { status: 'ready'; semanticsVersion: string; scorable: number; unscorable: number; total: number }
  | { status: 'stale'; reason: string; cli: string }
> {
  const path = join(opts.stateDir, 'validated-pool.json');
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {
      status: 'stale',
      reason: 'validated-pool.json is absent or unreadable',
      cli: 'jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad',
    };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { status: 'stale', reason: 'validated-pool.json is malformed', cli: 'jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad' };
  }
  const file = raw as { evalSemanticsVersion?: string; entries?: Record<string, { scorable?: boolean }> };
  if (file.evalSemanticsVersion !== EVAL_SEMANTICS_VERSION) {
    return {
      status: 'stale',
      reason: `validated-pool.json was built for semanticsVersion=${file.evalSemanticsVersion ?? 'unknown'}, current=${EVAL_SEMANTICS_VERSION}`,
      cli: 'jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad',
    };
  }
  const entries = file.entries ?? {};
  const scorable = Object.values(entries).filter((e) => e.scorable === true).length;
  const unscorable = Object.values(entries).length - scorable;
  return {
    status: 'ready',
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    scorable,
    unscorable,
    total: scorable + unscorable,
  };
}
```

Wire the call into the `doctor` subverb output for SWE-rebench v2 SolverNets. Surface the result in both `--human` and `--json` output: human prints a one-liner with the CLI hint when stale; JSON includes the structured object.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && yarn test test/cli/solver-nets-doctor-pool-freshness.test.ts`
Expected: PASS for every case.

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/solver-nets.ts client/test/cli/solver-nets-doctor-pool-freshness.test.ts
git commit -m "feat(fufn): jinn doctor reports swe-rebench-v2 pool freshness

After a semantics bump, doctor surfaces \"stale\" with the exact CLI to
re-validate. Operators self-diagnose before reaching the launcher's
silent fail-closed path."
```

---

## Task 12: DR + CHANGELOG + close b609

**Files:**
- Create: `log/decisions/2026-05-14-swe-rebench-eval-admission.md`
- Modify: `CHANGELOG.md` (under the next-Monday-cut header)
- bd action: close `jinn-mono-b609` with revisit trigger

- [ ] **Step 1: Write the DR**

`log/decisions/2026-05-14-swe-rebench-eval-admission.md`:

```markdown
# SWE-rebench v2 eval admission — fail-closed + verdict-time recheck + SkippableError residual

Date: 2026-05-14
Author: opus
Resolves: `jinn-mono-fufn` (spike output); `jinn-mono-b609` (closed in favour of this approach)

## Summary

Adopt admission-fail-closed for the SWE-rebench v2 launched/public generator,
plus verdict-time substrate recheck, plus `SkippableError` for residual drift.
Do not emit `Invalid(3)` for ungradeable evals in this phase.

## Context

The 2026-05-14 triage surfaced ~64% of recent FAIL verdicts as eval-container
failures, not model failures. The spike `jinn-mono-fufn` (see
`docs/superpowers/specs/2026-05-14-eval-substrate-spike.md`) explored four
candidate properties for the eval boundary; this DR ratifies the v1
implementation choice.

## Decision

- Public/launched generators default to `admissionMode: 'required'`. No
  posting unless the instance is admitted (`scorable: true`) under the current
  `EVAL_SEMANTICS_VERSION`.
- Admission record extended with `rowHash`, `imageName`, `imageDigest`,
  `upstreamEvalCommit`.
- Evaluator rechecks the admission record + recomputes `rowHash` + compares
  `imageDigest` at verdict time. Any mismatch → `SkippableError` (no
  on-chain verdict). HF fetch failures at verdict time → `SkippableError`
  after retry budget exhausted.
- Local/dev preserves today's behaviour via explicit
  `admissionMode: 'python-floor'`.
- Ungradeable evals continue to throw `SkippableError` (no on-chain verdict),
  not `Invalid(3)`. Activity-counter contribution for ungradeables is
  deferred.

## Explicitly NOT done

- `Invalid(3)` emission for ungradeable evals (`jinn-mono-b609` closed).
- Typed `EvalSubstrate` primitive on `SolverNetContract`.
- TEE attestation of the eval substrate.
- Protocol-enforced admission attestation in ValidationRegistry.
- Backfill reclassification of the 107 historical verdicts.
- Explorer per-verdict `failureMode` column (`jinn-mono-tptp` remains open).

## Revisit triggers

- Residual `SkippableError` rate exceeds 5% of attempted evals over a 30-day
  window. Mechanism: emit `Invalid(3)` with `failureMode` instead of
  silent skip.
- A second SolverType requires the same admission pattern. Mechanism:
  extract shared admission/substrate shape from the swe-rebench-v2
  implementation.

## Rationale

- Admission gating addresses the cause (broken instances should never
  become Tasks) instead of the symptom (post-hoc reclassification).
- `SkippableError` residual keeps the on-chain signal honest about what
  the chain knows: nothing, because the eval didn't grade. Emitting
  `Invalid(3)` would require recalibrating the OLAS activity-checker
  reward formula; skipping leaves that work for later.
- `rowHash` + `imageDigest` recheck at verdict time catches drift between
  admission and grading — the case neither pure admission gating nor pure
  classifier-fix would catch on its own.

## References

- Spike output: `docs/superpowers/specs/2026-05-14-eval-substrate-spike.md`
- Implementation plan: `docs/superpowers/plans/2026-05-14-eval-substrate-admission.md`
- bd: `jinn-mono-fufn`, closed `jinn-mono-b609`, closed `jinn-mono-xw6i`,
  closed `jinn-mono-y4ah`, open `jinn-mono-tptp`, open `jinn-mono-nf92`
```

- [ ] **Step 2: Add the CHANGELOG entry**

Add under the next unreleased Monday-cut header in `CHANGELOG.md`:

```markdown
### SWE-rebench v2 admission

- **Admission semantics bumped from `'2'` → `'3'`.** Operators running the
  public/launched generator MUST re-validate before posting resumes:

  ```bash
  jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --known-bad
  ```

  Expected duration: ~1-2h (one gold-patch eval per seed instance).
- **Required admission mode is now the default for launched generators.**
  Local/dev users running `admissionMode: 'python-floor'` keep today's
  behaviour. `jinn doctor` reports pool freshness and prints the exact
  re-validation command when stale.
- **Verdict-time substrate recheck** catches drift between admission and
  grading. Any mismatch (rowHash, imageDigest, HF outage) skips the verdict
  rather than emitting a misclassified FAIL.
```

- [ ] **Step 3: Commit the DR + CHANGELOG**

```bash
git add log/decisions/2026-05-14-swe-rebench-eval-admission.md CHANGELOG.md
git commit -m "docs(fufn): DR + operator-facing rollout notice for swe-rebench-v2 admission

Ratifies the admission-fail-closed + verdict-time recheck + SkippableError
residual approach. CHANGELOG entry instructs operators to run validate-pool
before public posting resumes."
```

- [ ] **Step 4: Close the symptom bds**

```bash
bd close jinn-mono-b609 --reason "Closed in favour of admission-fail-closed + SkippableError residual (DR 2026-05-14-swe-rebench-eval-admission). Revisit if residual SkippableError rate exceeds 5% of attempted evals over a 30-day window; mechanism would be emit Invalid(3) with failureMode instead of silent skip."

bd close jinn-mono-xw6i --reason "No in-tree workaround shipped; the six known-bad instances (basic-memory-341/484, litellm-13868, briefcase-2114/2302/2401) are recorded scorable:false in validated-pool.json via \`jinn solver-nets validate-pool swe-rebench-v2 --known-bad\` and never become Tasks under required admission mode. Upstream Princeton issue filed separately."

bd close jinn-mono-y4ah --reason "Same disposition as jinn-mono-xw6i — affected beeware instances marked unscorable via --known-bad seed. Upstream SWE-rebench-V2 issue filed separately."

# jinn-mono-tptp stays OPEN as deferred observability work.
# jinn-mono-nf92 stays OPEN — adjacent to this spike, unblocked.
```

- [ ] **Step 5: Push beads state**

```bash
bd dolt push
```

- [ ] **Step 6: Update fufn with completion note**

```bash
bd update jinn-mono-fufn --notes "Spike output + implementation plan landed. Plan: docs/superpowers/plans/2026-05-14-eval-substrate-admission.md. DR: log/decisions/2026-05-14-swe-rebench-eval-admission.md. Symptom bds closed: b609, xw6i, y4ah. Still open follow-ups: tptp (observability), nf92 (cost-attribution)."
```

---

## Final integration checks

After all 12 tasks have committed:

- [ ] **Step 1: Run the full test suite**

```bash
cd client && yarn test
```
Expected: PASS for every test, including new tests added in Tasks 2-11.

- [ ] **Step 2: Run typecheck**

```bash
cd client && yarn typecheck
```
Expected: zero errors.

- [ ] **Step 3: Run a manual end-to-end smoke**

On a workstation with Docker running and `jinn harnesses enable swe-rebench-v2-evaluator` already done:

```bash
# 1. Confirm doctor reports stale (the version bump just shipped):
jinn solver-nets doctor swe-rebench-v2 --human
# Expected: ".../validated-pool.json was built for semanticsVersion=2, current=3 …"

# 2. Run validate-pool against the known-bad seeds:
jinn solver-nets validate-pool swe-rebench-v2 --known-bad --json
# Expected: 6 unscorable entries recorded; reason includes "ungradeable:venv_collision",
# "ungradeable:pytest_missing", "ungradeable:requests_dep_mismatch", or
# "ungradeable:conftest_import_error".

# 3. Run validate-pool against the seed-positive list (this takes 1-2h):
jinn solver-nets validate-pool swe-rebench-v2 --seed-positive --json
# Expected: most seed instances record scorable:true with rowHash, imageDigest,
# upstreamEvalCommit fields populated.

# 4. Doctor now reports ready:
jinn solver-nets doctor swe-rebench-v2 --human
# Expected: ".../validated-pool.json: ready (semanticsVersion=3, N scorable, M unscorable, K total)"

# 5. Start the daemon; the public generator posts only admitted instances.
jinn run
```

- [ ] **Step 4: Push the branch and open a PR**

```bash
git push -u origin worktree-jinn-mono-fufn-eval-substrate-spike
gh pr create --title "fix(fufn): SWE-rebench v2 eval admission fail-closed + verdict-time recheck" \
  --body "$(cat <<'EOF'
## Summary

Implements `docs/superpowers/plans/2026-05-14-eval-substrate-admission.md`.

Closes the ~64% misclassification problem from the 2026-05-14 triage by:
1. Bumping `EVAL_SEMANTICS_VERSION` `'2'` → `'3'`, extending the admission
   record with `rowHash`, `imageDigest`, `upstreamEvalCommit`.
2. Defaulting launched generators to `admissionMode: 'required'`. No posting
   without a current scorable admission.
3. Rechecking substrate at verdict time; any mismatch → `SkippableError`,
   never a misclassified FAIL.
4. New `validate-pool` flags (`--instance-id`, `--instances-file`,
   `--seed-positive`, `--known-bad`); `jinn doctor` reports pool freshness.

No SDK schema, contract, TEE, or on-chain verdict-code changes.

## Test plan

- [x] Full client test suite passes
- [x] typecheck zero errors
- [ ] Manual smoke on a workstation: doctor → validate-pool → daemon posts only admitted instances
- [ ] CHANGELOG entry calls out operator rollout step

## Related

Spike: `docs/superpowers/specs/2026-05-14-eval-substrate-spike.md`
DR: `log/decisions/2026-05-14-swe-rebench-eval-admission.md`
Closes: jinn-mono-b609, jinn-mono-xw6i, jinn-mono-y4ah
Still open: jinn-mono-fufn (closes on merge), jinn-mono-tptp (observability follow-up), jinn-mono-nf92 (cost-attribution adjacent)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

Coverage map back to the spike + plan agreement:

- Spike §4 (polarity) → **deferred** (per DR). Codex plan + Task 5 strengthen the classifier without flipping polarity.
- Spike §5.1 (pin upstream by digest) → Task 4 records `imageDigest` at validation; verdict-time recheck (Task 9) compares.
- Spike §5.2 (typed EvalSubstrate primitive) → **deferred** (per DR).
- Spike §5.3 (launcher admission smoke-test) → Tasks 4 + 7 (validate-pool flags) make `--seed-positive` the per-operator smoke-test.
- Spike §5.4 (drift sweep) → **deferred** as observability follow-up.
- Spike §5.5 (backfill reclassification) → **deferred** per DR.
- Spike §6 (launcher/solver/evaluator contract) → **partial**: launcher's role becomes "the validated-pool admission record"; no on-chain attestation.
- Spike §8 (upstream issues) → out-of-tree work, files outside this PR.
- Spike §9 (backfill / historical correctness) → **deferred** per DR.
- Spike §10 (property statement) → DR ratifies the v1 property.

Open items intentionally deferred — none are blocked by this plan:
- `jinn-mono-tptp` (per-verdict failureMode in explorer + historical backfill)
- `jinn-mono-nf92` (evaluator_cost_usd accounting)
- Future: typed `EvalSubstrate` on `SolverNetContract` if a second SolverType needs admission.
- Future: `Invalid(3)` emission if residual `SkippableError` rate climbs.
- Future: TEE-attested eval substrate (Phase 2 mainnet readiness).
