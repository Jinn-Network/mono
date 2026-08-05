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
 * The 15-value list itself now lives in
 * `client/src/api/contract/fleet-bootstrap-phases.const.ts` (moved there so the operator
 * dashboard SPA's `BootstrapState` typing can import it without dragging this module's
 * `zod/v3` dependency into the browser bundle — see that module's docstring). This module
 * re-exports it for its existing daemon-side importers (`bootstrap-endpoint.ts` and
 * anything else that needs the fleet-phase display list) and builds the index Map, which
 * has no SPA consumer and stays here.
 */
export {
  PRE_SERVICE_BOOTSTRAP_PHASES,
  FLEET_BOOTSTRAP_PHASES,
  type FleetBootstrapPhase,
} from '../api/contract/fleet-bootstrap-phases.const.js';
import { FLEET_BOOTSTRAP_PHASES, type FleetBootstrapPhase } from '../api/contract/fleet-bootstrap-phases.const.js';

export const FLEET_BOOTSTRAP_PHASE_INDEX = new Map<FleetBootstrapPhase, number>(
  FLEET_BOOTSTRAP_PHASES.map((phase, i) => [phase, i]),
);
