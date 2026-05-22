# Implementation plan — issue #497

**Issue:** [#497](https://github.com/Jinn-Network/mono/issues/497) — Dispatcher: author allowlist
**Design:** `docs/superpowers/specs/2026-05-23-author-allowlist-design.md`
**Date:** 2026-05-23

## TDD order (regression-first per work shape `feat`)

1. Test additions (failing) — write all new failing test cases first.
2. Type additions — `author` on `PolledIssue`, `authorAllowlist` on `DispatcherConfig`/`DEFAULT_CONFIG`, `skippedForAuthor` on `CycleReport`.
3. `selectReady` signature + return-shape change + allowlist predicate.
4. `GhIssueSource` acquires `author` field from `gh issue list`.
5. `runCycle` builds the lowercased `Set`, passes it to `selectReady`, threads `skippedForAuthor` into `CycleReport`.
6. Runner (`run-eng-loop.ts`) reads env var, warns on empty, surfaces `skippedForAuthor` in `printReport`.
7. Verify all tests pass (green).

---

## Tasks

### T1 — Test additions (all failing until T2–T6 land)

**File:** `packages/eng-loop/test/dispatcher/ready-filter.test.ts`

- Add `author: 'alice'` to the `base` fixture.
- New `describe('author allowlist')` block — five cases:
  1. empty allowlist + one otherwise-ready issue → `ready: []`, `skippedForAuthor: [{ number: 1, author: 'alice' }]`.
  2. allowlist `['alice']` + author `'alice'` → in `ready`.
  3. allowlist `['alice']` + author `'Alice'` → in `ready` (case-insensitive).
  4. allowlist `['alice']` + author `'bob'` → `ready: []`, `skippedForAuthor: [{ number: 1, author: 'bob' }]`.
  5. Two issues (`'alice'`, `'bob'`) + allowlist `['alice']` → only alice in `ready`, bob in `skippedForAuthor`.
- Update all 6 existing call sites: add third arg `new Set(['alice'])`, destructure `{ ready }` from return.

**File:** `packages/eng-loop/test/dispatcher/issue-source.test.ts`

- Add `author: { login: 'alice' | 'bob' | 'carol' }` to each entry in `ISSUE_LIST_JSON` (one per fixture issue).
- Assert `author` is populated correctly per case.

**File:** `packages/eng-loop/test/dispatcher/loop.test.ts`

- Add `author: 'alice'` to the polled-issue helper.
- Add `authorAllowlist: ['alice']` to every existing `{ ...DEFAULT_CONFIG, ... }` cfg construction (6-7 sites).
- Assert `skippedForAuthor: []` in existing CycleReport expectations.
- New test: empty allowlist + one ready issue (author `'trusteduser'`) → `dispatched: []`, `skippedForAuthor: [{ number, author }]`.

**Acceptance:** `yarn test` fails with type errors + assertion failures.

---

### T2 — Type additions

**File:** `packages/eng-loop/src/dispatcher/types.ts`

- `PolledIssue` — add `author: string`.
- `DispatcherConfig` — add `authorAllowlist: string[]` with JSDoc.
- `DEFAULT_CONFIG` — add `authorAllowlist: []`.

---

### T3 — `selectReady` signature + return-shape

**File:** `packages/eng-loop/src/dispatcher/ready-filter.ts`

- Third param: `authorAllowlist: ReadonlySet<string>` (pre-lowercased by caller).
- Return: `{ ready: ReadyIssue[]; skippedForAuthor: Array<{ number: number; author: string }> }`.
- First pass: existing predicates (shape/priority/blockedOn/onBoard/status/inFlight). Failures are excluded from both arrays.
- Second pass: allowlist predicate `authorAllowlist.has(issue.author.toLowerCase())`. Failures go into `skippedForAuthor` only.
- Sort applies only to `ready`.

---

### T4 — `GhIssueSource` acquires `author`

**File:** `packages/eng-loop/src/dispatcher/issue-source.ts`

- `gh issue list ... --json number,title,labels,author`.
- Add `author: { login: string }` to internal `GhIssue` interface.
- Map `author: ghIssue.author?.login ?? ''` in the `PolledIssue` builder (defensive `?.` against older `gh` versions).

---

### T5 — `runCycle` threads allowlist + report field

**File:** `packages/eng-loop/src/dispatcher/loop.ts`

- `CycleReport` — add `skippedForAuthor: Array<{ number: number; author: string }>`.
- After building `inFlightSet`, build `allowlistSet = new Set(cfg.authorAllowlist.map(s => s.toLowerCase()))`.
- Destructure `{ ready, skippedForAuthor }` from `selectReady(polled, inFlightSet, allowlistSet)`.
- Include `skippedForAuthor` in **both** the normal return and the backpressure early-return.

---

### T6 — Runner wiring

**File:** `packages/eng-loop/scripts/run-eng-loop.ts`

- Read `process.env['JINN_DISPATCHER_AUTHOR_ALLOWLIST']`, split-trim-filter.
- Merge into `cfg`.
- Inside `runOneCycle` (or `printReport`), if `cfg.authorAllowlist.length === 0` log `[eng:loop] WARNING: authorAllowlist is empty — no issues will be dispatched`.
- Extend `printReport` to render `skippedForAuthor` after the throttle line.

---

### T7 — Green pass

`yarn test` clean, `yarn typecheck` clean from `packages/eng-loop`.

---

## Mechanical update callouts

- `loop.test.ts` — 6-7 `{ ...DEFAULT_CONFIG, ... }` sites need `authorAllowlist`; every report assertion needs `skippedForAuthor: []`.
- `ready-filter.test.ts` — 6 `selectReady(...)` call sites need a third arg + return destructuring.

## Risks

- `gh issue list --json author` returns `author: { login: string }` (object, not string). Mapping must extract `.login`.
- Backpressure early-return in `runCycle` must include `skippedForAuthor` in its `CycleReport` too — author skips happen regardless of backpressure.
- PR target is `docs/automated-eng-flow-design` (stacked on PR #481), not `next`.
