# 2026-05-26 — Implementation plan: snapshot single-field rename check (#597)

**Status:** plan
**Issue:** [Jinn-Network/mono#597](https://github.com/Jinn-Network/mono/issues/597)
**Design note:** [`docs/superpowers/specs/2026-05-26-597-snapshot-single-field-rename-check.md`](../specs/2026-05-26-597-snapshot-single-field-rename-check.md)
**Shape:** `feat` · **Effort:** Low
**Workspace:** `packages/eng-loop`

## Scope summary

Extend `fetchProjectSnapshot` so it throws `ProjectFieldSchemaError` when the
`Status` field returns `null` for *every* Issue (N ≥ 3) — catching single-field
renames of `Status` that the existing all-four-null backstop misses. Per the
design note, the per-field check is **restricted to `Status` only**: the other
three fields (`Priority` / `Effort` / `Blocked on`) legitimately stay null on a
freshly-triaged board, so a per-field check on those would false-positive
constantly. `Status` is the only field the platform auto-sets on issue
creation (`gh project item-add` populates it with `Todo`), which gives it a
zero-false-positive surface. The all-four-null catastrophic backstop stays in
place and continues to use the existing message verbatim.

## Files to read first

The implementer should load these in context before writing any code:

1. **`packages/eng-loop/src/dispatcher/project-snapshot.ts`** — the module
   under change. Contains `ProjectFieldSchemaError` (lines ~185–197),
   `SCHEMA_DRIFT_MIN_ISSUE_COUNT` (line ~144), and the existing schema-drift
   check at the bottom of `fetchProjectSnapshot` (lines ~508–513). The error
   class lives in this same file — no separate module to find.
2. **`packages/eng-loop/test/dispatcher/project-snapshot.test.ts`** — the
   test file. The existing `describe('fetchProjectSnapshot — schema-drift
   detection', …)` block (lines ~409–491) is where the new cases land. The
   fixtures (`buildPageResponse`, `issueNode`, `prNode`, `draftIssueNode`,
   `makePagedRunner`) already cover everything the new tests need — no new
   helpers required.
3. **`packages/eng-loop/package.json`** — confirmed: `test` runs `vitest run`,
   `typecheck` runs `tsc --noEmit`. The verification command in §Verification
   below uses these.
4. **Design note** (above) — re-read §Approach, §False-positive avoidance,
   and §`ProjectFieldSchemaError` extension before touching code. The
   per-field check is `Status`-only by design; do not generalise it.

## TDD sequence

Follow `superpowers:test-driven-development`. Write each test, watch it fail
with the expected error shape, then implement the minimum change to make it
pass. Add tests in this order so each step's red-state is unambiguous.

The new tests all extend the existing
`describe('fetchProjectSnapshot — schema-drift detection', …)` block in
`project-snapshot.test.ts`. Cases map to design-note §"Test cases for the plan
stage" numbers.

### Test 1 (design case #1) — Status-only null across N=3 throws with `field === 'Status'`

```ts
it('throws ProjectFieldSchemaError when Status is null for every Issue (N≥3) and other fields are populated', async () => {
  const { runner } = makePagedRunner([
    buildPageResponse({
      rateLimitRemaining: 4999,
      nodes: [
        issueNode({ id: 'PVTI_a', number: 1, priority: 'P1', effort: 'Low', blockedOn: 'Nothing' }),
        issueNode({ id: 'PVTI_b', number: 2, priority: 'P2', effort: 'Medium', blockedOn: 'Nothing' }),
        issueNode({ id: 'PVTI_c', number: 3, priority: 'P3', effort: 'High', blockedOn: 'Nothing' }),
      ],
    }),
  ]);

  await expect(fetchProjectSnapshot(runner)).rejects.toBeInstanceOf(ProjectFieldSchemaError);
  await expect(fetchProjectSnapshot(runner)).rejects.toMatchObject({ field: 'Status' });
});
```

Note: the second `await expect` re-runs the fetch (a fresh runner is needed
because `makePagedRunner` throws on a second call). Either build two runners
or capture the error once and assert against the captured value:

```ts
let caught: unknown;
try { await fetchProjectSnapshot(runner); } catch (e) { caught = e; }
expect(caught).toBeInstanceOf(ProjectFieldSchemaError);
expect((caught as ProjectFieldSchemaError).field).toBe('Status');
expect((caught as Error).message).toContain("field 'Status'");
expect((caught as Error).message).toContain('3');
```

Use the capture pattern in every new test — it's both cheaper and lets the
message-shape assertions live next to the type assertion.

### Test 2 (design case #2) — Status null across N=2 does NOT throw

```ts
it('does NOT throw when Status is null for only 2 Issues (below SCHEMA_DRIFT_MIN_ISSUE_COUNT)', async () => {
  const { runner } = makePagedRunner([
    buildPageResponse({
      rateLimitRemaining: 4999,
      nodes: [
        issueNode({ id: 'PVTI_a', number: 1, priority: 'P1', effort: 'Low', blockedOn: 'Nothing' }),
        issueNode({ id: 'PVTI_b', number: 2, priority: 'P2', effort: 'Medium', blockedOn: 'Nothing' }),
      ],
    }),
  ]);

  await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
});
```

### Test 3 (design case #3) — All-untriaged board does NOT throw (false-positive guard)

This is the central justification for restricting the per-field check to
`Status`. Five Issues, every one has `status: 'Todo'` (auto-set), all other
three fields null. Must not throw.

```ts
it('does NOT throw on an untriaged board where Status is set but Priority/Effort/Blocked on are all null', async () => {
  const { runner } = makePagedRunner([
    buildPageResponse({
      rateLimitRemaining: 4999,
      nodes: [
        issueNode({ id: 'PVTI_a', number: 1, status: 'Todo' }),
        issueNode({ id: 'PVTI_b', number: 2, status: 'Todo' }),
        issueNode({ id: 'PVTI_c', number: 3, status: 'Todo' }),
        issueNode({ id: 'PVTI_d', number: 4, status: 'Todo' }),
        issueNode({ id: 'PVTI_e', number: 5, status: 'Todo' }),
      ],
    }),
  ]);

  await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
});
```

### Test 4 (design case #4) — All-fields-null catastrophic case still throws with `field === 'all'`

Modify the existing
`'throws ProjectFieldSchemaError when every item has all four single-select fields null'`
test (lines ~410–423) to also assert `err.field === 'all'` and that the
original message is preserved (contains `all 3 project items`). This locks the
back-compat contract from the design note (§`ProjectFieldSchemaError`
extension — "the existing all-fields message preserved verbatim for the
catastrophic case so existing tests / log scrapers keep matching").

### Test 5 (design case #5) — Mixed Status does NOT throw

```ts
it('does NOT throw when some Issues have Status set and others do not (per-field check requires every Issue null)', async () => {
  const { runner } = makePagedRunner([
    buildPageResponse({
      rateLimitRemaining: 4999,
      nodes: [
        issueNode({ id: 'PVTI_a', number: 1, status: 'Todo', priority: 'P1', effort: 'Low', blockedOn: 'Nothing' }),
        issueNode({ id: 'PVTI_b', number: 2, status: 'Todo', priority: 'P2', effort: 'Medium', blockedOn: 'Nothing' }),
        issueNode({ id: 'PVTI_c', number: 3, priority: 'P3', effort: 'High', blockedOn: 'Nothing' }), // status null
      ],
    }),
  ]);

  await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
});
```

### Test 6 (design case #6) — PRs/DraftIssues with null Status are ignored

```ts
it('ignores PRs/DraftIssues when computing the per-field Status check', async () => {
  const { runner } = makePagedRunner([
    buildPageResponse({
      rateLimitRemaining: 4999,
      nodes: [
        // Only 2 Issues, both with Status set — below threshold for the check anyway,
        // but the assertion is that 3 null-Status PRs/Drafts don't push it over.
        issueNode({ id: 'PVTI_iss1', number: 1, status: 'Todo' }),
        issueNode({ id: 'PVTI_iss2', number: 2, status: 'In Progress' }),
        prNode({ id: 'PVTI_pr1', number: 100 }),
        prNode({ id: 'PVTI_pr2', number: 101 }),
        draftIssueNode({ id: 'PVTI_draft' }),
      ],
    }),
  ]);

  await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
});
```

### Test 7 (design case #7) — Priority/Effort/Blocked on individually null do NOT throw

This documents the residual gap explicitly so a future contributor who looks
at the test file sees that this is *intentional*, not an oversight. One
parameterised-style test (or three siblings, whichever reads cleaner) for the
three non-Status fields.

```ts
it.each([
  { label: 'Priority', overrides: { status: 'Todo', effort: 'Low', blockedOn: 'Nothing' } },
  { label: 'Effort', overrides: { status: 'Todo', priority: 'P2', blockedOn: 'Nothing' } },
  { label: 'Blocked on', overrides: { status: 'Todo', priority: 'P2', effort: 'Low' } },
])(
  'does NOT throw when only $label is null across N=3 Issues (per-field check is Status-only by design — see spec 2026-05-26)',
  async ({ overrides }) => {
    const { runner } = makePagedRunner([
      buildPageResponse({
        rateLimitRemaining: 4999,
        nodes: [
          issueNode({ id: 'PVTI_a', number: 1, ...overrides }),
          issueNode({ id: 'PVTI_b', number: 2, ...overrides }),
          issueNode({ id: 'PVTI_c', number: 3, ...overrides }),
        ],
      }),
    ]);

    await expect(fetchProjectSnapshot(runner)).resolves.toBeDefined();
  },
);
```

### Test 8 (design case #8) — Error carries `field` property

Covered inline by tests #1 and #4 above (assertions on `err.field`). No
separate test needed.

## Implementation steps

Each step is a small, committable unit. The whole change should land in
**one commit** (one logical change: extend `ProjectFieldSchemaError` + add the
per-field `Status` check). If the implementer prefers TDD discipline split
into red/green commits, that's fine — but the issue is `Effort: Low` and the
diff is small enough that one commit is the expected shape.

### Step 1 — Extend `ProjectFieldSchemaError` with a `field` discriminant

**File:** `packages/eng-loop/src/dispatcher/project-snapshot.ts`

Add a type alias for the field discriminant and gain the new constructor
parameter + readonly property:

```ts
/** Which Project field tripped the schema-drift check.
 *  `'all'` = the catastrophic all-four-fields-null backstop;
 *  any other value = a per-field check fired on that single field. */
export type SchemaDriftField = 'Status' | 'Priority' | 'Effort' | 'Blocked on' | 'all';

export class ProjectFieldSchemaError extends Error {
  readonly field: SchemaDriftField;

  constructor(itemCount: number, field: SchemaDriftField = 'all') {
    const message =
      field === 'all'
        ? `ProjectFieldSchemaError: all ${itemCount} project items resolved every ` +
            `single-select field to null (threshold: ${SCHEMA_DRIFT_MIN_ISSUE_COUNT}+). ` +
            `The most likely cause is that one of the ` +
            `Status / Priority / Effort / Blocked on field labels was renamed. ` +
            `Re-run \`gh project field-list 1 --owner Jinn-Network --format json\` ` +
            `to discover the current field labels and update the snapshot query.`
        : `ProjectFieldSchemaError: field '${field}' returned null for all ${itemCount} Issues ` +
            `(threshold: ${SCHEMA_DRIFT_MIN_ISSUE_COUNT}+). Likely renamed in the Project — ` +
            `re-run \`gh project field-list 1 --owner Jinn-Network --format json\` ` +
            `to discover the current label and update the snapshot query.`;
    super(message);
    this.name = 'ProjectFieldSchemaError';
    this.field = field;
  }
}
```

Notes:
- `field` defaults to `'all'` so the existing call-site
  (`throw new ProjectFieldSchemaError(issueCount)`) keeps compiling without
  modification on this step.
- The per-field message format is **verbatim from the design note** —
  `field '<Status>' returned null for all <N> Issues (threshold: 3+). Likely renamed in the Project — re-run \`gh project field-list 1 --owner Jinn-Network --format json\``
  (with the `update the snapshot query` tail clause carried over from the
  existing message for operator-recovery symmetry). Do not paraphrase.
- Update the class docstring to mention the per-field discriminant and the
  `Status`-only restriction (point to the spec file for the false-positive
  reasoning rather than restating it).
- Also update the docstring on the existing `'Catches the catastrophic case
  (all 4 fields renamed); single-field renames are not detected — that's a
  future enhancement.'` line — that future-enhancement caveat is now partly
  resolved (Status is detected; the other three are documented residual gap).

**Satisfies:** AC1 (machine-readable `field` property naming the suspect
field), prerequisite for AC4 (backstop preservation).

### Step 2 — Add the per-field `Status` check in `fetchProjectSnapshot`

**File:** `packages/eng-loop/src/dispatcher/project-snapshot.ts`

Add a `issuesWithNullStatus` counter alongside `issuesWithAllFieldsNull` in
the pagination loop:

```ts
let issueCount = 0;
let issuesWithAllFieldsNull = 0;
let issuesWithNullStatus = 0;
```

Increment inside the existing `if (item.contentType === 'Issue')` block:

```ts
if (item.contentType === 'Issue') {
  issueCount += 1;
  if (item.status == null) {
    issuesWithNullStatus += 1;
  }
  if (
    item.status == null &&
    item.priority == null &&
    item.effort == null &&
    item.blockedOn == null
  ) {
    issuesWithAllFieldsNull += 1;
  }
}
```

Then, at the post-pagination check site, evaluate the catastrophic backstop
**first** (so the more-informative `'all'` message wins when both would
fire), then the per-`Status` check:

```ts
if (
  issueCount >= SCHEMA_DRIFT_MIN_ISSUE_COUNT &&
  issueCount === issuesWithAllFieldsNull
) {
  throw new ProjectFieldSchemaError(issueCount, 'all');
}

if (
  issueCount >= SCHEMA_DRIFT_MIN_ISSUE_COUNT &&
  issueCount === issuesWithNullStatus
) {
  throw new ProjectFieldSchemaError(issueCount, 'Status');
}
```

Pass `'all'` explicitly at the existing throw site (even though the default
makes it optional) — the explicit discriminant reads more clearly and avoids
a subtle behaviour change if the default ever shifts.

**Satisfies:**
- **AC1** — `Status`-only rename now throws.
- **AC2** — the `Priority`/`Effort`/`Blocked on` per-field checks are
  *intentionally* not added (see design note §False-positive avoidance);
  Test 7 locks this in.
- **AC3** — restricting the per-field check to `Status` is the
  false-positive avoidance mechanism (`Status` is auto-set on issue
  creation; the other three legitimately stay null).
- **AC4** — the all-fields-null backstop is preserved and evaluated first.

### Step 3 — Update the tests

**File:** `packages/eng-loop/test/dispatcher/project-snapshot.test.ts`

Add tests #1, #2, #3, #5, #6, #7 from the TDD sequence above into the
existing `describe('fetchProjectSnapshot — schema-drift detection', …)`
block, and modify test #4 (the existing all-four-null test) to also assert
`err.field === 'all'` and the original message is preserved.

**Satisfies:** AC5 (test coverage).

### Step 4 — Commit

One commit per `superpowers:executing-plans` discipline. Conventional-commit
prefix per the engineering handbook for a `feat` shape:

```
feat(eng-loop): detect single-field Status rename in project-snapshot drift check (#597)
```

Body should reference the design note path and the issue number, and call
out the deliberate scope (Status only, not the other three fields) so a
future archaeologist doesn't reopen this as a "bug".

## Verification

Confirmed via `package.json`: the eng-loop package uses `vitest` (not
`mocha`), `test` is `vitest run`, `typecheck` is `tsc --noEmit`. Run from the
worktree root:

```bash
yarn workspace @jinn-network/eng-loop typecheck \
  && yarn workspace @jinn-network/eng-loop test packages/eng-loop/test/dispatcher/project-snapshot.test.ts
```

Pass criteria:
- `typecheck` exits 0 (the new `SchemaDriftField` export and the
  `field` readonly property compile cleanly).
- All existing tests in `project-snapshot.test.ts` still pass (back-compat:
  the `'all'`-case message is byte-for-byte identical).
- All new tests (#1, #2, #3, #5, #6, #7) pass.
- The modified test #4 passes with its new `err.field === 'all'` assertion.

Once green, run the full eng-loop suite as a smoke check before committing:

```bash
yarn workspace @jinn-network/eng-loop test
```

Then run `superpowers:verification-before-completion` before claiming done.

## Acceptance-criterion mapping summary

| AC | Mechanism | Step | Test |
|----|-----------|------|------|
| AC1 — Status rename throws with field-naming message | Per-`Status` check + `field` discriminant | Steps 1 + 2 | Test 1 |
| AC2 — Priority/Effort/Blocked-on individually (declined) | Not implemented; residual gap documented | (none) | Test 7 |
| AC3 — No false positives on untriaged board | Restrict per-field check to `Status` (auto-set on creation) | Step 2 | Test 3 |
| AC4 — All-four-null backstop preserved | First-evaluated branch; verbatim message; `'all'` discriminant | Steps 1 + 2 | Test 4 (modified) |
| AC5 — Test coverage | New tests #1–#3, #5–#7; modified #4 | Step 3 | Tests 1–7 |

## Out of scope

- Per-field checks for `Priority`, `Effort`, `Blocked on` (explicitly declined
  in design note §False-positive avoidance).
- Operator-app surfacing of `err.field` (the design note flags this as a
  future consumer; the readonly property exists so a follow-up can branch on
  it without parsing the message).
- Loop-level log formatting that branches on `err.field` (same — future work).
- Changing `SCHEMA_DRIFT_MIN_ISSUE_COUNT` from 3.
- Any change to the GraphQL query or pagination logic.
