// SPDX-License-Identifier: MIT

// Today-mode ABI slice for the OLAS Mech Marketplace, re-homed from
// `client/src/adapters/mech/types.ts` (`MECH_MARKETPLACE_ABI`, `MECH_ABI`), trimmed to the
// entries this binding decodes (design §14 "declared impact").
export const MECH_MARKETPLACE_ABI = [
  {
    type: "function",
    name: "mapAgentMechFactories",
    stateMutability: "view",
    inputs: [{ name: "mech", type: "address" }],
    outputs: [{ name: "factory", type: "address" }],
  },
  {
    type: "function",
    name: "request",
    stateMutability: "payable",
    inputs: [
      { name: "requestData", type: "bytes" },
      { name: "maxDeliveryRate", type: "uint256" },
      { name: "paymentType", type: "bytes32" },
      { name: "priorityMech", type: "address" },
      { name: "responseTimeout", type: "uint256" },
      { name: "paymentData", type: "bytes" },
    ],
    outputs: [{ name: "requestId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "mapRequestIdInfos",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "bytes32" }],
    outputs: [
      { name: "priorityMech", type: "address" },
      { name: "deliveryMech", type: "address" },
      { name: "requester", type: "address" },
      { name: "responseTimeout", type: "uint256" },
      { name: "deliveryRate", type: "uint256" },
      { name: "paymentType", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "MarketplaceRequest",
    inputs: [
      { name: "priorityMech", type: "address", indexed: true },
      { name: "requester", type: "address", indexed: true },
      { name: "numRequests", type: "uint256", indexed: false },
      { name: "requestIds", type: "bytes32[]", indexed: false },
      { name: "requestDatas", type: "bytes[]", indexed: false },
    ],
  },
] as const;

/** Authoritative per-Mech ownership read used by native preflight. */
export const MECH_OPERATOR_ABI = [
  {
    type: "function",
    name: "getOperator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "operator", type: "address" }],
  },
] as const;

/** The per-mech `Deliver` event -- carries the sha256 CID digest of the delivered content (§6.3). */
export const MECH_ABI = [
  {
    type: "event",
    name: "Deliver",
    inputs: [
      { name: "mech", type: "address", indexed: true },
      { name: "mechServiceMultisig", type: "address", indexed: true },
      { name: "requestId", type: "bytes32", indexed: false },
      { name: "deliveryRate", type: "uint256", indexed: false },
      { name: "data", type: "bytes", indexed: false },
    ],
  },
] as const;

/** Authoritative AgentMech write slice shared by every today-mode delivery path. */
export const MECH_DELIVER_TO_MARKETPLACE_ABI = [
  {
    type: "function",
    name: "deliverToMarketplace",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestIds", type: "bytes32[]" },
      { name: "datas", type: "bytes[]" },
    ],
    outputs: [{ name: "deliveredRequests", type: "bool[]" }],
  },
] as const;
