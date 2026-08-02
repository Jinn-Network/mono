// SPDX-License-Identifier: MIT

// Today-mode ABI slice for `contracts/src/staking/JinnRouterV3.sol`, hand-transcribed from the
// deployed source (design §14 "declared impact"; re-homed per M2.1). Only the surface this
// binding calls or decodes is included.
export const JINN_ROUTER_V3_ABI = [
  {
    type: "function",
    name: "createTask",
    stateMutability: "payable",
    inputs: [
      { name: "taskCidDigest", type: "bytes32" },
      { name: "manifestDigest", type: "bytes32" },
      {
        name: "policy",
        type: "tuple",
        components: [
          { name: "maxClaims", type: "uint32" },
          { name: "allowSolverSelfEvaluation", type: "bool" },
        ],
      },
      { name: "solutionMaxDeliveryRate", type: "uint256" },
      { name: "verdictMaxDeliveryRate", type: "uint256" },
      { name: "responseTimeout", type: "uint256" },
    ],
    outputs: [{ name: "taskId", type: "uint256" }],
  },
  {
    type: "function",
    name: "refundUnusedTaskBudget",
    stateMutability: "nonpayable",
    inputs: [{ name: "taskId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimTask",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "priorityMech", type: "address" },
    ],
    outputs: [
      { name: "attemptIndex", type: "uint32" },
      { name: "requestId", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "claimEvaluation",
    stateMutability: "nonpayable",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
      { name: "evaluatorMech", type: "address" },
      { name: "evaluationTaskCidDigest", type: "bytes32" },
    ],
    outputs: [
      { name: "verdictIndex", type: "uint32" },
      { name: "verdictRequestId", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "claimSolutionDelivery",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "solutionDigest", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimVerdictDelivery",
    stateMutability: "nonpayable",
    inputs: [
      { name: "verdictRequestId", type: "bytes32" },
      { name: "verdictDigest", type: "bytes32" },
      { name: "verdictCode", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "TaskCreated",
    inputs: [
      { name: "creator", type: "address", indexed: true },
      { name: "taskId", type: "uint256", indexed: true },
      { name: "manifestDigest", type: "bytes32", indexed: true },
      { name: "taskCidDigest", type: "bytes32", indexed: false },
      { name: "maxClaims", type: "uint32", indexed: false },
      { name: "solutionBudget", type: "uint256", indexed: false },
      { name: "verdictBudget", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TaskAttemptCreated",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: true },
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "operator", type: "address", indexed: false },
      { name: "priorityMech", type: "address", indexed: false },
      { name: "deliveryRate", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EvaluationAttemptCreated",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: true },
      { name: "verdictIndex", type: "uint32", indexed: true },
      { name: "requestId", type: "bytes32", indexed: false },
      { name: "evaluator", type: "address", indexed: false },
      { name: "priorityMech", type: "address", indexed: false },
      { name: "deliveryRate", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SolutionDeliveryClaimed",
    inputs: [
      { name: "operator", type: "address", indexed: true },
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VerdictDeliveryClaimed",
    inputs: [
      { name: "evaluator", type: "address", indexed: true },
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: false },
      { name: "verdictIndex", type: "uint32", indexed: false },
      { name: "verdictCode", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TaskBudgetRefunded",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "solutionAmount", type: "uint256", indexed: false },
      { name: "verdictAmount", type: "uint256", indexed: false },
    ],
  },
] as const;
