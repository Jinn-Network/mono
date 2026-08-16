/**
 * The unified fleet bootstrap phase list, as a plain zero-import array
 * (issue #2407, spec §5/§11; absorbed into the contract in
 * spec/2026-08-04-headless-operator-rederivation-design.md §8 during the wp-bootstrap merge).
 *
 * `operator/src/earning/fleet-bootstrap-phase.ts` used to derive this from
 * `ServiceStepSchema.options` (a `zod/v3` enum in `earning/types.ts`) at module load. That's
 * fine for a daemon-only module, but the operator dashboard SPA needs the same 15-member
 * list for `BootstrapState.steps`/`currentStep` typing (`wire-types.ts`), and — same lesson
 * as `lifecycle-kinds.const.ts` — even a type-only need doesn't excuse a value-import of a
 * module built on a schema library, because a VALUE import of anything else from that module
 * would still drag zod into the SPA bundle. So this module holds the flat, hardcoded 15
 * values instead: 4 pre-service phases the fleet passes through before any per-service step
 * exists, then all 11 `ServiceStep`s in progression order.
 *
 * `earning/fleet-bootstrap-phase.ts` imports this instead of deriving from
 * `ServiceStepSchema.options` directly; `test/earning/fleet-bootstrap-phase.test.ts` still
 * independently reads `ServiceStepSchema.options` and asserts equality against this list, so
 * a future change to `ServiceStepSchema` that isn't mirrored here still fails a test — the
 * derivation moved, the drift protection didn't.
 */
export const PRE_SERVICE_BOOTSTRAP_PHASES = [
  'wallet',
  'safe_predicted',
  'awaiting_funding',
  'safe_deployed',
] as const;

/** Mirrors `ServiceStepSchema.options` in `earning/types.ts` — kept in sync by the test above. */
const SERVICE_STEPS = [
  'awaiting_stake',
  'service_created',
  'service_activated',
  'agents_registered',
  'service_deployed',
  'service_staked',
  'staked',
  'mech_deployed',
  'agent_registered',
  'safe_binding_pending',
  'complete',
] as const;

/** Pre-service phases ∪ ServiceStep, in progression order. 4 + 11 = 15 members. */
export const FLEET_BOOTSTRAP_PHASES = [
  ...PRE_SERVICE_BOOTSTRAP_PHASES,
  ...SERVICE_STEPS,
] as const;

export type FleetBootstrapPhase = (typeof FLEET_BOOTSTRAP_PHASES)[number];
