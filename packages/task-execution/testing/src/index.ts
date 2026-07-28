// @jinn-network/task-execution-testing — the TEP v1 conformance kit (design §24 Layers 1-2).
// Depends on @jinn-network/task-execution-protocol and @jinn-network/task-execution-backend.

// --- the in-memory fake backend (Task 3.2; the kit's reference implementation, proven first) ---
export { createInMemoryBackend, InMemoryTaskExecutionBackend } from "./fake-backend.js";
export type { InMemoryBackendOptions, TestableBackend } from "./fake-backend.js";

// --- Layer 1: protocol conformance over the golden + adversarial fixtures (Task 3.3) ---
export { describeProtocolConformance } from "./protocol-conformance.js";

// --- Layer 2: the backend contract sanity suite (Task 3.4) ---
export { describeTaskExecutionBackendContract } from "./backend-contract.js";
export type { DescribeTaskExecutionBackendContract } from "./backend-contract.js";
