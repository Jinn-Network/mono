// @jinn-network/task-execution-backend-local — the embedded local TaskExecutionBackend.
export {
  LocalTaskExecutionBackend,
  makeLocalTaskExecutionBackend,
} from "./backend.js";
export type {
  LocalBackendFaults,
  LocalProvisionerInput,
  LocalTaskExecutionBackendConfig,
  ProvisionerCapabilities,
} from "./backend.js";
