import { describeTaskExecutionBackendContract } from "./backend-contract.js";
import { createInMemoryBackend } from "./fake-backend.js";

describeTaskExecutionBackendContract(() => createInMemoryBackend());
