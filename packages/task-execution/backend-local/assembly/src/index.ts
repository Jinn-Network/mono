// @jinn-network/task-execution-backend-local — the embedded local TaskExecutionBackend.
export {
  LocalTaskExecutionBackend,
  makeLocalTaskExecutionBackend,
} from "./backend.js";
export type {
  LocalBackendFaults,
  LocalExecutionInput,
  LocalExecutionOutcome,
  LocalProvisionerInput,
  LocalTaskExecutionBackendConfig,
  ProvisionerCapabilities,
} from "./backend.js";
export { assembleCapabilities } from "./capabilities.js";
export type {
  AssembleCapabilitiesInput,
  CapabilityProvisionerConfig,
  RecorderAvailability,
  TrustKeyConfig,
} from "./capabilities.js";
export { projectObservations } from "./observation.js";
export type { ProjectableJournalEvent } from "./observation.js";
export { createEvidenceJoin } from "./evidence-join.js";
export type {
  EvidenceBindingPorts,
  EvidenceCaptureSession,
  EvidenceIndexingOutcome,
  EvidenceJoin,
  EvidenceJoinOptions,
  FinalizeEvidenceCaptureInput,
  StartEvidenceCaptureInput,
} from "./evidence-join.js";
