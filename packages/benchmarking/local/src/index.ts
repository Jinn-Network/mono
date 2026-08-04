// @jinn-network/benchmarking-local — local-venue assembly ports and the treatment-fidelity
// bridge (policy identity design §7; benchmarking design §8.1/§8.3/§8.4).

export {
  effectiveRunPinning,
  pinnedValueForAxis,
  PINNING_AXES,
  REQUIREMENT_KEY_FOR_AXIS,
} from "./axes.js";
export type { PinningAxis } from "./axes.js";

export {
  corroborate,
  corroborationForAxis,
  hasExecutionEvidence,
  localPinningObservation,
  LOCAL_AXIS_STRENGTH,
  pinningObservationForCell,
  pinningStatusForAxis,
  requirementsDigest,
} from "./pinning-bridge.js";
export type {
  AxisAdmission,
  AxisCorroboration,
  AxisStrength,
  LocalAxisObservation,
  LocalCellPinningEvidence,
  LocalPinningObservationInput,
  LocalPinningVenue,
  LocalRunPinningCheck,
} from "./pinning-bridge.js";

export {
  axisObservationsFromRuntimeObservations,
  runPinningPropertyId,
  RUN_PINNING_PROPERTY_PREFIX,
} from "./runtime-observations.js";
export type { LocalRuntimeObservationCapture } from "./runtime-observations.js";

export { integrityTierFromReceipt, localAdmissionEvidence } from "./admission.js";
export type { LocalAdmissionEvidenceInput, LocalAdmissionReceipt } from "./admission.js";

export {
  failClosedTrustResolver,
  localCloseBoundary,
  localInputScope,
  localReportedCost,
  unresolvedTrustResolver,
} from "./scope.js";
export type { LocalCostInput, LocalInputScopeInput } from "./scope.js";

export { localAssemblyPorts } from "./assembly-ports.js";
export type { LocalAssemblyPortsInput } from "./assembly-ports.js";
