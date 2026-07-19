# Episode Seed Lane Scrub-Profile Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the evidence-episode seed lane (`client/packages/harness-layer/src/seed-import/episode-execute.ts`) scrub at the seed profile (`buildSeedScrubPipeline()`) instead of the strict trace profile (`buildScrubPipeline()`), matching plan §4.4 / `spec/2026-07-02-jinn-harness-network.md` §7, so the checked-in `distractor-operator-claims.episode.json` fixture stops false-positive-blocking on the word "claims" and hex SHAs, while real secret patterns are still refused.

**Architecture:** One-line pipeline swap in `episode-execute.ts` (the single `episodeScrubPipeline` variable already feeds both scrub sites: the pre-publish check over `episodePrivacyAttributes()` and the `capture()` call), a rewritten adjacent comment citing the correct rationale, a new fixture-set regression test that must fail before the fix and pass after, and a rework of the existing sensitive-canary tests in `seed-import-episodes.test.ts` so they exercise detectors the seed profile actually runs (deterministic key policy + plain-patterns + secretlint pass-1). The test and operator documentation also make the privacy trade-off explicit: every structured identifier or PII class detected only by the omitted 570+ pattern openredaction stage becomes curator-review residual, while listed medical, identity, financial, payment, and contact cases are representative rather than exhaustive. This follows TDD ordering (regression test before the fix, `fix` shape SOP: `systematic-debugging` → `executing-plans` → `verification-before-completion` → `receiving-code-review`).

**Tech Stack:** TypeScript, Vitest, the existing `client/src/trajectory/scrub/*` pipeline stages.

## Global Constraints

- American English spellings in all new/edited identifiers, comments, and copy (CLAUDE.md Rule 5) — e.g. `distributionTags`, not a British variant; this file's prose uses American English throughout.
- Touch only what the fix requires — no refactor of `episode-execute.ts` beyond the pipeline swap and the one comment block (CLAUDE.md Coding Rule 3, Surgical Changes).
- Regression test first, per the `fix` shape SOP (CLAUDE.md Engineering handbook, Work shape `fix`).
- No behavior change beyond the scrub profile: refuse-on-any-redaction stays; idempotency, supersedes, ledger/state-warning handling, CLI wiring are untouched.
- Every new/edited test must be independently runnable via the exact `yarn` commands given in each task (no invented scripts).

---

### Task 1: Pin the fixture set with a lane-level regression test (must fail against today's code)

**Files:**
- Modify: `client/packages/harness-layer/test/seed-import-episodes.test.ts`

**Interfaces:**
- Consumes: `createLocalEpisodeSeedSource` and `parseSeedEpisode` (already imported in this file, from `../src/seed-import/episode-fetch.js`); `planEpisodes` (already imported, from `../src/seed-import/episode-plan.js`); `executeEpisodes` (already imported, from `../src/seed-import/episode-execute.js`); `mockPublishDeps()` (already defined in this file, returns `{ deps, published, envelopes }`).
- Produces: nothing new for later tasks — this is the final regression gate for Task 2/3's fix.

The three checked-in evidence-episode fixtures live at
`client/packages/harness-layer/fixtures/stage1-seeds/{distractor-operator-claims,distractor-sympy-printing,source-dashboard-flake}.episode.json`.
Today, `distractor-operator-claims.episode.json` is rejected at execute time
because it runs through `buildScrubPipeline()` (the strict trace profile),
which false-positives on the word "claims" (`taskSummary`, `tags`) and on
hex-looking SHAs (`baseCommit: "c041cc4c..."`, the `sourceUrl` commit hash)
via the `openredaction` stage. The other two fixtures pass under either
profile (verified empirically in Stage 1).

This test drives `executeEpisodes()` — the lane's own entry point, not the
pipeline directly — over all three fixtures loaded via
`createLocalEpisodeSeedSource(FIXTURES_DIR)`, and asserts a clean import
(zero errors, three imported rows, zero skipped-as-error). It must FAIL
against the current `buildScrubPipeline()` wiring (real assertion:
`distractor-operator-claims` lands in `result.errors`, not `result.imported`)
and PASS once Task 2 swaps in `buildSeedScrubPipeline()`.

- [ ] **Step 1: Add the fixtures-dir constant and import `createLocalEpisodeSeedSource`**

This file already imports `createLocalEpisodeSeedSource` (see line 20 of the
current file). Add the shared fixtures-dir resolution used by
`stage1-seeds-fixtures.test.ts` (same pattern, new file-URL relative path
since this test lives one directory shallower):

```ts
import { fileURLToPath } from 'node:url';
```

Add near the top of the file, after the existing top-level constants
(`TEST_ADDRESS`, `TEST_PRIVATE_KEY`, `TEST_SAFE`):

```ts
const STAGE1_FIXTURES_DIR = fileURLToPath(
  new URL('../fixtures/stage1-seeds', import.meta.url),
);
```

- [ ] **Step 2: Write the failing regression test**

Add a new top-level `describe` block, after the existing
`describe('executeEpisodes()', ...)` block and before
`describe('jinn-layer seed CLI — episodes', ...)`:

```ts
describe('executeEpisodes() against the checked-in stage1-seeds fixture set (issue #1784)', () => {
  it('imports all three fixture episodes cleanly under the seed-lane scrub profile', async () => {
    const source = createLocalEpisodeSeedSource(STAGE1_FIXTURES_DIR);
    const report = await planEpisodes(source);
    expect(report.every((row) => row.verdict === 'import')).toBe(true);

    const { deps, published } = mockPublishDeps();
    const result = await executeEpisodes(report, source, deps);

    expect(result.errors).toEqual([]);
    expect(result.imported.map((r) => r.id).sort()).toEqual([
      'distractor-operator-claims',
      'distractor-sympy-printing',
      'source-dashboard-flake',
    ]);
    expect(result.skipped).toEqual([]);
    expect(published).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails against today's code**

Run: `cd client && yarn vitest run packages/harness-layer/test/seed-import-episodes.test.ts -t "imports all three fixture episodes cleanly"`

Expected: FAIL. The assertion `expect(result.errors).toEqual([])` fails
because `result.errors` contains an entry for `distractor-operator-claims`
with a message matching
`sensitive content detected (openredaction:HEALTH_INSURANCE_CLAIM, openredaction:CATALOG_NUMBER); refusing to publish evidence episode distractor-operator-claims`
(or the equivalent detector-name set — the exact detector labels are
whatever `buildScrubPipeline()`'s `openredactionStage` reports; the point of
this step is confirming the test fails for the *documented* reason, not
matching the exact string). Do not proceed to Task 2 until this failure is
confirmed and the failure reason matches the issue's reported error.

- [ ] **Step 4: Commit the failing test**

```bash
git add client/packages/harness-layer/test/seed-import-episodes.test.ts
git commit -m "test(harness-layer): pin stage1-seeds fixture set through executeEpisodes() (fails pre-fix, #1784)"
```

---

### Task 2: Switch the episode seed lane to the seed-profile scrub pipeline

**Files:**
- Modify: `client/packages/harness-layer/src/seed-import/episode-execute.ts:17` (import), `:156-161` (comment + pipeline construction)

**Interfaces:**
- Consumes: `buildSeedScrubPipeline` — exported from `client/src/trajectory/scrub/build.ts:82`, signature `export function buildSeedScrubPipeline(policy: KeyPolicy = DEFAULT_KEY_POLICY): ScrubPipeline`. Already imported and used identically in `client/packages/harness-layer/src/seed-import/execute.ts:32,202` (`const seedScrubPipeline = buildSeedScrubPipeline();`) — same relative import path applies here since both files live at `packages/harness-layer/src/seed-import/`.
- Produces: no change to `executeEpisodes()`'s exported signature or `EpisodeImportResult` shape. Behavior change only: which redactions are detected before publish.

This is the load-bearing change. The current code:

```ts
import { buildScrubPipeline } from '../../../../src/trajectory/scrub/build.js';
```

and:

```ts
  // Evidence episodes can contain copied command output and must use the
  // strict deterministic trace profile: structured PII plus entropy-backed
  // secret detection. The skill lane intentionally keeps its permissive
  // public-prose profile (#1409).
  const episodeScrubPipeline = buildScrubPipeline();
```

- [ ] **Step 1: Swap the import**

In `client/packages/harness-layer/src/seed-import/episode-execute.ts`, change:

```ts
import { buildScrubPipeline } from '../../../../src/trajectory/scrub/build.js';
```

to:

```ts
import { buildSeedScrubPipeline } from '../../../../src/trajectory/scrub/build.js';
```

- [ ] **Step 2: Swap the pipeline construction and rewrite the comment**

Change:

```ts
  // Evidence episodes can contain copied command output and must use the
  // strict deterministic trace profile: structured PII plus entropy-backed
  // secret detection. The skill lane intentionally keeps its permissive
  // public-prose profile (#1409).
  const episodeScrubPipeline = buildScrubPipeline();
```

to:

```ts
  // Evidence episodes are public, licence-checked prose seeds — like the
  // skill lane, not operator trace data — so they run the seed profile
  // (plan §4.4; spec/2026-07-02-jinn-harness-network.md §7): deterministic
  // key policy, plain-patterns, and secretlint pass-1 only. The strict
  // trace profile's probabilistic stages (openredaction, entropy fallback)
  // false-positive on ordinary words and hex-looking SHAs in this content
  // (#1784) and are not appropriate for a pre-vetted, checked-in corpus.
  const episodeScrubPipeline = buildSeedScrubPipeline();
```

The variable name `episodeScrubPipeline` stays as-is (both scrub call sites
downstream — the `episodeScrubPipeline.run(...)` pre-publish check and the
`capture(..., { pipeline: episodeScrubPipeline })` call — already reference
this single variable, so no other line in the file changes).

- [ ] **Step 3: Run the Task 1 regression test and confirm it now passes**

Run: `cd client && yarn vitest run packages/harness-layer/test/seed-import-episodes.test.ts -t "imports all three fixture episodes cleanly"`

Expected: PASS — `result.errors` is `[]`, all three fixture ids appear in
`result.imported`, `published` has length 3.

- [ ] **Step 4: Run the full seed-import-episodes suite**

Run: `cd client && yarn vitest run packages/harness-layer/test/seed-import-episodes.test.ts`

Expected: some pre-existing tests in the `it.each` sensitive-canary blocks
(lines ~275-319 of the pre-fix file — the payment-card / phone / JWT /
unprefixed-high-entropy canaries, plus the `ghp_...` id canary and the
card-number tag canary) may now FAIL, because those canaries were chosen to
trip the strict profile's `openredaction`/entropy-fallback stages, which no
longer run. This is expected and is fixed in Task 3 — do not treat these
failures as a regression in this step; confirm which specific cases fail and
carry that list into Task 3.

- [ ] **Step 5: Run the harness-layer typecheck**

Run: `cd client && yarn typecheck:harness-layer`

Expected: zero errors (the import swap is a same-shape function import; no
type surface changes).

- [ ] **Step 6: Commit the fix**

```bash
git add client/packages/harness-layer/src/seed-import/episode-execute.ts
git commit -m "fix(harness-layer): run the episode seed lane at the seed scrub profile (#1784)"
```

---

### Task 3: Rework the sensitive-canary tests to detectors the seed profile actually runs

**Files:**
- Modify: `client/packages/harness-layer/test/seed-import-episodes.test.ts:275-319` (the two `it.each` blocks under `describe('executeEpisodes()', ...)`)

**Interfaces:**
- Consumes: `episode()` factory (already defined in this file, `episode(overrides: Partial<SeedEpisode> = {})`); `planEpisodes`, `executeEpisodes`, `mockPublishDeps` (already imported/defined).
- Produces: nothing consumed by later tasks — this is the last task.

The seed profile (`buildSeedScrubPipeline()`, `client/src/trajectory/scrub/build.ts:82-88`) runs exactly three stages: `keyPolicyStage(policy)`, `plainPatternsStage(policy, { credentialIds: true })`, `secretlintStage(policy, { entropyFallback: false })`. It does **not** run `openredactionStage` or secretlint's entropy fallback. The existing canaries that relied on those two stages need replacing with canaries the surviving three stages actually catch. Per the design note, the `ghp_...` token canary already survives (secretlint pass-1 GitHub-token shape) — leave it as-is. The accepted-residual test must state the full trade-off: every structured identifier or PII class detected only by openredaction's 570+ pattern surface is now curator-review residual. Payment/contact, government-identity, medical, and financial examples sample that surface; they are not an exhaustive allowlist. JWTs and unprefixed high-entropy blobs are separate residuals from the omitted entropy fallback. A future reader must see that these gaps were chosen, not missed.

- [ ] **Step 1: Replace the first `it.each` block's canaries (openredaction-only detections)**

Find the existing block (pre-Task-2 line numbers ~275-301):

```ts
  it.each([
    ['payment card', 'Customer card: 4111 1111 1111 1111.'],
    ['phone-like PII', 'Call the customer at +1 (415) 555-2671.'],
    [
      'JWT',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlN5bnRoZXRpYyJ9.c2lnbmF0dXJlU3ludGhldGljVmFsdWU',
    ],
    ['high-entropy credential', 'Credential: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ])('rejects %s before any publish call', async (_label, sensitiveText) => {
    const source = mockEpisodeSource([
      episode({
        steps: [{ label: 'note', title: 'sensitive fixture', text: sensitiveText }],
      }),
    ]);
    const { deps, published } = mockPublishDeps();

    const result = await executeEpisodes(await planEpisodes(source), source, deps);

    expect(published).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: 'source-fixture',
        error: expect.stringMatching(/sensitive.*refusing to publish/i),
      }),
    ]);
  });
```

Replace it with canaries the seed profile's three surviving stages
detect — an email and a home path (`plainPatternsStage`), and an AWS
`AKIA...` access-key id (`plainPatternsStage`'s `credentialIds: true`
option, per `build.ts:72-73`'s doc comment: "bare AWS access-key IDs and GCP
`AIza…` API keys"):

```ts
  it.each([
    ['email address', 'Contact the reporter at jane.doe@example.com for repro steps.'],
    ['home-dir path', 'Logs were written to /Users/jdoe/project/output.log.'],
    ['AWS access-key id', 'Found a stray credential: AKIAIOSFODNN7EXAMPLE in the diff.'],
  ])('rejects %s before any publish call', async (_label, sensitiveText) => {
    const source = mockEpisodeSource([
      episode({
        steps: [{ label: 'note', title: 'sensitive fixture', text: sensitiveText }],
      }),
    ]);
    const { deps, published } = mockPublishDeps();

    const result = await executeEpisodes(await planEpisodes(source), source, deps);

    expect(published).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: 'source-fixture',
        error: expect.stringMatching(/sensitive.*refusing to publish/i),
      }),
    ]);
  });
```

- [ ] **Step 2: Leave the second `it.each` block's surviving canary, drop the redundant one**

Find the existing block (pre-Task-2 line numbers ~303-319):

```ts
  it.each([
    ['id/sessionId', { id: 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012' }],
    ['tag/distributionTag', { tags: ['acme', '4111 1111 1111 1111'] }],
  ])('rejects sensitive %s before any publish call', async (_label, overrides) => {
    const source = mockEpisodeSource([episode(overrides)]);
    const { deps, published } = mockPublishDeps();

    const result = await executeEpisodes(await planEpisodes(source), source, deps);

    expect(published).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        error: expect.stringMatching(/sensitive.*refusing to publish/i),
      }),
    ]);
  });
```

The `ghp_...` id canary is a secretlint pass-1 GitHub-token shape and
survives unchanged. The card-number tag canary relied on the strict
profile's `openredaction`/entropy stages for a payment-card-shaped string in
a tag and would no longer be caught (a bare `4111 1111 1111 1111` is not a
secretlint pass-1 pattern nor a `plainPatternsStage` credential-id shape).
Replace it with an email-in-tag case, which `plainPatternsStage` still
catches structurally regardless of field:

```ts
  it.each([
    ['id/sessionId', { id: 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012' }],
    ['tag/distributionTag', { tags: ['acme', 'contact-jane.doe@example.com'] }],
  ])('rejects sensitive %s before any publish call', async (_label, overrides) => {
    const source = mockEpisodeSource([episode(overrides)]);
    const { deps, published } = mockPublishDeps();

    const result = await executeEpisodes(await planEpisodes(source), source, deps);

    expect(published).toHaveLength(0);
    expect(result.imported).toHaveLength(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        error: expect.stringMatching(/sensitive.*refusing to publish/i),
      }),
    ]);
  });
```

- [ ] **Step 3: Add an explicit accepted-residual test documenting the #1409 trade-off**

Add a new test immediately after the two reworked `it.each` blocks, inside
the same `describe('executeEpisodes()', ...)` block:

```ts
  it.each([
    ['payment-card-shaped string', 'Customer card: 4111 1111 1111 1111.'],
    ['phone-shaped string', 'Call the customer at +1 (415) 555-2671.'],
    ['SSN-shaped string', 'Reporter SSN on file: 123-45-6789.'],
    [
      'JWT-shaped string',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl',
    ],
    ['unprefixed high-entropy blob', 'Credential: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['medical-record identifier', 'Medical record MRN: MED123456.'],
    ['government-identity identifier', 'Passport: A1234567.'],
    ['financial-account identifier', 'Bank account: 1234 5678.'],
  ])('accepts a %s under the seed profile (documented residual, #1409/#1784)', async (_label, residualText) => {
    // The seed profile deliberately does not run openredaction or the
    // entropy fallback (build.ts's buildSeedScrubPipeline doc comment,
    // #1409): seeds are public, licence-checked prose, and those
    // probabilistic stages false-positive on ordinary words and hex-looking
    // ids in that content (#1784). Every structured identifier or PII class
    // detected only by openredaction is therefore residual risk — not just
    // the representative payment, contact, government identity, medical,
    // and financial cases sampled here. Seed curators must catch them by
    // review. This test pins the trade-off, not an exhaustive allowlist.
    const source = mockEpisodeSource([
      episode({
        steps: [{ label: 'note', title: 'residual fixture', text: residualText }],
      }),
    ]);
    const { deps, published } = mockPublishDeps();

    const result = await executeEpisodes(await planEpisodes(source), source, deps);

    expect(result.errors).toEqual([]);
    expect(result.imported).toHaveLength(1);
    expect(published).toHaveLength(1);
  });
```

- [ ] **Step 4: Run the full file and confirm everything passes**

Run: `cd client && yarn vitest run packages/harness-layer/test/seed-import-episodes.test.ts`

Expected: PASS — all tests in the file green, including the Task 1
regression test, the reworked canary blocks, and the new accepted-residual
test.

- [ ] **Step 5: Run the full harness-layer test slice and typecheck**

Run: `cd client && yarn vitest run packages/harness-layer/test packages/harness-layer/../../test/**/*.test.ts 2>/dev/null; yarn vitest run --dir packages/harness-layer`

If the above glob is awkward in your shell, run the narrower, reliable form
instead:

Run: `cd client && yarn vitest run packages/harness-layer/test/seed-import-episodes.test.ts packages/harness-layer/test/stage1-seeds-fixtures.test.ts`

Expected: PASS on both files — `stage1-seeds-fixtures.test.ts` is unaffected
by this change (it exercises the fixture files' own shape/scrub-lint rules,
not the execute-time pipeline) and must remain green.

Run: `cd client && yarn typecheck:harness-layer`

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add client/packages/harness-layer/test/seed-import-episodes.test.ts
git commit -m "test(harness-layer): rework episode-lane canaries for the seed scrub profile (#1784)"
```

---

### Task 4: Full-suite verification and issue acceptance-criteria sign-off

**Files:** none (verification only).

**Interfaces:** none — this task runs the project's standard verification commands and cross-checks the three acceptance criteria from issue #1784.

- [ ] **Step 1: Run the full client test suite**

Run: `cd client && yarn test`

Expected: PASS, zero failures. This runs `vitest run` across the whole
`client/` tree (per `vitest.config.ts`'s include globs, which cover
`packages/*/test/**/*.test.ts`), so it re-confirms `seed-import-episodes.test.ts`
and `stage1-seeds-fixtures.test.ts` pass alongside everything else, and
that nothing else in the tree depended on the episode lane's strict-profile
behavior.

- [ ] **Step 2: Run the full client typecheck**

Run: `cd client && yarn typecheck`

Expected: zero errors.

- [ ] **Step 3: Cross-check acceptance criteria**

1. "The episode seed lane scrubs at the seed profile (fail-closed on real
   secret patterns retained)" — satisfied by Task 2 (pipeline swap) plus
   Task 3's canary tests proving the surviving deterministic stages (key
   policy, plain-patterns, secretlint pass-1) still refuse-on-detection.
2. "`distractor-operator-claims` publishes cleanly; live-corpus D1 present" —
   **not satisfied by this PR's mocked tests**. Task 1 proves only that
   `executeEpisodes()` accepts the fixture and constructs a publication with
   test doubles. The real testnet publish and `corpus search "claims"`
   verification remain an explicit post-merge operational gate in
   `docs/runbooks/stage1-evidence-seeding.md`. Keep #1784 open until an
   operator records that evidence.
3. "A regression test pins that the fixture set passes the lane's scrub" —
   satisfied by Task 1's test, which loads all three checked-in fixtures via
   `createLocalEpisodeSeedSource` and drives them through the real
   `executeEpisodes()` entry point.

- [ ] **Step 4: Confirm no other file references the old rationale comment**

Run: `cd client && grep -rn "strict deterministic trace profile" packages/harness-layer src`

Expected: no output (the only occurrence was the comment rewritten in Task
2). If any other file still asserts the episode lane uses the strict
profile (e.g. a doc comment elsewhere, or `docs/runbooks/stage1-evidence-seeding.md`),
flag it for a follow-up — do not expand this fix's scope to rewrite
unrelated docs unless the plan's acceptance criteria require it.

No commit in this task — it is verification-only, confirming the code-side
criteria while recording that the live-corpus criterion remains open.

### Post-merge operational acceptance gate (intentionally not run by this PR)

- [ ] Re-run `seed plan` and `seed execute` for the checked-in episode
  fixtures with real configured testnet services and operator identity.
- [ ] Run `yarn jinn-layer corpus search "claims" --limit 5` and confirm
  `distractor-operator-claims` is present.
- [ ] Fetch the returned ref and record its imported provenance,
  seed-profile scrub manifest, and anchor evidence on #1784.

No mocked `publishArtifact`/`publishEnvelope` call satisfies these checks,
and this implementation session must not perform the outbound publication.

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** All three acceptance criteria map to work (AC1 → Task
  2, AC2 → Task 1's local prerequisite plus the post-merge operational gate,
  AC3 → Task 1). The design note's two test asks (fixture-set regression
  test; canary rework/accepted-residual test) map to Task 1 and Task 3
  respectively. AC2 remains intentionally open until the testnet evidence
  exists.
- **Placeholder scan:** no TBD/TODO; every step shows the actual diff or
  command.
- **Type consistency:** `EpisodeImportResult`, `executeEpisodes()`'s
  signature, `mockPublishDeps()`'s return shape, and `episode()`'s factory
  signature are used identically to how they already appear in the
  untouched parts of `seed-import-episodes.test.ts` — no renamed symbols
  introduced by this plan.
