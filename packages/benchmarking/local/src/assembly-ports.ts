// SPDX-License-Identifier: MIT

import type { AssemblyPorts, TrustResolver } from "@jinn-network/benchmarking-run";
import { localAdmissionEvidence, type LocalAdmissionEvidenceInput } from "./admission.js";
import {
  localPinningObservation,
  type LocalPinningObservationInput,
} from "./pinning-bridge.js";
import {
  failClosedTrustResolver,
  localCloseBoundary,
  localInputScope,
  localReportedCost,
  unresolvedTrustResolver,
  type LocalCostInput,
  type LocalInputScopeInput,
} from "./scope.js";

export interface LocalAssemblyPortsInput {
  readonly inputScope: LocalInputScopeInput;
  readonly pinning: LocalPinningObservationInput;
  readonly admission?: LocalAdmissionEvidenceInput;
  readonly cost?: LocalCostInput;
  /** Host-supplied trust resolution; omitted resolves nothing rather than guessing. */
  readonly trust?: TrustResolver;
}

/**
 * Wires local-venue-backed ports for `assembleMatrix` / `verifyMatrix`.
 *
 * Every venue fact arrives as an argument: this package reads no config, opens no socket,
 * touches no filesystem, and imports neither a concrete backend nor an evidence package. The
 * host that ran the admission gate and recorded the Runtime Observations passes them in.
 */
export function localAssemblyPorts(input: LocalAssemblyPortsInput): AssemblyPorts {
  return {
    inputScope: localInputScope(input.inputScope),
    trust: failClosedTrustResolver(input.trust ?? unresolvedTrustResolver()),
    closeBoundary: localCloseBoundary(),
    pinning: localPinningObservation(input.pinning),
    admission: localAdmissionEvidence(input.admission),
    cost: localReportedCost(input.cost),
  };
}
