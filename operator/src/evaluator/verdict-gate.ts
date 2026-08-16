import {
  gateVerdictObservation,
  type VerdictObservationGate,
  type VerdictObservationGateInput,
  type VerdictObservationGatePorts,
} from "@jinn-network/marketplace-binding";

/** Trusted dependencies are assembled by a future native composition root, never by this port. */
export type VerdictGateDeps = VerdictObservationGatePorts;

/**
 * Thin host delegation only. It neither derives an observation input nor installs the donor's
 * permanently fail-closed observation adapter, so importing this module cannot change runtime
 * behavior before native composition explicitly calls it.
 */
export function createVerdictGate(deps: VerdictGateDeps): {
  gate(input: VerdictObservationGateInput): Promise<VerdictObservationGate>;
} {
  return { gate: (input) => gateVerdictObservation(input, deps) };
}
