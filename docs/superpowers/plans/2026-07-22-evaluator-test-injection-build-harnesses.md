# Evaluator test-injection seam for `buildHarnesses()` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a test-only `HarnessEnv.testHarnessReplacements` seam so e2e/unit callers can displace a named in-repo harness (e.g. `swe-rebench-v2-evaluator`) inside `buildHarnesses()` and win first-match dispatch without Docker or config/`main.ts` wiring.

**Architecture:** After the normal in-repo / stub / external / learner list is built, and **before** `disabledNames` filtering, apply replace-by-canonical-name: each replacement removes the matching entry and inserts at that index. Non-empty replacements require `JINN_TEST_MODE === '1'` or throw (mirror `maybeCreateStubHarnessFromEnv`). Unknown names throw (no silent append). Prefer test-local fake `Harness` instances; do not add a production stub class or expose the field from config/`main.ts`.

**Tech Stack:** TypeScript, Vitest, existing `Harness` / `HarnessRegistry` / `canonicalHarnessName` APIs in `client/`.

**Design authority:** `docs/superpowers/specs/2026-07-22-evaluator-test-injection-build-harnesses-design.md` (Approach D). Issue #1642 (`test`).

## Global Constraints

- Issue Type `test` — seam unit/registry tests are the primary deliverable; marketplace e2e rewrite is out of scope.
- Never wire `testHarnessReplacements` from Zod config, `main.ts`, or operator-facing surfaces.
- Fail-closed: non-empty replacements + `JINN_TEST_MODE !== '1'` → throw before returning harnesses.
- Unknown replacement name → throw (no append).
- Composition order: build list → apply replacements → apply `disabledNames` filter last.
- Prefer inline / test-local fakes over a new production stub class under `client/src/harnesses/impls/`.
- Do not change `HarnessRegistry` dispatch semantics, restoration `StubHarness`, or `startDaemon.extraHarnesses`.
- Worktree stays detached; Stage 3 creates the local commit(s). Do not push / open / ready a PR from implement stages that lack that authority.
- American English identifiers and messages (`testHarnessReplacements`, not `testHarnessReplacments`).

## Acceptance criteria → tasks

| Criterion | Task |
|---|---|
| Test-only injection on `buildHarnesses`; stub wins first-match for `swe-rebench-v2.v1` + `evaluation` | Tasks 1–2 |
| Deterministic verdicts possible (stub instance identity / `supports`) without Docker | Task 1 displace + registry tests |
| Safety: cannot activate without `JINN_TEST_MODE=1` | Task 1 fail-closed |
| Minimum surface (no e2e rewrite, no config/`main.ts`) | Global constraints + verification Task 3 |
| Unknown name throws; omit/empty is no-op; composes with `disabledNames` | Task 1 |

## File map

| File | Responsibility |
|---|---|
| `client/src/harnesses/impls/index.ts` | Add `testHarnessReplacements?: readonly Harness[]` to `HarnessEnv`; apply replace + fail-closed inside `buildHarnesses` (helper ok if kept private in same file) |
| `client/test/harnesses/impls/build-harnesses.test.ts` | New `describe('buildHarnesses — testHarnessReplacements')` covering displace, registry first-match, fail-closed, unknown name, no-op, `disabledNames` compose |
| `docs/superpowers/specs/2026-07-22-evaluator-test-injection-build-harnesses-design.md` | Stage 1 design (already present, untracked) — **commit with implementation** (see Commit note) |
| `docs/superpowers/plans/2026-07-22-evaluator-test-injection-build-harnesses.md` | This plan — **commit with implementation** |

---

### Task 1: Failing tests for `testHarnessReplacements`

**Files:**
- Modify: `client/test/harnesses/impls/build-harnesses.test.ts`
- Test: same file (extend; do not create a separate helper file unless a second consumer appears)

**Interfaces:**
- Consumes: `buildHarnesses`, existing `ENV` / `makeFake` in the test file; `HarnessRegistry` from `client/src/harnesses/engine/registry.ts`; `canonicalHarnessName` only if needed for assertions.
- Produces: six failing specs that Stage 2 implementation must satisfy (see Step 1 code).

- [ ] **Step 1: Write the failing tests**

Extend imports and add a new describe block **after** the existing `buildHarnesses — external impls + disabledNames` suite. Keep existing tests untouched.

```ts
import { describe, it, expect } from 'vitest';
import { buildHarnesses } from '../../../src/harnesses/impls/index.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS } from '../../../src/harnesses/names.js';
import { HarnessRegistry } from '../../../src/harnesses/engine/registry.js';
import type { Harness } from '../../../src/harnesses/types.js';

// ... existing ENV + makeFake unchanged ...

function makeEvaluatorFake(name: string): Harness {
  return {
    name,
    version: '0.0.0-test',
    supports: (ctx: { solverType: string; role?: 'restoration' | 'evaluation' }) =>
      ctx.solverType === 'swe-rebench-v2.v1' && ctx.role === 'evaluation',
    isReady: async () => ({ ok: true }),
    async run() {
      throw new Error('test evaluator fake: run not used');
    },
  } as unknown as Harness;
}

describe('buildHarnesses — testHarnessReplacements', () => {
  it('displaces swe-rebench-v2-evaluator at the same index when JINN_TEST_MODE=1', () => {
    const saved = process.env['JINN_TEST_MODE'];
    try {
      process.env['JINN_TEST_MODE'] = '1';
      const baseline = buildHarnesses({ ...ENV });
      const idx = baseline.findIndex((h) => h.name === 'swe-rebench-v2-evaluator');
      expect(idx).toBeGreaterThanOrEqual(0);

      const fake = makeEvaluatorFake('swe-rebench-v2-evaluator');
      const replaced = buildHarnesses({
        ...ENV,
        testHarnessReplacements: [fake],
      });

      const matches = replaced.filter((h) => h.name === 'swe-rebench-v2-evaluator');
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(fake);
      expect(replaced[idx]).toBe(fake);
      expect(fake.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(true);
      expect(replaced.length).toBe(baseline.length);
    } finally {
      if (saved === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = saved;
    }
  });

  it('HarnessRegistry first-match picks the replacement for swe-rebench-v2 evaluation', () => {
    const saved = process.env['JINN_TEST_MODE'];
    try {
      process.env['JINN_TEST_MODE'] = '1';
      const fake = makeEvaluatorFake('swe-rebench-v2-evaluator');
      const list = buildHarnesses({
        ...ENV,
        testHarnessReplacements: [fake],
      });
      const registry = new HarnessRegistry({});
      for (const h of list) registry.register(h);
      expect(registry.findFor({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(fake);
    } finally {
      if (saved === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = saved;
    }
  });

  it('throws when replacements are non-empty and JINN_TEST_MODE is not "1"', () => {
    const saved = process.env['JINN_TEST_MODE'];
    try {
      delete process.env['JINN_TEST_MODE'];
      expect(() =>
        buildHarnesses({
          ...ENV,
          testHarnessReplacements: [makeEvaluatorFake('swe-rebench-v2-evaluator')],
        }),
      ).toThrow(/JINN_TEST_MODE/);

      process.env['JINN_TEST_MODE'] = 'true';
      expect(() =>
        buildHarnesses({
          ...ENV,
          testHarnessReplacements: [makeEvaluatorFake('swe-rebench-v2-evaluator')],
        }),
      ).toThrow(/JINN_TEST_MODE/);
    } finally {
      if (saved === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = saved;
    }
  });

  it('throws when a replacement name matches no in-repo harness', () => {
    const saved = process.env['JINN_TEST_MODE'];
    try {
      process.env['JINN_TEST_MODE'] = '1';
      expect(() =>
        buildHarnesses({
          ...ENV,
          testHarnessReplacements: [makeFake('@example/does-not-exist')],
        }),
      ).toThrow(/testHarnessReplacements/);
    } finally {
      if (saved === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = saved;
    }
  });

  it('omitting testHarnessReplacements leaves baseline names and length unchanged', () => {
    const a = buildHarnesses({ ...ENV });
    const b = buildHarnesses({ ...ENV, testHarnessReplacements: [] });
    expect(a.map((h) => h.name)).toEqual(b.map((h) => h.name));
    expect(a.length).toBe(b.length);
  });

  it('applies replacements before disabledNames (replaced stub can still be disabled)', () => {
    const saved = process.env['JINN_TEST_MODE'];
    try {
      process.env['JINN_TEST_MODE'] = '1';
      const fake = makeEvaluatorFake('swe-rebench-v2-evaluator');
      const list = buildHarnesses({
        ...ENV,
        testHarnessReplacements: [fake],
        disabledNames: ['swe-rebench-v2-evaluator'],
      });
      expect(list.some((h) => h.name === 'swe-rebench-v2-evaluator')).toBe(false);
      expect(list.includes(fake)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = saved;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail for the right reason**

```bash
cd client && yarn vitest run test/harnesses/impls/build-harnesses.test.ts
```

Expected: FAIL — TypeScript and/or runtime errors because `testHarnessReplacements` is not on `HarnessEnv` / not applied (e.g. excess property check under `tsc` in IDE, or tests that assert displace/throw do not see the new behavior). If Vitest runs without typecheck and excess property is ignored at runtime, displace assertions fail because the real `SweRebenchV2EvaluatorHarness` remains at the index and `matches[0]` is not `fake`; fail-closed / unknown-name tests fail because no throw occurs.

Do **not** implement yet.

- [ ] **Step 3: Commit is deferred** — Stage 3 batches tests + implementation into one commit (see Commit note). No commit in this task while red.

---

### Task 2: Implement `HarnessEnv.testHarnessReplacements` in `buildHarnesses`

**Files:**
- Modify: `client/src/harnesses/impls/index.ts` (`HarnessEnv` interface ~L35–118; `buildHarnesses` body ~L128–304)

**Interfaces:**
- Consumes: `canonicalHarnessName` (already imported).
- Produces:
  ```ts
  // on HarnessEnv
  /**
   * Test-only replacements keyed by harness identity: each entry displaces the
   * in-repo harness with the same canonical name (registration index preserved).
   * Fail-closed: if non-empty and JINN_TEST_MODE !== '1', buildHarnesses throws.
   * Never wire from operator config / main.ts.
   */
  testHarnessReplacements?: readonly Harness[];
  ```
  - Private helper (same file) applying replace-by-name; or inline block in `buildHarnesses` immediately before the `disabledNames` filter.

- [ ] **Step 1: Add the `HarnessEnv` field with JSDoc**

Insert after `disabledNames?: readonly string[];` (before hermes fields is fine; after `disabledNames` is clearest):

```ts
  /**
   * Test-only replacements keyed by harness identity: each entry displaces the
   * in-repo harness with the same canonical name (registration index preserved).
   * Fail-closed: if non-empty and `JINN_TEST_MODE !== '1'`, {@link buildHarnesses}
   * throws. Never wire from operator config / `main.ts`.
   */
  testHarnessReplacements?: readonly Harness[];
```

- [ ] **Step 2: Apply replacements before `disabledNames`**

Replace the tail of `buildHarnesses` so that after learners/hermes are pushed, replacements run, then the existing disable filter:

```ts
  // ... existing hermes push stays above ...

  applyTestHarnessReplacements(out, env.testHarnessReplacements);

  if (env.disabledNames && env.disabledNames.length > 0) {
    const disabled = canonicalHarnessNameSet(env.disabledNames);
    return out.filter((impl) => !disabled.has(canonicalHarnessName(impl.name)));
  }
  return out;
}

/**
 * Mutates `out` in place: each replacement removes the matching canonical name
 * and inserts at that index. Empty / omitted → no-op. Non-empty without
 * JINN_TEST_MODE=1 → throw. Unknown name → throw.
 */
function applyTestHarnessReplacements(
  out: Harness[],
  replacements: readonly Harness[] | undefined,
): void {
  if (!replacements || replacements.length === 0) return;

  if (process.env['JINN_TEST_MODE'] !== '1') {
    throw new Error(
      'testHarnessReplacements must never activate in a real operator run: ' +
        'replacements were supplied but JINN_TEST_MODE is not "1". ' +
        'Set JINN_TEST_MODE=1 for in-process tests / e2e; otherwise omit testHarnessReplacements.',
    );
  }

  for (const replacement of replacements) {
    const target = canonicalHarnessName(replacement.name);
    const idx = out.findIndex((h) => canonicalHarnessName(h.name) === target);
    if (idx < 0) {
      throw new Error(
        `testHarnessReplacements: no in-repo harness named "${replacement.name}" ` +
          `(canonical: "${target}"). Refusing to append — replacement must displace an existing name.`,
      );
    }
    out.splice(idx, 1, replacement);
  }
}
```

Keep the helper **file-private** (not exported) unless a second module needs it.

- [ ] **Step 3: Run the focused suite — expect PASS**

```bash
cd client && yarn vitest run test/harnesses/impls/build-harnesses.test.ts
```

Expected: all tests in the file PASS (existing external/disabled suite + new `testHarnessReplacements` describe).

- [ ] **Step 4: Confirm `main.ts` / config untouched**

```bash
cd /path/to/worktree && git diff --name-only -- client/src/main.ts client/src/config.ts
```

Expected: empty (no diffs). If anything appears, revert those files — the field must stay call-site-only for tests/helpers.

---

### Task 3: Verification + local commit

**Files:**
- Verify only (plus docs already listed in File map)

**Interfaces:** none new.

- [ ] **Step 1: Scoped vitest (repeat)**

```bash
cd client && yarn vitest run test/harnesses/impls/build-harnesses.test.ts
```

Expected: PASS.

- [ ] **Step 2: Typecheck**

Prefer the lighter client typecheck if full `yarn typecheck` is too heavy in the attempt environment; full is authoritative:

```bash
cd client && yarn typecheck
```

If the attempt environment cannot complete the nested package builds, at minimum:

```bash
cd client && yarn tsc --noEmit
```

(only after SDK/plugin/core are already built in that worktree). Expected: zero errors; `HarnessEnv` consumers that do not pass `testHarnessReplacements` remain valid.

- [ ] **Step 3: Diff hygiene**

```bash
git diff --check
git diff --stat -- client/src/harnesses/impls/index.ts client/test/harnesses/impls/build-harnesses.test.ts
```

Expected: only the seam + tests (plus optional design/plan docs below). No marketplace e2e, no `main.ts`, no new env stub class.

- [ ] **Step 4: Local commit (Stage 3 only)**

**Recommendation — include Stage 1 design + this plan** with the implementation. They are the approved authority capsule for Approach D and cost almost nothing in review surface; leaving them untracked risks losing the decision trail in the attempt worktree. Stage 3 may drop them for minimum surface if the coordinator prefers code-only — default is **keep and commit**.

Suggested message (Conventional Commits, shape `test`):

```bash
git add \
  client/src/harnesses/impls/index.ts \
  client/test/harnesses/impls/build-harnesses.test.ts \
  docs/superpowers/specs/2026-07-22-evaluator-test-injection-build-harnesses-design.md \
  docs/superpowers/plans/2026-07-22-evaluator-test-injection-build-harnesses.md

git commit -m "$(cat <<'EOF'
test(harnesses): add testHarnessReplacements seam to buildHarnesses

Allow in-process tests to displace named in-repo harnesses (e.g. swe-rebench-v2-evaluator) under JINN_TEST_MODE=1 so first-match evaluation can use deterministic stubs without Docker or config wiring.

Closes #1642
EOF
)"
```

Do not push; do not create/ready a PR from this stage unless Autopilot session protocol owns that lifecycle.

---

## Out of scope (do not do in this plan)

- Rewriting `client/test/e2e/task-creator-marketplace.ts` / `submitSelfEvaluation` bypass.
- Extending `startDaemon.extraHarnesses`.
- New `EvaluatorStubHarness` / env vars (`JINN_EVALUATOR_STUB*`).
- `_testDeps` passthrough or Docker readiness bypass on the real evaluator.
- Config / Zod / `main.ts` exposure of `testHarnessReplacements`.
- Changing `HarnessRegistry` first-match rules.

## Self-review checklist

1. **Spec coverage:** Design §1–§6 criteria map to Tasks 1–3; §7 follow-on explicitly out of scope.
2. **Placeholders:** None — tests and helper code are copy-pasteable.
3. **Type consistency:** Field name is `testHarnessReplacements`; gate is `JINN_TEST_MODE === '1'`; order is replace-then-`disabledNames`; unknown names throw with `testHarnessReplacements` in the message.

## Commit note (Stage 1 design markdown)

**Recommend committing** `docs/superpowers/specs/2026-07-22-evaluator-test-injection-build-harnesses-design.md` together with this plan and the code change. Rationale: documents the rejected approaches (A–C, E) and the fail-closed / unknown-name decisions reviewers will ask about; already exists in the attempt worktree. Alternative (leave untracked for minimum PR surface) is acceptable only if Stage 3 explicitly wants code-only — default keep.
