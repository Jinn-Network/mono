// SPDX-License-Identifier: MIT

// Today-mode read-only ABI slice for `contracts/src/tasks/TaskCoordinator.sol`, hand-transcribed
// from the deployed source (design §14 "declared impact"). All state-changing entry points are
// `onlyRouter` -- this binding never calls TaskCoordinator directly, only reads it for
// reconciliation.
export const TASK_COORDINATOR_ABI = [
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
        ],
      },
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
          { name: "operator", type: "address" },
          { name: "requestId", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "TaskCreated",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "taskCidDigest", type: "bytes32", indexed: false },
      { name: "manifestDigest", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TaskClaimed",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: true },
      { name: "operator", type: "address", indexed: true },
    ],
  },
] as const;
