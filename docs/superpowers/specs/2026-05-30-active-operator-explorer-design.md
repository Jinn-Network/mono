# Active-operator surface in the network explorer

- **Version:** 0.1
- **Date:** 2026-05-30
- **Author:** Oak (drafted with Claude)
- **Status:** Proposed
- **Related:** [Milestone 1 tracker (#605)](https://github.com/Jinn-Network/mono/issues/605), [client/scripts/check-milestone-1.ts](../../../client/scripts/check-milestone-1.ts), [packages/indexer/explorer](../../../packages/indexer/explorer)

## Purpose

Make per-operator activity legible from the network explorer so progress against Milestone 1 (48h of paired settlement) can be read at a glance, without running `check-milestone-1.ts`.

Two surfaces, one definition:

1. `OperatorsView` (`/operators`) — a big stat at the top of the card showing the count of currently-active operators, and a new `Active?` column on the roster table with `Yes`/`No` chips.
2. `NetworkView` (`/network`) — the existing "Active operators" cell, which today reads ever-attempted distinct addresses, switches to the same canonical definition.

Both surfaces share one definition, surfaced verbatim via a tooltip on each.

## Canonical definition

**Active operator:** earned ≥3 tJINN in **each** of the **last 8 UTC-aligned 6-hour blocks** (boundaries 00:00, 06:00, 12:00, 18:00 UTC). The currently-running 6-hour block is **excluded** — only completed blocks count.

This is the per-operator analogue of the Milestone 1 gate. The in-progress block is excluded for the same reason the milestone script excludes it: an operator could spin back up in the last minute of a block and otherwise be counted as having "passed" it. The window is anchored at the most-recent completed 6-hour boundary; an operator's activity status is therefore stable for up to 6 hours.

This definition is **canonical** for the word "active" everywhere in the explorer. There is no second definition.

## Backend

### Schema

[`packages/indexer/ponder.schema.ts`](../../../packages/indexer/ponder.schema.ts) — extend the `rewardDistribution` table:

```ts
claimedAtTimestamp: t.bigint().notNull(),
```

`event.block.timestamp` is already available to the handler. One full reindex required; the column is cheap, monotonic, and trivially backfilled by re-running indexing against the same events.

### Indexing handler

[`packages/indexer/src/handlers.ts`](../../../packages/indexer/src/handlers.ts) `handleClaimed` — write `event.block.timestamp` into the new column on insert. Single-line change.

### Shared util

New file `packages/indexer/src/api/active-operators.ts`:

```ts
export const BLOCK_SECONDS = 6 * 3600;
export const BLOCK_COUNT = 8;
export const REQUIRED_TJINN_PER_BLOCK = 3n * 10n ** 18n;

export interface ActiveWindow {
  startTs: number;
  endTs: number;
  blockSeconds: number;
  blockCount: number;
  requiredTjinnPerBlock: bigint;
}

export function computeActiveWindow(nowSec: number): ActiveWindow;

export function computeActiveOperators(
  rewards: Array<{ multisig: string; operatorMinted: bigint; claimedAtTimestamp: number }>,
  nowSec: number,
): {
  window: ActiveWindow;
  active: Set<string>;
  perOperator: Map<string, { blocksQualified: number }>;
};
```

Pure functions. No I/O. Easy to unit test. `check-milestone-1.ts` can adopt the same util in a follow-up; that adoption is **out of scope** for this spec.

### `GET /explorer/operators`

[`packages/indexer/src/api/explorer.ts`](../../../packages/indexer/src/api/explorer.ts) `/operators` handler — new fields on the response:

- Top-level `activeOperators: number` — count of distinct active multisigs across the whole reward-distribution table (not just operators in `ranked`/`lowVolume`).
- Per-row `active: boolean` on every `ranked` and `lowVolume` row — true iff that operator's address (joined as `attempt.operator` ↔ `rewardDistribution.multisig`, matching the existing `jinnEarned` join) is in the active set.
- Top-level `activeWindow`:

  ```json
  {
    "startTs": 1748563200,
    "endTs": 1748736000,
    "blockSeconds": 21600,
    "blockCount": 8,
    "requiredTjinnPerBlock": "3000000000000000000"
  }
  ```

  This exposes the definition as server-truth so the SPA renders the tooltip dates without any client-side date arithmetic.

### `GET /explorer/network`

[`packages/indexer/src/api/explorer.ts`](../../../packages/indexer/src/api/explorer.ts) — add `activeOperators: number` and `activeWindow` (same shape as above) to the response. The existing `distinctOperators` field is renamed to `everAttemptedOperators` to remove the "two things called active" footgun.

`distinctOperators` is a breaking response change for any external consumer reading `/explorer/network`. Internal consumers (the SPA) are updated in the same PR. External consumers are not believed to exist; if any surface during review they get a one-line note in the PR.

## Frontend

### `OperatorsView`

[`packages/indexer/explorer/src/views/OperatorsView.tsx`](../../../packages/indexer/explorer/src/views/OperatorsView.tsx):

- **Big stat strip above the roster.** A single `Card` matching the design system, eyebrow `ACTIVE OPERATORS` (mono caps), value `data.activeOperators` in the page's display type, accompanied by a `?` glyph that opens the definition tooltip.
- **New `Active?` column** between `Operator` and `Attempts`. Cell shows `Yes` in `--vow-green` or `No` in `--break-red`. Header has the same `?` tooltip affordance.

### `NetworkView`

[`packages/indexer/explorer/src/views/NetworkView.tsx`](../../../packages/indexer/explorer/src/views/NetworkView.tsx) — `ActivityStrip` cell `Active operators` switches its source from `data.distinctOperators` to `data.activeOperators`. Same tooltip affordance on the cell label.

### Tooltip primitive

New `packages/indexer/explorer/src/components/InfoTooltip.tsx` — a click-to-toggle popover anchored to a `?` glyph, dismissed via the existing `useDismissOnOutsideClick` hook. Same interaction model as `AddFilterPopover`. Body content:

> Earned ≥3 tJINN in each of the last 8 completed UTC 6-hour blocks. The in-progress block is excluded.
> Window: `<startTs>` → `<endTs>` (UTC).

Dates rendered from `activeWindow.startTs` / `activeWindow.endTs` via `Date.prototype.toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC')`. No `Intl.DateTimeFormat` localisation — UTC always, to match the definition.

## Edge cases

- **Operator on chain <48h.** Renders `No`. By the canonical definition this is correct — they have not demonstrated uptime over the window — and the gate does not care why. The tooltip's window dates make this self-explanatory.
- **No distributions in window.** `activeOperators = 0`. Every row's `Active?` is `No`. Big stat shows `0`.
- **Multisig vs operator address.** `rewardDistribution.multisig` joins to `attempt.operator` per the schema comment at [`ponder.schema.ts`](../../../packages/indexer/ponder.schema.ts) line 212. The active set is keyed by multisig; the per-row `active` boolean is keyed by `attempt.operator`. We use the same join the existing `jinnEarned` field uses — no new identity surface.
- **Operator with rewards but no attempts.** The `/operators` response only includes operators that appear in `ranked` or `lowVolume`, both derived from `attempt`. An operator that claimed tJINN without any attempt rows would not appear. This is structurally impossible (a claim requires a prior `SolutionDeliveryClaimed`), so it is not handled.
- **Clock skew between indexer and client.** All math runs server-side off `claimedAtTimestamp` (block timestamp from chain) and `Date.now()` (indexer host). The window is anchored to the most-recent completed 6-hour boundary, so up to 6 hours of skew on either side is absorbed without changing the result.

## Testing

- **`active-operators.test.ts`** (new) — pure-function unit tests covering: empty window, all-eight-blocks-clear, exactly-3-tJINN boundary (≥, not >), multiple claims within one block summing, eight-blocks-minus-one (operator misses the oldest block), eight-blocks-minus-one (operator misses the newest completed block), in-progress-block exclusion, claims older than the window dropped.
- **`explorer.test.ts`** — extend the `/operators` route test to assert `activeOperators`, `activeWindow`, and per-row `active` against a fixture; extend the `/network` route test to assert `activeOperators` and the rename of `distinctOperators` → `everAttemptedOperators`.
- **`OperatorsView.test.tsx`** — extend to assert the big stat renders the number, the `Active?` column header is present with its tooltip affordance, and rows render `Yes` / `No` correctly given fixture data.
- **`NetworkView.test.tsx`** — assert the cell reads `activeOperators` and that the rename of `distinctOperators` is reflected.

## Out of scope

- Backfilling `check-milestone-1.ts` to use the new shared util. Separate `refactor` PR.
- Per-operator drill-down on which of the eight blocks they cleared (the `/operator/:addr` detail page). Possible follow-up if the binary `Yes`/`No` proves too coarse in practice.
- Any change to the canonical Milestone 1 definition itself. The definition above is descriptive, not normative.
- Multi-program activity (the canonical definition is `rewardDistribution` table-wide; staking-program scoping is intentionally not modelled here).
