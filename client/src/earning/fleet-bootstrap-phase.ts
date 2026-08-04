/**
 * The unified fleet bootstrap phase list (issue #2407, spec §5/§11).
 *
 * Before this, two lists existed at different granularities: the bootstrap
 * machine's 11 `ServiceStep`s (per-service, `earning/types.ts`) and the
 * `/v1/bootstrap` endpoint's own 14-entry display list (fleet-phase — the
 * four pre-service steps prepended to a hand-copied `ServiceStep` list). The
 * endpoint's copy was NOT a superset: it silently dropped `awaiting_stake`,
 * so a service actually at `awaiting_stake` had no entry in the endpoint's
 * `STEP_INDEX` map and was mis-reported as `currentStep: 'wallet'` (phase 1)
 * instead of its true position (phase 3, "Deploying") — the real sync bug.
 *
 * This module is the single typed source: pre-service phases ∪ every
 * `ServiceStep`, defined once. The endpoint (and anything else that needs
 * the fleet-phase display list) imports this instead of keeping its own copy.
 */
import { ServiceStepSchema } from './types.js';

/** The four phases a fleet passes through before any per-service step exists. */
export const PRE_SERVICE_BOOTSTRAP_PHASES = [
  'wallet',
  'safe_predicted',
  'awaiting_funding',
  'safe_deployed',
] as const;

/**
 * Pre-service phases ∪ ServiceStep, in progression order. 4 + 11 = 15
 * members. `ServiceStepSchema.options` already lists `awaiting_stake` first
 * (bootstrap-run.ts's STANDARD_SERVICE_PROGRESSION / SELF_BOND_SERVICE_PROGRESSION
 * both start there too), so the union naturally places it immediately after
 * `safe_deployed` and before `service_created`.
 */
export const FLEET_BOOTSTRAP_PHASES = [
  ...PRE_SERVICE_BOOTSTRAP_PHASES,
  ...ServiceStepSchema.options,
] as const;

export type FleetBootstrapPhase = (typeof FLEET_BOOTSTRAP_PHASES)[number];

export const FLEET_BOOTSTRAP_PHASE_INDEX = new Map<FleetBootstrapPhase, number>(
  FLEET_BOOTSTRAP_PHASES.map((phase, i) => [phase, i]),
);
