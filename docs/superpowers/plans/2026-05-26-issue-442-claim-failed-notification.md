# Plan — Issue #442: wire `claim_failed` notification from the SSE event stream

**Date:** 2026-05-26
**Shape:** `feat` (Medium / P2)
**Design note:** [`docs/superpowers/specs/2026-05-26-issue-442-claim-failed-notification-design.md`](../specs/2026-05-26-issue-442-claim-failed-notification-design.md)
**Issue:** [#442](https://github.com/Jinn-Network/mono/issues/442)
**Follow-up to:** PR #426 (Ritsu's review item #5)

## 1. Goal

`claim_failed` is the lone notification kind (out of 12 in OPERATOR-APP-SPEC §2.10)
not currently wired in the SPA, because it is event-driven — there is no
steady-state field a future `/v1/status` snapshot will keep reporting, so the
existing snapshot deriver (`useNotifications` → `deriveNotifications`) cannot
surface it. The v0.1.6 dogfood operator watched 17/17 then 26/26 consecutive
claim failures with zero UI signal. Success means: when the daemon's task-claim
path or the mech adapter's delivery-claim path fails, a single
**`kind: 'intent', errorCode: 'claim_failed'`** structured event lands in the
`/v1/events` SSE ring buffer; the SPA's `useNotifications` hook subscribes to
that stream, filters by `errorCode === 'claim_failed'` AND wall-clock
`event.ts >= now - 30 minutes`, and emits a single aggregated
`OperatorNotification` (severity `warning`, `jumpTo: '/overview'`) summarising
the burst. The existing snapshot-derived 11 kinds remain unchanged; the SSE
event-kind enum is **not** broadened. The "what exactly failed" detail is in
the activity log (Tasks region on Overview) where the operator clicks through.

## 2. File-by-file changes

### Server-side (daemon)

- **`client/src/adapters/mech/adapter.ts`** — add `emitStructured` import
  alongside existing imports; in the `claimDelivery failed` catch branch at
  **line 1178** (immediately before `return 'retry';`), call
  `emitStructured({ kind: 'intent', message, requestId, errorCode: 'claim_failed', details: { kind: claimOptions.kind, source: 'mech.claimDelivery', error } })`.
  Do **not** emit when the early branches return `'skipped'` (RequestNotFound)
  or `'already-claimed'` — those are not failures. Keep the
  `console.error(...)` line and the existing `return 'retry'` semantics
  untouched.

- **`client/src/daemon/daemon.ts`** — `emitStructured` is already imported
  (line 20). In the `claimTask` catch branch at **line 579**, add a paired
  `emitStructured({ kind: 'intent', message: 'Task claim failed', requestId: taskAnnouncement.taskId, errorCode: 'claim_failed', details: { taskId: taskAnnouncement.taskId, solverType, source: 'daemon.claimTask', error: err instanceof Error ? err.message : String(err) } })`
  immediately after the existing `emitEvent(... 'tick_error' ...)` call (which
  stays — the activity-DB row is the durable record; SSE is the signal
  channel). Do **not** touch the engine.process / engine.observe failure paths
  at lines 628/638 — those are downstream execution failures, not claim
  failures, and the spec scopes `claim_failed` to the claim path only.

### Client-side (SPA)

- **`client/src/dashboard/spa/src/notifications/useNotifications.ts`** —
  extend the hook to derive a third notification source from the SSE event
  stream:
  1. Import `useEventStream` from `../api/events.js` and `StructuredEvent`
     from `../api/types.js`.
  2. Inside the hook (after the existing `useQuery` calls), subscribe via
     `const { events } = useEventStream(['intent'])`. Filter server-side to
     `intent` so the hook does not re-render on every `log` event.
  3. Add a wall-clock tick: `const [nowMs, setNowMs] = useState(Date.now());`
     and a `useEffect` that calls `setNowMs(Date.now())` every 60s to age
     stale events out.
  4. Compute a `claimFailedNotice: OperatorNotification | null` inside the
     `useMemo` (or a sibling `useMemo` keyed on `events` and `nowMs`):
     - Filter `events` to those with `kind === 'intent'` AND
       `errorCode === 'claim_failed'`.
     - Filter again with `new Date(e.ts).getTime() >= nowMs - 30 * 60 * 1000`.
     - If at least one survives, build a single notice:
       ```
       { kind: 'claim_failed', severity: 'warning',
         message: `${n} claim attempt${n === 1 ? '' : 's'} failed in the last 30 minutes. Check Tasks for details.`,
         jumpTo: '/overview',
         details: { count: n, sinceMs: nowMs - 30 * 60 * 1000 } }
       ```
     - Otherwise `null`.
  5. Append the notice (if non-null) to the deriver's output before the
     severity sort; the existing `SEVERITY_ORDER` sort orders it correctly
     against blocking/info siblings. The disconnected-branch short-circuit
     is untouched (claim failures are not surface-worthy when the daemon is
     unreachable — `rpc_unreachable` dominates).
  6. Update the `useMemo` dependency array to include `events` and `nowMs`.

- **`client/src/dashboard/spa/src/notifications/useNotifications.test.tsx`** —
  add the `useEventStream` mock alongside the existing `connection-state` /
  `RestartPendingContext` / `api/client` mocks; replicate the
  `App.routing.test.tsx` pattern (`vi.mock('../api/events.js', () => ({ useEventStream: vi.fn(() => ({ events: [], connected: false })) }))`).
  Expose the mock through `vi.hoisted` so individual tests can override the
  returned `events`.

### Tests added

- `client/src/dashboard/spa/src/notifications/useNotifications.test.tsx` —
  three new cases (see §3 below).
- `client/test/daemon/claim-failed-emit.test.ts` — new daemon-side
  integration test exercising the real `Daemon` claim path against a
  `LocalAdapter` stub whose `claimTask` throws, asserting the SSE ring
  buffer receives a `kind: 'intent', errorCode: 'claim_failed'` event AND
  the activity table receives the `tick_error` row (proves the two writes
  are paired, not swapped).

## 3. Step-by-step task list

Tests precede implementation per handbook rule 7 (feat = TDD). The daemon-side
smoke test uses the real ring buffer (handbook rule 6 — integration over
mocks on contract surfaces).

### Step 1 — daemon-side: write the failing integration test

- **File:** `client/test/daemon/claim-failed-emit.test.ts` (new).
- Mirror the pattern from `client/test/daemon/daemon.test.ts` (real `Daemon`,
  `minimalEngineConfig`, `:memory:` DB) and `client/test/api/events-endpoint.test.ts`
  (`getEventBuffer().clear()` in `beforeEach`, then `.snapshot()` after).
- Use a tiny subclass / wrapper of `LocalAdapter` whose `claimTask` rejects
  with `new Error('forced claim failure')`. Post a task via `postTask` and
  wait briefly (poll the ring buffer with a short timeout, ~1s) for the
  structured event.
- Assertions:
  1. `getEventBuffer().snapshot({ kinds: ['intent'] })` includes at least
     one event with `errorCode === 'claim_failed'` and `requestId` equal to
     the posted task's id.
  2. The activity table (read via `db.prepare('SELECT * FROM activity_events ...')`
     or the equivalent store accessor) contains a `tick_error` row for the
     same `requestId` — confirming the two writes are paired.
- **Expect:** test fails on `main`/branch-head because the
  `emitStructured(claim_failed)` call does not yet exist. Run
  `yarn test client/test/daemon/claim-failed-emit.test.ts` to confirm
  red.

### Step 2 — daemon-side: implement the emitter call

- **File:** `client/src/daemon/daemon.ts`.
- Immediately after the existing `emitEvent({ kind: 'tick_error', ... })`
  call at line ~579 (inside the `try { request = await this.adapter.claimTask(...) } catch (err) { ... }`
  block), add:
  ```ts
  emitStructured({
    kind: 'intent',
    message: 'Task claim failed',
    requestId: taskAnnouncement.taskId,
    errorCode: 'claim_failed',
    details: {
      taskId: taskAnnouncement.taskId,
      solverType,
      source: 'daemon.claimTask',
      error: err instanceof Error ? err.message : String(err),
    },
  });
  ```
- Re-run the Step 1 test — green.

### Step 3 — daemon-side: mech adapter emitter call

- **File:** `client/src/adapters/mech/adapter.ts`.
- Add the `emitStructured` import:
  `import { emitStructured } from '../../events/emitter.js';`
- Inside the outer `catch (err)` at line ~1169, **after** the `RequestNotFound`
  and `already.*claimed` early-return branches and **before** the final
  `console.error(...)` + `return 'retry'`, add:
  ```ts
  emitStructured({
    kind: 'intent',
    message: 'Delivery claim failed',
    requestId,
    errorCode: 'claim_failed',
    details: {
      kind: claimOptions.kind,
      source: 'mech.claimDelivery',
      error: message,
    },
  });
  ```
- Extend Step 1's test (or add a paired test in the same file) to also
  exercise the mech-adapter site — only if it can be done without standing
  up an Anvil fork. If a unit-level invocation of the mech-adapter's
  `claimDelivery` private flow is impractical from a vitest harness, leave
  the mech-side coverage to the existing daemon-harness e2e
  (`yarn e2e:daemon-harness`); document the decision in the test comment.
  The unit assertion that matters for issue #442 is that the SSE event
  lands when the claim catch block fires — that contract is covered by
  Step 1 against the `LocalAdapter` path.

### Step 4 — SPA-side: write failing hook tests

- **File:** `client/src/dashboard/spa/src/notifications/useNotifications.test.tsx`.
- Add the `useEventStream` mock at the top of the file using `vi.hoisted`
  so individual tests can override `events`:
  ```ts
  const eventsMock = vi.hoisted(() => ({
    useEventStream: vi.fn(() => ({ events: [], connected: false })),
  }));
  vi.mock('../api/events.js', () => eventsMock);
  ```
- Add three new test cases (each fails because the hook does not yet emit
  `claim_failed`):

  - **4a.** `emits a single claim_failed notification when a recent intent event with errorCode=claim_failed arrives`.
    Set `eventsMock.useEventStream.mockReturnValue({ events: [<one fresh event>], connected: true })`.
    Assert `result.current` contains exactly one item with
    `kind: 'claim_failed'` and `severity: 'warning'`.

  - **4b.** `does not emit claim_failed when the only matching event is older than 30 minutes`.
    Supply one event with `ts` set to `new Date(Date.now() - 31 * 60 * 1000).toISOString()`.
    Assert `result.current.map(n => n.kind)` does **not** include
    `'claim_failed'`.

  - **4c.** `aggregates multiple recent claim_failed events into a single notification with the count in the message`.
    Supply three events within the last 5 minutes.
    Assert exactly one notice with `kind: 'claim_failed'`, and that
    `message` contains the substring `'3 claim attempt'`.

- Run `yarn test src/dashboard/spa/src/notifications/useNotifications.test.tsx`
  — **expect red** on all three.

### Step 5 — SPA-side: implement `useNotifications` extension

- **File:** `client/src/dashboard/spa/src/notifications/useNotifications.ts`.
- Implement the changes described in §2 (imports, `useEventStream(['intent'])`
  subscription, 60s wall-clock tick state, recent-window filter,
  aggregated-notice construction, append-before-sort, dep-array update).
- Re-run Step 4 tests — green.

### Step 6 — SPA-side: existing-test smoke check

- Re-run the entire `useNotifications.test.tsx` suite to confirm the
  pre-existing four cases (severity ordering, rpc_unreachable
  short-circuit, sparse-shape adapter, no-claim-from-collector-rewards)
  still pass — they should, because the new `events` source defaults to
  `[]` (no `claim_failed` notice emitted) and the existing branch
  semantics are untouched.
- Re-run `client/src/dashboard/spa/src/App.routing.test.tsx` (already
  mocks `useEventStream`) — still green.

### Step 7 — wall-clock tick test (optional but recommended)

- In `useNotifications.test.tsx`, add a small fake-timer test that supplies
  one fresh event, asserts the notice is present, advances `vi.useFakeTimers()`
  by 31 minutes, calls `act(() => vi.advanceTimersByTime(60_000))` to fire
  the 60s tick, and re-asserts the notice has aged out.
- If the fake-timer interaction proves brittle inside `renderHook`, drop
  this case and document in a comment why ageing-out is covered only by
  case 4b. The static 30-min filter is the load-bearing assertion; the
  60s re-render only governs "when does an idle dashboard re-evaluate" —
  not correctness.

### Step 8 — verification gates

Run the gate commands listed in §5 below. If any fails, fix and re-run.
Do not skip.

## 4. Acceptance criteria checklist

Mapping back to the design note's three criteria:

- [ ] **(a) `claim_failed` appears as a notification when emitted via SSE.**
  - Covered by Steps 2 + 5 + Test 4a.
  - Step 2 makes the daemon emit the structured event; Step 5 makes the
    hook react to it; Test 4a is the unit assertion that the hook surfaces
    one `claim_failed` notice from one matching event. The Step 1
    integration test additionally proves the daemon end of the contract
    against the real ring buffer.

- [ ] **(b) Old events outside the recent window don't surface.**
  - Covered by Step 5 + Test 4b (and optionally Step 7).
  - The filter `new Date(e.ts).getTime() >= nowMs - 30 * 60 * 1000` is
    evaluated against the event's own `ts` (wall-clock honest, not
    mount-relative). The 60s tick in Step 5 ages stale events out on an
    idle dashboard. Step 7 (if kept) covers the timer mechanism; Test 4b
    covers the filter logic statically.

- [ ] **(c) Snapshot-derivable kinds still work unchanged.**
  - Covered by Step 5 + Step 6 (regression run).
  - `deriveNotifications`, `derive.ts`, `taxonomy.ts`, and the
    disconnected-branch short-circuit are not touched. The four
    pre-existing `useNotifications.test.tsx` cases must remain green.
    `App.routing.test.tsx` (which already mocks `useEventStream`) must
    remain green.

## 5. Verification gates

Run from `client/`:

```bash
yarn typecheck                                          # zero TS errors
yarn test                                               # full vitest suite (daemon + SPA)
yarn test client/test/daemon/claim-failed-emit.test.ts # focused: daemon-side integration test (green)
yarn test src/dashboard/spa/src/notifications          # focused: hook tests (all 7 cases green)
yarn build                                              # tsc + SPA bundle into dist/dashboard succeeds
```

Optional smoke (manual, only if there's a live daemon available — not
required for PR readiness):

```bash
# Terminal 1: run the daemon against Anvil per CLAUDE.md "Running against Anvil"
# Terminal 2: tail SSE and assert one claim_failed event after forcing a claim failure
curl -N http://127.0.0.1:7331/v1/events?kinds=intent
```

The SPA bundle test is the most likely-to-break gate (the SPA build is
included in `yarn build` and runs `tsc -b && vite build` under the hood);
keep the `useEventStream` import path stable (`../api/events.js`) and the
`StructuredEvent` type import stable (`../api/types.js`) to avoid drift.

## 6. Out of scope (do not pile in)

- No changes to `derive.ts`, `taxonomy.ts`, `severity.ts`, or
  `NotificationItem.tsx` — the existing severity ramp renders any
  `CanonicalKind` (`claim_failed` is already in the canonical list at
  taxonomy.ts:15).
- No new SSE event kind. `intent + errorCode: claim_failed` is the
  discriminator, consistent with `peer_sync_crashed`, `engine_tick_crashed`,
  `creator_crashed`, etc.
- No persistent dedup store. `useEventStream` already maintains last-500
  events in component state and dedupes by SSE `id`.
- No second EventSource. Reuse the existing one created by
  `useEventStream(['intent'])`; the browser six-per-origin limit is
  comfortably respected (LoadingScreen + useNotifications = 2).
- No dismiss action. Per OPERATOR-APP-SPEC §3.4 (notifications are derived,
  not durable), dismissal is a UI gesture not yet implemented for *any*
  notification; out of scope for #442.
- The downstream `engine.process` / `engine.observe` failure paths at
  daemon.ts:628/638 stay on `tick_error` only. They are post-claim
  execution failures, not claim failures.

## 7. Estimated shape

- Daemon emitter change: ~10 LoC across two files plus 1 import.
- SPA hook change: ~25 LoC + 1 effect.
- Tests: ~80 LoC across one new daemon test file and three new SPA test
  cases (plus optional Step 7).
- One commit per logical step is fine; squash on merge.
