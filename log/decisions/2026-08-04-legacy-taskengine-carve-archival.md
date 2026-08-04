---
id: DR-2026-08-04
title: Retire the TaskEngine carve as a runtime export; keep its disposition table as archived design history
date: 2026-08-04
verb: Decide
status: ratified
authors: Claude Sonnet (implementation), repository operator (explicit implementation instruction, D0f)
spec: docs/superpowers/specs/2026-07-28-marketplace-binding-design.md §9
relates-to: DR-2026-08-03 (Phase C capability boundaries — moved marketplace-pipeline to legacy-product-lines); architecture/transitions/phase-d-native-operator.v1.json (`legacy-taskengine-carve` transition)
---

## Context

`packages/marketplace/pipeline/src/carve.ts` shipped `TASK_ENGINE_CARVE` (and its FAILED-cause
sibling `TASK_ENGINE_FAILED_CARVE`) as documentation-as-code: a state → owner map asserting the
marketplace binding design's §9 disposition of the legacy daemon's `TaskEngine` states —

| State(s) | Goes to |
| --- | --- |
| DISCOVERED, CLAIMED, WAITING | Pipeline |
| PRE_SNAPSHOT, RUNNING, POST_SNAPSHOT | Embedded local backend |
| PACKAGING | Embedded backend (seals the marketplace-profile Delivery) |
| DELIVERING, COMPLETE | Binding |
| AWAITING_ADOPTION, CLAIMING_DELIVERY | Application (Autopilot) |
| RACE_LOST | Binding (kept off failure counters) |
| FAILED | Split by cause: backend-side → embedded backend terminal; venue-side → binding |

— drift-guarded by `carve.test.ts` so the map couldn't silently diverge from the design while the
live daemon cutover remained out of scope (the marketplace binding plan's Task M6.3 built it as a
library assertion, never a live migration).

The `legacy-taskengine-carve` entry in `architecture/transitions/phase-d-native-operator.v1.json`
tracked this as a Phase D-closable transition: its zero-definition was "no runtime source outside
marketplace-pipeline references a TaskEngine carve constant," and its sunset condition required
both zero runtime consumers and an archived decision record. Grepping the repository confirmed the
zero claim — every reference to `TASK_ENGINE_CARVE` outside `packages/marketplace/pipeline/` was
either this transition's own deletion-test string check, or prose in the (dated, unedited) marketplace
binding plan document. No product, native, or client source imported the constant; the migration
mechanics session that would have consumed it as a live cutover input never started, so the export
never gained a runtime consumer.

## Decision

1. Delete the runtime export. `packages/marketplace/pipeline/src/carve.ts` and its dedicated
   `carve.test.ts` are removed; `TASK_ENGINE_CARVE`, `TASK_ENGINE_FAILED_CARVE`,
   `carveOwnerForFailed`, `TaskEngineCarveState`, and the now-unused `CarveOwner` /
   `TaskEngineFailedCause` types are dropped from `src/index.ts`'s public surface and from
   `src/types.ts`.
2. Archive the rationale here instead of in source. The §9 disposition table is design history;
   the marketplace binding design document (`docs/superpowers/specs/2026-07-28-marketplace-binding-design.md`
   §9, a frozen interface per its §11.11) remains the citable source of the table itself. This
   record exists so the decision to retire the runtime copy — and why it was safe to retire — has
   a durable, non-code home.
3. Flip `legacy-taskengine-carve` to `status: "deleted"` with an empty `consumers` array in the
   Phase D transition manifest.

## Consequences

- `packages/marketplace/pipeline`'s public surface loses four runtime exports and one exported
  type; `packages/marketplace/pipeline/README.md`'s public-surface list and package description
  drop the carve line.
- The design's §9 disposition table is no longer asserted by a running test. If the live daemon
  TaskEngine cutover resumes, whoever performs it should re-derive the disposition directly from
  the design document (or a follow-on migration-mechanics spec), not from this deleted module.
- `.github/scripts/phase-d-transition-deletion.test.mjs`'s "TaskEngine carve is present only while
  its transition remains active" assertion now enforces absence instead of presence.

## Alternatives rejected

- **Leave the export in place until the migration-mechanics session lands.** The transition's own
  zero-definition was already satisfied — waiting on a session with no scheduled start date holds
  a dead export in the public surface indefinitely for no observed benefit.
- **Move the table into a shared package instead of deleting it.** No second consumer exists to
  justify a shared home; the design document already is the disposition's canonical location.

## Ratification

Ratified on 2026-08-04 by the operator's explicit instruction to close the
`legacy-taskengine-carve` transition (D0f). This record freezes the archival decision; a future
live TaskEngine cutover needs its own design work, not a revival of the deleted module.
