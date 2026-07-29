// SPDX-License-Identifier: MIT

/**
 * The exact JinnRouterV4 function slice consumed by revised binding adapters.
 * `revised-contracts.test.ts` compares every item with the compiled artifact.
 */
export const JINN_ROUTER_V4_ABI = [
  {
    type: "function",
    name: "claimTask",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "priorityMech", type: "address" },
    ],
    outputs: [{ name: "attemptIndex", type: "uint32" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimEvaluation",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
      { name: "evaluatorMech", type: "address" },
    ],
    outputs: [{ name: "verdictIndex", type: "uint32" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "prepareSolutionDelivery",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
      { name: "deliveryDigest", type: "bytes32" },
    ],
    outputs: [
      { name: "expectedRequestId", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "requestData", type: "bytes" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "prepareVerdictDelivery",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
      { name: "verdictIndex", type: "uint32" },
      { name: "deliveryDigest", type: "bytes32" },
      { name: "verdictCode", type: "uint8" },
    ],
    outputs: [
      { name: "expectedRequestId", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "requestData", type: "bytes" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "releaseAttempt",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "releaseVerdict",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
      { name: "verdictIndex", type: "uint32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "forfeitDeliveredReservation",
    inputs: [
      { name: "taskId", type: "uint256" },
      { name: "attemptIndex", type: "uint32" },
      { name: "verdictIndex", type: "uint32" },
      { name: "legKind", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "closeTask",
    inputs: [{ name: "taskId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimSolutionDelivery",
    inputs: [
      { name: "mech", type: "address" },
      { name: "requestData", type: "bytes" },
      { name: "deliveryRate", type: "uint256" },
      { name: "paymentType", type: "bytes32" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimVerdictDelivery",
    inputs: [
      { name: "mech", type: "address" },
      { name: "requestData", type: "bytes" },
      { name: "deliveryRate", type: "uint256" },
      { name: "paymentType", type: "bytes32" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
