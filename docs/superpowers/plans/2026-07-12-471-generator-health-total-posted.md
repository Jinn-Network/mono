# Plan — #471: expose generator `totalPosted` + `lastPostedInstanceId` (recent posting activity)

- **Issue**: #471 — feat(operator-app): expose generator health (last poll/error/posted) — Launcher 'LAST POLL' always blank
- **Shape**: `feat` (TDD — tests written before/alongside impl)
- **Date**: 2026-07-12
- **Branch**: `feat/471-feat-operator-app-expose-generator-health-last-poll-error-po`
- **Worktree**: `/Users/adrianobradley/life's-work/jinn-mono_worktrees/471`

## Context & scope

Most of #471 already shipped on `next`. The live-generator-state pipeline
(`getState()` closure → `projectLauncherGeneratorState` →
`launchedGeneratorStateBySolverType` → `getGeneratorState(solverNetId)` →
`withLiveGeneratorState`) already delivers `lastPollAt`, `lastPollSummary`
(poolSize/posted/unposted/live/repostable/saturated), and `lastError`
end-to-end. The SPA `GeneratorPanel` already renders "Last poll", the pool
summary, and a generator-error block. Those ACs are satisfied.

**Residual gap (the only unmet ACs):** `totalPosted` and its companion
`lastPostedInstanceId` ("recent posting activity"). The swe-rebench-v2
generator already tracks and emits both
(`client/src/solver-types/swe-rebench-v2.ts`: snapshot type at lines 140–141;
running counters at 457–458; increment at 812–813; emitted at 897–898), but
the **projection layer drops them** and they are **absent from every
downstream type**. This plan carries the two fields the last four hops:
projection → daemon-side snapshot interface → SPA type → UI render, plus the
spec update.

### prediction.v1 parity trade-off

`totalPosted`/`lastPostedInstanceId` are **swe-rebench-v2-only**. The
prediction.v1 generator snapshot has no such fields. The projection must copy
them **only when present** (guarded by the existing `finiteNumber` /
`optionalString` helpers), so a prediction.v1 generator simply omits them —
no schema divergence, no required-field break. The SPA renders "—" (via the
existing `formatTimestamp`/`String(...)` fallback pattern) when absent. This is
identical to how `lastPollSummary`'s two shapes already coexist.

### Verified anchors (confirmed against current code)

| # | File | Site | Change |
|---|------|------|--------|
| 1 | `client/src/solvernets/launched-record-dispatcher.ts` | `projectLauncherGeneratorState` (161–230); helpers `optionalString` (153), `finiteNumber` (157) | copy `totalPosted` (finiteNumber) + `lastPostedInstanceId` (optionalString) onto `projected` |
| 2 | `client/src/api/launcher-status.ts` | `LauncherGeneratorStateSnapshot` (75–83) | add `totalPosted?: number` + `lastPostedInstanceId?: string` |
| 3 | `client/src/dashboard/spa/src/api/types.ts` | `LaunchedGeneratorState` (623–630) | add the same two optional fields |
| 4 | `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx` | header `<dl>` (301–312) and/or `GeneratorPoolSummary` (630–646) | add "Total posted" `MetaItem`; render last-posted instance id |
| 5 | `client/OPERATOR-APP-SPEC.md` | §2.14 State bullets (379–386) | add `total posted` + `last posted instance` bullets |

`withLiveGeneratorState` (`client/src/api/solvernets-endpoints.ts:147`) spreads
the live snapshot **verbatim** onto `record.generatorState` — no transform, so
once anchors 1–3 carry the fields they flow through untouched. No change there.

## Acceptance criteria → tasks

- **AC1** — "launched-record API exposes … total posted" → Steps 1–4 (projection + snapshot interface + SPA type; verified by the dispatcher projection test).
- **AC2** — "Launched page renders … recent posting activity" → Steps 5–6 (UI + component test).
- **Spec gate** (CLAUDE.md §Frontends: spec update lands in the SAME PR as the UI change) → Step 7.

## Steps (TDD order)

### Step 1 — (test first) Extend the dispatcher projection test — RED

File: `client/test/main/launched-record-dispatcher.test.ts`

The first `it` (44–136) already feeds `totalPosted: 4` in the swe generator's
`getState()` (line 59) but its `.toEqual(...)` assertion (121–131) omits it,
which currently passes precisely *because* the projection drops it.

- Add `lastPostedInstanceId: 'astropy__astropy-14096'` to the swe generator
  `getState()` fixture object (alongside `totalPosted: 4`, ~line 59).
- Add `totalPosted: 4` and `lastPostedInstanceId: 'astropy__astropy-14096'`
  to the expected object at lines 121–131.

Run `cd client && yarn test launched-record-dispatcher` → the assertion **must
fail** (projection drops both fields). This is the RED that proves the gap.

### Step 2 — Carry the fields through the projection — GREEN

File: `client/src/solvernets/launched-record-dispatcher.ts`

In `projectLauncherGeneratorState`, before `return projected;` (~line 228), add:

```ts
const totalPosted = finiteNumber(snapshot['totalPosted']);
if (totalPosted !== undefined) projected.totalPosted = totalPosted;
const lastPostedInstanceId = optionalString(snapshot['lastPostedInstanceId']);
if (lastPostedInstanceId) projected.lastPostedInstanceId = lastPostedInstanceId;
```

Guarded by the existing helpers → prediction.v1 (which lacks both) is
unaffected. Re-run Step 1's test → **GREEN**.

### Step 3 — Add the fields to the daemon-side snapshot interface

File: `client/src/api/launcher-status.ts`

Add to `LauncherGeneratorStateSnapshot` (75–83):

```ts
  totalPosted?: number;
  lastPostedInstanceId?: string;
```

(Optional so prediction.v1 snapshots remain valid.) Required so Step 2's
`projected.totalPosted = …` typechecks. No behavior change in the launcher
`/status` gather path — the new fields ride along untouched.

### Step 4 — Add the fields to the SPA type

File: `client/src/dashboard/spa/src/api/types.ts`

Add to `LaunchedGeneratorState` (623–630):

```ts
  totalPosted?: number;
  lastPostedInstanceId?: string;
```

This is the type `withLiveGeneratorState` spreads into and that
`GeneratorPanel` reads via `record.generatorState`.

### Step 5 — (test first) Extend the GeneratorPanel component test — RED

File: `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.test.tsx`

Model on the existing "surfaces swe-rebench-v2 pool saturation progress" test
(277–300). Add a new `it` that renders `buildSweRebenchRecord({ generatorState:
{ lastPollAt, lastPollSummary, totalPosted: 7, lastPostedInstanceId:
'astropy__astropy-14096' } })` and asserts:

- `screen.getByTestId('launcher-launched-generator-total-posted').textContent`
  is `'7'`.
- the last-posted instance id `'astropy__astropy-14096'` is rendered (by
  testid, e.g. `launcher-launched-generator-last-posted`).

Add a second assertion (or a second `it`) for the **absence** path: a
prediction.v1 record with no `totalPosted` renders `'—'` (parity guard —
prediction.v1 must not crash or show `undefined`).

Run `cd client && yarn test GeneratorPanel` → **RED** (testids don't exist yet).

### Step 6 — Render "Total posted" + recent posting activity in the panel — GREEN

File: `client/src/dashboard/spa/src/pages/launcher-launched/GeneratorPanel.tsx`

Add to the header `<dl>` (301–312, next to "Last poll") — reuse the existing
`MetaItem` component (861–883); follow the **show-don't-narrate** rule (label +
value, no caption):

```tsx
<MetaItem
  label="Total posted"
  value={record.generatorState?.totalPosted !== undefined
    ? String(record.generatorState.totalPosted)
    : '—'}
  testid="launcher-launched-generator-total-posted"
/>
<MetaItem
  label="Last posted"
  value={record.generatorState?.lastPostedInstanceId ?? '—'}
  testid="launcher-launched-generator-last-posted"
/>
```

("Last posted" = the `lastPostedInstanceId` = the "recent posting activity" the
AC asks for — the most recent instance the generator posted.) Re-run Step 5's
test → **GREEN**.

Design constraints (CLAUDE.md §Frontends / §Design System): no new custom
component (reuse `MetaItem`), no helper-text caption, no emoji, `—` for the
empty value.

### Step 7 — Update the operator-app spec (same-PR gate)

File: `client/OPERATOR-APP-SPEC.md`, §2.14 State list (379–386)

Add two bullets under **State**:

```
  - total posted (cumulative Tasks the generator has posted this process, swe-rebench-v2 only)
  - last posted instance (most recent instance id the generator posted, swe-rebench-v2 only)
```

CLAUDE.md §Frontends requires this to land in the **same PR** as the UI change.

## Verification

```bash
cd client
yarn typecheck        # zero errors — covers anchors 1–4 type additions
yarn test             # full vitest suite, all pass
```

Targeted while iterating:

```bash
cd client
yarn test launched-record-dispatcher   # Steps 1–2 (projection)
yarn test GeneratorPanel               # Steps 5–6 (UI)
yarn test launcher-endpoints solvernets-endpoints   # regression: snapshot passthrough
```

Success criteria (loop until all true):
1. `yarn typecheck` clean.
2. Dispatcher projection test asserts `totalPosted` **and** `lastPostedInstanceId` and passes (AC1).
3. GeneratorPanel test asserts the rendered "Total posted" value **and** the last-posted instance id, plus the prediction.v1 `—` absence path, and passes (AC2).
4. Full `yarn test` green — no regression in `launcher-endpoints` / `solvernets-endpoints` snapshot tests (they exercise the passthrough).
5. `OPERATOR-APP-SPEC.md` §2.14 lists both new State fields (spec gate).

## Non-goals / out of scope

- No indexer/GraphQL change — this is live in-process generator state only.
- No new notification type — `totalPosted` is pure State, no State message.
- No prediction.v1 generator instrumentation — the two fields stay
  swe-rebench-v2-only by design (parity handled by optional fields + `—`).
- No change to `withLiveGeneratorState`, the launcher `/status` gather, or the
  RPC/discovery layers.
