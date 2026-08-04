/**
 * The daemon lifecycle-event vocabulary, as a plain zod-free array
 * (spec/2026-08-04-headless-operator-rederivation-design.md §8 artifact 6).
 *
 * Split out of `lifecycle-kind.ts` (M3, PR #2419 review): importing any VALUE from that
 * module — even just this array — pulled `zod/v4` into the operator dashboard SPA's bundle,
 * because ES module evaluation runs a module's whole top level (including its
 * `z.enum(...)`/`z.looseObject(...)` schema construction) the moment any one of its exports
 * is value-imported, regardless of which export is actually used. The SPA's `event-kinds.ts`
 * only ever needed the bare array; it never needed the Zod schema built from it. This module
 * has zero imports, so importing it can never drag in zod (or anything else).
 *
 * `lifecycle-kind.ts` imports this for its `z.enum(LIFECYCLE_KINDS)`; the SPA's
 * `event-kinds.ts` imports this directly instead.
 */
export const LIFECYCLE_KINDS = [
  'task_posted',
  'intent_registry_failed',
  'request_claimed',
  'delivery_submitted',
  'evaluation_submitted',
  'reward_claimed',
  'balance_topup',
  'engine_transition',
  'corpus_knowledge',
  'tick_error',
  'race_lost',
  'spend_cap_reached',
  'ai_units_cap_reached',
  'startup',
  'shutdown',
  'harvest_admitted',
] as const;

export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];
