// SPDX-License-Identifier: MIT

// Today-mode read-only ABI slice for the compiled/deployed TaskCoordinator artifact. All
// state-changing entry points are `onlyRouter` -- this binding never calls TaskCoordinator
// directly, only reads it for reconciliation. Keep this in artifact order; the parity test
// compares every exported field name, type, tuple component, and event index marker.
export const TASK_COORDINATOR_ABI = [
  {
    type: "event",
    name: "TaskClaimed",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: true },
      { name: "operator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TaskCreated",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "manifestDigest", type: "bytes32", indexed: true },
      { name: "taskCidDigest", type: "bytes32", indexed: false },
      { name: "maxClaims", type: "uint32", indexed: false },
    ],
  },
  {
    type: "function",
    name: "getAttempt",
    stateMutability: "view",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
    ],
    outputs: [
      {
        name: "attempt",
        type: "tuple",
        components: [
          { name: "taskId", type: "uint256" },
          { name: "attemptIndex", type: "uint32" },
          { name: "operator", type: "address" },
          { name: "requestId", type: "bytes32" },
          { name: "solutionCidDigest", type: "bytes32" },
          { name: "solutionWeight", type: "uint256" },
          { name: "verdictCount", type: "uint32" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getTask",
    stateMutability: "view",
    inputs: [{ name: "taskId", type: "uint256" }],
    outputs: [
      {
        name: "record",
        type: "tuple",
        components: [
          { name: "creator", type: "address" },
          { name: "taskCidDigest", type: "bytes32" },
          { name: "manifestDigest", type: "bytes32" },
          { name: "status", type: "uint8" },
          {
            name: "policy",
            type: "tuple",
            components: [
              { name: "maxClaims", type: "uint32" },
              { name: "allowSolverSelfEvaluation", type: "bool" },
            ],
          },
          { name: "claimCount", type: "uint32" },
          { name: "submittedCount", type: "uint32" },
          { name: "finalizedAttemptCount", type: "uint32" },
          { name: "creatorCredited", type: "bool" },
        ],
      },
    ],
  },
] as const;
