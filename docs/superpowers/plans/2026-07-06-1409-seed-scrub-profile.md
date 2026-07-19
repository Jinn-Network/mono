# Seed-Profile Scrub (Issue #1409) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Correction / supersession (2026-07-19, #1784):** This historical plan
> repeatedly says `ScrubPipeline.components` is published in a provenance or
> scrub-component manifest. The implemented `TraceEnvelopeV0` contract does not
> carry that list or otherwise prove the selected scrub profile.
> `ScrubPipeline.components` is a local diagnostics-and-test contract. Imported
> provenance, importer identity, the `seed-import` tag, and `seed:*` steps
> disclose seed origin on the wire, not the profile that ran. The seed profile
> is also used for public, transformed, human-curated evidence episodes, not
> only licence-checked `SKILL.md` inputs; reviewing residual classes omitted by
> the reduced profile remains the local curator's responsibility. Those
> corrections supersede the contrary claims below without rewriting the
> execution record.

**Goal:** Seeded corpus SKILL.md content publishes byte-identical prose (no false-positive `[SECRET:…]` placeholders) while genuine secrets in seeds still redact.

**Architecture:** Add a seed-profile scrub pipeline (`buildSeedScrubPipeline()`) that keeps the deterministic detectors (key policy, plain-patterns email/home-path regexes, secretlint preset rules) and drops the two probabilistic stages (openredaction, secretlint pass-2 entropy fallback). The entropy fallback is gated by a new additive `{ entropyFallback?: boolean }` option on `secretlintStage` (default `true` — trace-side behaviour byte-identical). Seed import (`execute()`) passes the seed pipeline via the pre-existing `CaptureOptions.pipeline` injection point; capture stays mandatory and fail-closed, `publish()` untouched, provenance manifest records the reduced stage list via `ScrubPipeline.components`.

**Tech Stack:** TypeScript, vitest, secretlint (`@secretlint/core` + preset-recommend). Worktree `/Users/gcd/Repositories/main/jinn-mono_worktrees/1409`, branch `fix/1409-seed-scrub-defacement`, PR targets `next`.

## Global Constraints

- Shape is `fix` (workflow rule 7): regression test first — watch it fail before implementing.
- Trace-pipeline behaviour must not change: default `buildScrubPipeline()` composition and default `secretlintStage` behaviour stay byte-identical; existing seeded-secrets fixture suite (`client/packages/harness-layer/test/capture.test.ts`) passes untouched.
- No changes to `publish()`, the no-bypass gate, or the fail-closed `CaptureScrubError` posture.
- harness-layer imports client scrub code by **relative path** (see `client/packages/harness-layer/src/capture.ts:32` — `../../../src/trajectory/scrub/build.js`). From `src/seed-import/execute.ts` the same module is `../../../../src/trajectory/scrub/build.js` (one directory deeper). There is no workspace-dep import for scrub code — do not invent one.
- Do NOT bump `secretlint-stage.ts`'s `VERSION` ('0.4.0') and do not rename the stage: the default path is behaviourally identical, and the seed profile is identified in provenance by its **reduced components list** (no `openredaction`, no `ml-pii`), not by a stage version.
- Do NOT build consume-side dedupe for old defaced envelopes (explicitly out of scope; discovery orders `anchorBlock desc` so re-imported clean versions surface first).
- All commands below run from `/Users/gcd/Repositories/main/jinn-mono_worktrees/1409/client` unless stated otherwise. `yarn test` / `yarn typecheck` both run `build:sdk` first — that prefix step is expected and slow; targeted runs use `yarn build:sdk && yarn vitest run <file>` once, then `yarn vitest run <file>` thereafter.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `entropyFallback` option on `secretlintStage`

**Files:**
- Modify: `client/src/trajectory/scrub/secretlint-stage.ts` (signature at line 217; pass-2 sweep at lines 247–256)
- Test: `client/test/trajectory/scrub/secretlint-stage.test.ts`

**Interfaces:**
- Consumes: existing `secretlintStage(policy: KeyPolicy): ScrubStage` and the pass-2 `\S+` entropy sweep.
- Produces: `secretlintStage(policy: KeyPolicy, opts?: { entropyFallback?: boolean }): ScrubStage`. `entropyFallback` defaults to `true` (unchanged behaviour); `false` skips ONLY the pass-2 entropy sweep — pass-1 secretlint preset rules always run. Task 2 depends on this exact signature.

- [ ] **Step 1: Write the failing tests**

Append to `client/test/trajectory/scrub/secretlint-stage.test.ts` (inside the existing `describe('secretlintStage', …)`; `policy` and `GH` constants already exist at the top of the file):

```typescript
  // #1409: seed-profile scrub disables the probabilistic pass-2 entropy sweep.
  // The three observed seed false positives (env-var assignment with a dated
  // slug; ≥20-char camelCase identifiers) must survive byte-identical when the
  // fallback is off, while pass-1 rule-based detection still fires.
  describe('entropyFallback option (#1409)', () => {
    const seedProse = [
      'Run export PLAN_ID=2026-01-10-backend-refactor before starting.',
      'Set PublicNetworkAccessDisabled on the storage account.',
      'Check IPv4StandardSkuPublicIpAddresses quota first.',
    ].join('\n');

    test('entropyFallback: false leaves the observed seed FP shapes byte-identical', async () => {
      const stage = secretlintStage(policy, { entropyFallback: false });
      const result = await stage.scrub({ 'skill.md': seedProse });
      expect(result.attributes['skill.md']).toBe(seedProse);
      expect(result.redactions).toEqual([]);
    });

    test('entropyFallback: false still redacts rule-detected secrets (pass 1 intact)', async () => {
      const stage = secretlintStage(policy, { entropyFallback: false });
      const result = await stage.scrub({ 'skill.md': `token is ${GH} ok` });
      expect(result.attributes['skill.md']).not.toContain(GH);
      expect(result.attributes['skill.md']).toContain('[SECRET:');
      expect(result.redactions.some((r) => r.kind === 'secret')).toBe(true);
    });

    test('entropyFallback defaults ON — omitted option keeps sweeping high-entropy blobs', async () => {
      const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';
      const stage = secretlintStage(policy);
      const result = await stage.scrub({ 'tool.output': `value ${blob} end` });
      expect(result.attributes['tool.output']).not.toContain(blob);
      expect(result.redactions.some((r) => r.detail === 'high-entropy')).toBe(true);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn build:sdk && yarn vitest run test/trajectory/scrub/secretlint-stage.test.ts`

Expected: the two `entropyFallback: false` tests FAIL — TypeScript/vitest complains the second argument is unexpected, or (if TS is lenient at runtime) the first test fails because `export PLAN_ID=2026-01-10-backend-refactor` comes back as `export [SECRET:high-entropy]`. The `defaults ON` test PASSES (it pins current behaviour).

- [ ] **Step 3: Implement the option**

In `client/src/trajectory/scrub/secretlint-stage.ts`, change the exported function (line 217) and gate pass 2 (lines 247–256):

```typescript
export interface SecretlintStageOptions {
  /**
   * Gate for the pass-2 Shannon-entropy fallback (#1409). Default true (trace
   * profile, unchanged). The seed-import profile sets false: SKILL.md bodies
   * are public licence-checked prose where the probabilistic sweep demonstrably
   * false-positives (env-var assignments with dated slugs, ≥20-char camelCase
   * identifiers) — pass-1 deterministic rules still run unconditionally.
   */
  entropyFallback?: boolean;
}

export function secretlintStage(
  policy: KeyPolicy,
  opts: SecretlintStageOptions = {},
): ScrubStage {
  const entropyFallback = opts.entropyFallback ?? true;
  const config = { rules: [{ id: PRESET_RULE_ID, rule: creator }] };
  // …
```

and wrap ONLY the pass-2 block:

```typescript
        // Pass 2 — entropy + secret-shape fallback on whatever survived.
        // Wrapping punctuation is preserved around the placeholder (#1378).
        // Skipped entirely under the seed profile (#1409).
        if (entropyFallback) {
          text = text.replace(/\S+/g, (token) => {
            const [, lead = '', core = token, trail = ''] = TOKEN_WRAPPING.exec(token) ?? [];
            if (isSecretShapedToken(core)) {
              redactions.push({ key, stage: 'secretlint', kind: 'secret', detail: 'high-entropy' });
              return `${lead}[SECRET:high-entropy]${trail}`;
            }
            return token;
          });
        }
```

Nothing else in the file changes — `VERSION` stays `'0.4.0'`, pass 1 stays unconditional.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn vitest run test/trajectory/scrub/secretlint-stage.test.ts`

Expected: ALL tests in the file PASS — the three new ones plus every pre-existing entropy-fallback test (which all use the default, still-on path).

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/scrub/secretlint-stage.ts client/test/trajectory/scrub/secretlint-stage.test.ts
git commit -m "fix(scrub): add entropyFallback gate to secretlintStage (#1409)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `buildSeedScrubPipeline()` — the seed-profile composition

**Files:**
- Modify: `client/src/trajectory/scrub/build.ts` (append after `buildScrubPipeline`, lines 44–58)
- Test: Create `client/test/trajectory/scrub/build.test.ts`

**Interfaces:**
- Consumes: `secretlintStage(policy, { entropyFallback: false })` from Task 1; existing `keyPolicyStage`, `plainPatternsStage`, `ScrubPipeline`, `DEFAULT_KEY_POLICY` (all already imported in `build.ts`).
- Produces: `buildSeedScrubPipeline(policy?: KeyPolicy): ScrubPipeline` composing exactly `keyPolicyStage → plainPatternsStage → secretlintStage(policy, { entropyFallback: false })`. `ScrubPipeline.components` therefore lists `key-policy`, `plain-patterns`, `secretlint` — the reduced list the provenance manifest records. Task 3 imports this function.

- [ ] **Step 1: Write the failing test**

Create `client/test/trajectory/scrub/build.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import {
  buildScrubPipeline,
  buildSeedScrubPipeline,
} from '../../../src/trajectory/scrub/build.js';

describe('pipeline builders (#1409)', () => {
  // Trace-side no-regression pin: the default composition is unchanged.
  test('default buildScrubPipeline composition is key-policy → openredaction → plain-patterns → secretlint', () => {
    const names = buildScrubPipeline().components.map((c) => c.name);
    expect(names).toEqual(['key-policy', 'openredaction', 'plain-patterns', 'secretlint']);
  });

  test('seed pipeline drops the probabilistic stages: key-policy → plain-patterns → secretlint', () => {
    const names = buildSeedScrubPipeline().components.map((c) => c.name);
    expect(names).toEqual(['key-policy', 'plain-patterns', 'secretlint']);
  });

  test('seed pipeline keeps deterministic redaction (email) and skips entropy sweep', async () => {
    const pipeline = buildSeedScrubPipeline();
    const result = await pipeline.run({
      'skill.md': 'Contact alice@example.com about PublicNetworkAccessDisabled quota.',
    });
    const text = String(result.attributes['skill.md']);
    expect(text).not.toContain('alice@example.com'); // plain-patterns still fires
    expect(text).toContain('PublicNetworkAccessDisabled'); // entropy fallback off
  });
});
```

Stage names verified against source at plan time: `key-policy` (`key-policy.ts:38`), `openredaction` (`openredaction-stage.ts:260`), `plain-patterns` (`plain-patterns-stage.ts:36`), `secretlint` (`secretlint-stage.ts:221`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run test/trajectory/scrub/build.test.ts`

Expected: FAIL — `buildSeedScrubPipeline` is not exported from `build.js`. The first (default-composition) test PASSES.

- [ ] **Step 3: Implement `buildSeedScrubPipeline`**

Append to `client/src/trajectory/scrub/build.ts` (after `buildScrubPipeline`, using imports already present at the top of the file):

```typescript
/**
 * Seed-profile scrub pipeline (#1409). Seeds are public, licence-checked
 * SKILL.md content — not operator trace data — so the probabilistic stages
 * (openredaction, secretlint's pass-2 entropy fallback, ML PII) that exist to
 * catch unknown-shape PII/secrets in private traces are dropped: on prose they
 * false-positive (trigger words, dated env-var slugs, long camelCase
 * identifiers) and deface the corpus. The deterministic detectors stay:
 * structural key policy, plain-patterns (emails, home paths), and secretlint's
 * pass-1 preset rules (AWS / GitHub / Slack / GCP / npm key shapes). The
 * reduced stage list is what the provenance manifest records for seed
 * envelopes, so the profile is auditable per envelope.
 */
export function buildSeedScrubPipeline(policy: KeyPolicy = DEFAULT_KEY_POLICY): ScrubPipeline {
  return new ScrubPipeline([
    keyPolicyStage(policy),
    plainPatternsStage(policy),
    secretlintStage(policy, { entropyFallback: false }),
  ]);
}
```

(`KeyPolicy` is imported as a type in `build.ts` via `key-policy.js` — it already is, line 2.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest run test/trajectory/scrub/build.test.ts`

Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/trajectory/scrub/build.ts client/test/trajectory/scrub/build.test.ts
git commit -m "fix(scrub): add buildSeedScrubPipeline seed-profile composition (#1409)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire seed import to the seed pipeline (the regression fix)

**Files:**
- Modify: `client/packages/harness-layer/src/seed-import/execute.ts` (import block lines 20–25; the `capture(...)` call at line 141)
- Modify: `client/packages/harness-layer/src/capture.ts` (doc comment on `CaptureOptions.pipeline`, line 153)
- Test: `client/packages/harness-layer/test/seed-import.test.ts`

**Interfaces:**
- Consumes: `buildSeedScrubPipeline()` from Task 2, imported by relative path `../../../../src/trajectory/scrub/build.js`; existing `CaptureOptions.pipeline` injection point in `capture()` (`client/packages/harness-layer/src/capture.ts:296` — `opts.pipeline ?? buildScrubPipeline(...)`).
- Produces: seed publishes run `capture(task, { pipeline: buildSeedScrubPipeline() })`. No signature changes; nothing downstream consumes anything new.

- [ ] **Step 1: Write the failing regression tests**

Append a new `describe` block to `client/packages/harness-layer/test/seed-import.test.ts`. Reuse the file's existing helpers: `skill()`, `mockSource()`, `mockPublishDeps()`, `parseTraceEnvelopeV0` (envelope payload is `published[0]!.payload`, pattern at existing lines 155–162), and `execute` / `ImportReport` imports (already present).

```typescript
// ── Seed-profile scrub (#1409) — regression: seeds anchored but defaced ─────

describe('execute() seed-profile scrub (#1409)', () => {
  // The three observed entropy-fallback false positives plus the openredaction
  // trigger-word shapes (#1372/#1391) in one synthetic SKILL.md. AC1: the
  // published envelope carries this byte-identical.
  const SEED_SKILL_MD = [
    '---',
    'name: backend-refactor-helper',
    'license: MIT',
    '---',
    '# backend-refactor-helper',
    '',
    'Use this skill before touching the backend. It reads user intent first.',
    '',
    'Run export PLAN_ID=2026-01-10-backend-refactor to pin the plan.',
    'Set PublicNetworkAccessDisabled on the account.',
    'Check the IPv4StandardSkuPublicIpAddresses quota.',
  ].join('\n');

  const report: ImportReport = [
    {
      skill: 'acme/skills/backend-refactor-helper',
      source: 'https://github.com/acme/skills',
      licence: 'MIT',
      verdict: 'import',
      reason: 'licence MIT is allowlisted',
    },
  ];

  it('publishes seed SKILL.md prose byte-identical — no placeholder substitution (AC1)', async () => {
    const source = mockSource([
      skill({ skill: 'acme/skills/backend-refactor-helper', skillMd: SEED_SKILL_MD }),
    ]);
    const { deps, published } = mockPublishDeps();
    const result = await execute(report, source, deps);

    expect(result.errors).toEqual([]);
    expect(result.imported).toHaveLength(1);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
    const attrs = envelope.steps[0]!.attributes as Record<string, unknown>;
    expect(attrs['skill.md']).toBe(SEED_SKILL_MD);
  });

  it('still redacts a genuine secret in a seed — GitHub PAT and email (AC2)', async () => {
    const pat = 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012';
    const leaky = `# leaky\n\nUse token ${pat} and mail alice@example.com.`;
    const leakyReport: ImportReport = [
      {
        skill: 'acme/skills/leaky',
        source: 'https://github.com/acme/skills',
        licence: 'MIT',
        verdict: 'import',
        reason: 'licence MIT is allowlisted',
      },
    ];
    const source = mockSource([skill({ skill: 'acme/skills/leaky', skillMd: leaky })]);
    const { deps, published } = mockPublishDeps();
    const result = await execute(leakyReport, source, deps);

    expect(result.errors).toEqual([]);
    const envelope = parseTraceEnvelopeV0(published[0]!.payload);
    const text = String((envelope.steps[0]!.attributes as Record<string, unknown>)['skill.md']);
    expect(text).not.toContain(pat);
    expect(text).not.toContain('alice@example.com');
    expect(text).toContain('[SECRET:');
  });
});
```

Row shape verified at plan time against `ImportReportRowSchema` (`client/packages/harness-layer/src/seed-import/report.ts:11-17` — strictObject with exactly `skill/source/licence/verdict/reason`). If `mockPublishDeps().published` captures more than one artifact per publish, select the trace-envelope payload the way the existing provenance test at line ~155 does.

- [ ] **Step 2: Run the tests to verify the AC1 test fails**

Run: `yarn vitest run packages/harness-layer/test/seed-import.test.ts`

Expected: the AC1 test FAILS with a string diff showing `export [SECRET:high-entropy]` (and `[SECRET:high-entropy]` for the two camelCase identifiers) in place of the original tokens — this is the bug, reproduced. The AC2 test may already pass (pass-1 rules and plain-patterns fire on the default pipeline too); that is fine — it pins no-regression. All pre-existing tests in the file still pass.

- [ ] **Step 3: Wire the seed pipeline into `execute()`**

In `client/packages/harness-layer/src/seed-import/execute.ts`:

Add the import (note four `../` — execute.ts sits one level below capture.ts):

```typescript
import { buildSeedScrubPipeline } from '../../../../src/trajectory/scrub/build.js';
```

Change line 141 from:

```typescript
      const pending = await capture(toCapturedTask(skill, now));
```

to:

```typescript
      // Seed profile (#1409): deterministic secret detectors only. Seeds are
      // public licence-checked prose, not operator trace data — the
      // probabilistic stages false-positive on SKILL.md content and defaced
      // the anchored corpus. Capture stays mandatory and fail-closed.
      const pending = await capture(toCapturedTask(skill, now), {
        pipeline: buildSeedScrubPipeline(),
      });
```

In `client/packages/harness-layer/src/capture.ts` line 153, update the doc comment only:

```typescript
  /**
   * Injectable base pipeline. Production consumer: seed import passes
   * buildSeedScrubPipeline() (#1409); also used by tests. Overrides
   * policy/piiDetector.
   */
  pipeline?: ScrubPipeline;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn vitest run packages/harness-layer/test/seed-import.test.ts packages/harness-layer/test/capture.test.ts`

Expected: PASS — both new #1409 tests, every pre-existing seed-import test, and the untouched seeded-secrets fixture suite in `capture.test.ts` (trace path unchanged).

- [ ] **Step 5: Typecheck the package**

Run: `yarn typecheck:harness-layer`

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add client/packages/harness-layer/src/seed-import/execute.ts client/packages/harness-layer/src/capture.ts client/packages/harness-layer/test/seed-import.test.ts
git commit -m "fix(seed-import): scrub seeds with deterministic-only seed profile (#1409)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Spec note, full verification, PR with AC3 operational checklist

**Files:**
- Modify: `spec/2026-07-02-jinn-harness-network.md` (§7, lines 212–219 — the `Anchoring` bullet at line 219)

**Interfaces:**
- Consumes: nothing new — documentation + verification of Tasks 1–3.
- Produces: the PR. AC3's deliverable is code-enables-clean-re-import plus the documented post-merge operational step (below); no consume-side code.

- [ ] **Step 1: Update spec §7**

In `spec/2026-07-02-jinn-harness-network.md`, change the `Anchoring` bullet (line 219) from:

```markdown
- **Anchoring:** same path as contributions (scrub → IPFS → ERC-8004), no new chain surface.
```

to:

```markdown
- **Anchoring:** same path as contributions (scrub → IPFS → ERC-8004), no new chain surface. Seeds
  run the seed-profile scrub (deterministic secret patterns only — key policy, plain-patterns,
  secretlint preset rules; no probabilistic openredaction/entropy stages) because they are public,
  licence-checked content, not operator trace data (#1409).
```

- [ ] **Step 2: Full verification**

Run, from `/Users/gcd/Repositories/main/jinn-mono_worktrees/1409/client`:

```bash
yarn typecheck   # build:sdk + tsc --noEmit + typecheck:harness-layer — expect zero errors
yarn test        # full vitest suite — expect all pass, including all pre-existing scrub tests
```

Expected: zero typecheck errors; full suite green. If any pre-existing scrub or capture test fails, the default path regressed — stop and fix before proceeding (Global Constraint: trace-side byte-identical).

- [ ] **Step 3: Commit and open the PR**

```bash
git add spec/2026-07-02-jinn-harness-network.md
git commit -m "docs(spec): note seed-profile scrub in harness-network §7 (#1409)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin fix/1409-seed-scrub-defacement
```

Open the PR against `next` (workflow rule 10), title `fix(seed-import): seed-profile scrub — stop defacing seeded SKILL.md content (#1409)`. The PR body MUST include this post-merge operational checklist (this is the AC3 deliverable — old envelopes are content-addressed IPFS + append-only ERC-8004 and cannot be unpublished; re-import anchors new CIDs that discovery's `anchorBlock desc` ordering surfaces first):

```markdown
## Post-merge operational step (AC3)

- [ ] Re-run the approved seed import against testnet: `seed plan` → human review of the
      report → `seed execute` (Oak-gated, same as the original import).
- [ ] Verify during re-import: for the `brainstorming` seed and the three previously-defaced
      seeds (planning-with-files, the two azure-skills), `corpus get <new-seed-ref>` returns
      SKILL.md with zero `[SECRET:` placeholders.
- [ ] Verify a corpus search that previously surfaced a defaced seed now returns the new
      (higher anchorBlock) version first.
- [ ] Do NOT build consume-side dedupe of the old envelopes — out of scope per the design
      note; revisit only if the old versions demonstrably keep surfacing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## AC → Task mapping

| Acceptance criterion | Task(s) | Pinned by |
|---|---|---|
| AC1 — re-imported seed SKILL.md has no placeholder tokens on ordinary words; reads as plain English | 1, 2, 3 | Task 3 Step 1 test `publishes seed SKILL.md prose byte-identical` (fails on current HEAD, passes after wiring); Task 1 + Task 2 unit tests on the option and composition |
| AC2 — a seed containing a genuine secret still redacts (no protection regression) | 1, 3 | Task 1 test `entropyFallback: false still redacts rule-detected secrets`; Task 3 test `still redacts a genuine secret in a seed` (GitHub PAT + email) |
| AC3 — live testnet corpus serves clean seed content | 3, 4 | Code: clean re-import enabled (Task 3). Operational: PR-body post-merge checklist (Task 4 Step 3) — re-run `seed plan`/`seed execute`, verify `corpus get` on the new refs, newest-first discovery ordering surfaces clean versions |
| No trace-pipeline regression (implicit — issue is a `fix` on a shared scrub stack) | 1, 2, 3 | Task 1 `defaults ON` test; Task 2 default-composition pin; Task 3 Step 4 runs `capture.test.ts` seeded-secrets fixture untouched; Task 4 full `yarn test` |

## Self-review notes

- Every design-note point has a task: secretlintStage option (Task 1), buildSeedScrubPipeline (Task 2), execute.ts wiring + CaptureOptions comment (Task 3), spec §7 line (Task 4), AC3 split (Task 4 PR body), all three named regression tests (Tasks 1–3).
- Deliberate deviations from the design note, with reasons: (a) no `VERSION` bump on secretlint-stage — default behaviour is byte-identical and the reduced components list already identifies the seed profile in provenance; (b) the seed-composition unit test lives in a new `build.test.ts` rather than the pipeline suite — no builder test file existed, and it pins the default composition too.
- Signature consistency: `secretlintStage(policy, { entropyFallback: false })` (Task 1) is exactly what Task 2 calls; `buildSeedScrubPipeline()` (Task 2) is exactly what Task 3 imports; import depth `../../../../` verified against capture.ts's `../../../` precedent one directory shallower.
- All asserted internals (stage names, ImportReport row shape, `CaptureOptions.pipeline` injection point, relative-import depth, envelope-payload test pattern) were read from source during planning — no unverified assumptions remain.
