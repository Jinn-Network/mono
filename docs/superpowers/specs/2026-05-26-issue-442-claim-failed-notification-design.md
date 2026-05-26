# Issue #442 — wiring `claim_failed` notification from the SSE event stream

**Date:** 2026-05-26
**Shape:** `feat` (Medium / P2)
**Follow-up to:** PR #426 (Ritsu's review item #5)

## Context

`claim_failed` is one of the 12 canonical notification kinds in [`OPERATOR-APP-SPEC §2.10`](../../../client/OPERATOR-APP-SPEC.md). PR #426 wired the other 11 through the snapshot deriver (`useNotifications` → `deriveNotifications` over `/v1/status` + `/v1/bootstrap`). `claim_failed` is the lone outlier because it is **event-driven**: a claim either fails or it doesn't, and the failure is not a steady-state value any future `/v1/status` snapshot will keep reporting. The v0.1.6 dogfood operator watched 17/17 then 26/26 consecutive claim failures with zero UI signal — that is the gap this issue closes.

Server-side, claim failures today go through `emitEvent(store, { kind: 'tick_error', outcome: 'failed', requestId, ... })` in `client/src/daemon/daemon.ts:579` (and the mech adapter's `claimDelivery failed` path). `emitEvent` writes to the SQLite activity table; it does **not** push into the `/v1/events` SSE ring buffer (`emitStructured` in `client/src/events/emitter.ts`). The SSE stream's existing `error` kind is reserved for loop-crash errors, not per-task failures. So before the SPA can listen for `claim_failed`, the daemon has to emit one. The SSE event vocabulary (`StructuredEventKind = 'intent' | 'reward' | 'fleet' | 'system' | 'error' | 'log'`) does not need to grow — we tag the event with `kind: 'intent'`, `errorCode: 'claim_failed'`, and `requestId` set; the SPA filters on `errorCode`.

## Approach

**Server-side (daemon).** Add a paired `emitStructured({ kind: 'intent', message: ..., requestId, errorCode: 'claim_failed', details: { taskId, reason } })` call alongside the existing `emitEvent(... 'tick_error', outcome: 'failed' ...)` at the daemon's claim site (`client/src/daemon/daemon.ts` around line 579) and at the mech adapter's `claimDelivery failed` site (`client/src/adapters/mech/adapter.ts:1178`). Activity-DB writes are kept — they're the durable record. SSE is the operator-app signal channel. We do **not** broaden `StructuredEventKind`; `'intent' + errorCode: 'claim_failed'` is the discriminator, consistent with how the SSE stream already uses `errorCode` (e.g. `peer_sync_crashed`, `engine_tick_crashed`).

**Client-side (SPA).** Compose into the existing `useNotifications` rather than spawn a parallel pipeline. Add a third source to the hook, alongside the snapshot deriver and the disconnected-branch short-circuit:

1. Subscribe to `useEventStream(['intent'])` inside `useNotifications`.
2. Filter the returned events for `errorCode === 'claim_failed'`.
3. Filter again on a recent window — events whose `ts` is older than `now - 30min` are dropped. The clock is **wall-clock against the event's own `ts`**, not against first mount. Honest reason: an operator who refreshes the dashboard 25 minutes after a burst of claim failures wants to still see them; an operator who opens the dashboard a week later does not. Mount-relative windows lie about both.
4. If any survive, append a single aggregated `OperatorNotification` of kind `claim_failed`, severity `warning`, with `message` = `"N claim attempts failed in the last 30 minutes. Check Tasks for details."` and `jumpTo: '/operator/tasks'` (or whichever route hosts the per-request activity log; verify at plan time). One notification per recent burst — not one per failed event — so the surface stays scannable when failures arrive in floods like the dogfood 26/26.
5. Re-evaluate on each event-stream update and on a wall-clock tick (e.g. 60s `setInterval` re-render) so a notification ages out automatically when its underlying events fall outside the 30-min window.

The event stream's built-in 50-event backfill on SSE connect (see `events-endpoint.ts:37`) covers the page-reload case for free — no need to hit `/v1/events/recent` separately on mount, because `useEventStream` already replays via the SSE backfill.

## Key trade-offs

- **New SSE event kind vs. reusing `'intent' + errorCode`.** Considered adding `'claim'` to `StructuredEventKindSchema`. Rejected: the existing SSE vocabulary uses `errorCode` as the per-kind discriminator throughout (`peer_sync_crashed`, `engine_tick_crashed`, `creator_crashed`). A new top-level kind would set a precedent of one-kind-per-notification, which scales badly — every future event-driven notification would need its own enum entry. The SPA filter cost is negligible.
- **Wall-clock-from-event-`ts` vs. wall-clock-from-first-mount window.** Chose event-`ts`. A mount-relative window pretends old failures are recent just because the SPA was just opened; it inflates the perceived freshness of stale evidence. Event-relative windows match how a human would honestly answer "is this still happening?". Costs a `setInterval` re-render to age out — cheap.
- **Aggregated single notification vs. one-per-failed-claim.** Aggregated. The dogfood case is 26/26 failures within minutes; rendering 26 stacked notification rows would be hostile. The aggregation hides per-event detail, but that detail belongs in `§2.6 Tasks` (the activity log surface), which the `jumpTo` resolves to. Notifications are the "something is wrong" surface; the activity log is the "what exactly" surface.
- **Dedup state inside `useNotifications` vs. external store.** Kept inline. `useEventStream` already maintains the last-500 events in component state and dedupes by SSE `id`. `useNotifications` doesn't need its own dedup — it derives off `events` each render. No new persistent state.
- **Subscribing to all SSE kinds vs. filtering server-side via `?kinds=intent`.** Filter via `useEventStream(['intent'])`. The `LoadingScreen` consumer already subscribes unfiltered; adding a second EventSource against `?kinds=intent` is fine (browsers cap at six per origin, we're using two). This keeps `useNotifications` from re-rendering on every `'log'` event.
- **Reusing `tick_error` vs. coining `claim_failed`.** Considered just listening for `tick_error`. Rejected because `tick_error` is broader than claim failures (any engine.process exception emits it), and the spec names the notification `claim_failed`. The `errorCode` is the contract — it has to say `claim_failed` for the SPA filter to be honest.
- **§3.4 derived-not-durable check.** Notifications must be recomputed from current state, not persisted. The recent-window-over-SSE-events approach satisfies this: on SPA reload the SSE backfill replays the last 50 events, the 30-min filter re-evaluates against current wall clock, and the same notification re-emerges (or doesn't). No durable client-side store. The "underlying state" for `claim_failed` is the event ring buffer, which is itself in-memory and re-derived on daemon restart — consistent with §3.4.

## Acceptance criteria mapping

- **(a) `claim_failed` appears as a notification when emitted via SSE.** The daemon emits `emitStructured({ kind: 'intent', errorCode: 'claim_failed', ... })` at the claim-failure site; `useNotifications` subscribes to `useEventStream(['intent'])`, filters on `errorCode === 'claim_failed'`, and appends an `OperatorNotification` of kind `claim_failed` when at least one event survives the recent-window filter.
- **(b) Old events outside the recent window don't surface.** The filter is `eventTs >= now - 30min`, evaluated against `e.ts` (wall clock against the event's own ISO timestamp, not mount time). A 60s re-render tick ages stale events out without requiring a new SSE message. Page-reload behavior is honest: SSE backfill replays old events, the window filter drops the ones outside 30 min, so a dashboard opened tomorrow does not surface yesterday's claim failures.
- **(c) Snapshot-derivable kinds still work unchanged.** `useNotifications` keeps its existing `useQuery(['status'])` / `useQuery(['bootstrap'])` + `deriveNotifications` pipeline intact. The new `claim_failed` source is appended to the deriver's output, then the combined list is sorted by severity. No changes to `derive.ts`, `taxonomy.ts`, or the disconnected-branch short-circuit. The pure-deriver tests (`derive.test.ts`) continue to cover 11 kinds; the hook tests (`useNotifications.test.tsx`) grow a new case for the event-driven 12th kind with a mocked `useEventStream`.

## Notes for the plan stage

- Test scaffolding: `useNotifications.test.tsx` already mocks `useEventStream` for `App.routing.test.tsx`; reuse that pattern. New test cases: (i) emits `claim_failed` when one matching SSE event arrives, (ii) does not emit when the only matching event has `ts` older than 30 min, (iii) aggregates multiple recent failures into one notification with a count.
- Daemon-side test: add a smoke test that exercises the claim-failure path in `daemon.ts` and asserts a `claim_failed`-tagged structured event lands in the ring buffer. The existing `emitEvent(tick_error)` assertion stays.
- BRAND voice check: notification copy is "N claim attempts failed in the last 30 minutes. Check Tasks for details." — plain, no emoji, no metaphor. Severity `warning` (not `blocking`) because claim failures are recoverable and the daemon retries automatically; an operator can keep using the app.
- No shadcn-component decisions implied — `NotificationItem` already renders the canonical kinds via the existing severity ramp.
