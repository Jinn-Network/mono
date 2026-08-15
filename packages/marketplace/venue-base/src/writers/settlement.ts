// SPDX-License-Identifier: MIT

// The settlement writer -- the chain-facing half of `SettlementPorts` (design §6.1). Every write
// funnels through the single Safe broadcaster (Task 8); every fact read comes from the chunked
// log source (Task 9) or a direct chain read, never fabricated. Follows the claim writer's
// (Task 11) established pattern: chain-generation ABI selection, `logicalTx` naming,
// `alreadySettled`/inner-revert classification, and on-chain recovery for replayed settlements
// instead of trusting anything held only in process memory.
import {
  JINN_ROUTER_V3_ABI,
  JINN_ROUTER_V4_ABI,
  MECH_ABI,
  MECH_DELIVER_TO_MARKETPLACE_ABI,
  SafeInnerRevertError,
  decodeRawCodecCidDigestHex,
  encodeRevisedSolutionRequestData,
  type MarketplaceChainConfig,
  type MechDeliveryFacts,
  type RouterDeliveryFacts,
  type SettlementPorts,
} from "@jinn-network/marketplace-binding";
import { REVISED_COMMON_PROJECTOR_EVENTS_ABI, REVISED_MECH_DELIVER_ABI } from "@jinn-network/marketplace-projector";
import {
  decodeEventLog, encodeFunctionData, hexToString, toHex,
  type Abi, type Address, type Hex, type Log, type PublicClient,
} from "viem";
import type { BaseVenueSafeBroadcaster } from "../broadcast/safe-broadcaster.js";
import type { ChainLogSource } from "../log-source/chain-log-source.js";

const CLAIMED_VIEW_ABI = [{
  name: "claimed", type: "function", stateMutability: "view",
  inputs: [{ name: "requestId", type: "bytes32" }],
  outputs: [{ name: "", type: "bool" }],
}] as const;

/**
 * `TaskCoordinator.getRequestRef` -- resolves a today-generation requestId to the
 * `(taskId, attemptIndex)` its attempt record lives at. Real on the deployed contract
 * (`contracts/src/tasks/TaskCoordinator.sol:453`) but not part of the exported
 * `TASK_COORDINATOR_ABI` slice (adaptation; see PR/task notes).
 */
const REQUEST_REF_VIEW_ABI = [{
  name: "getRequestRef", type: "function", stateMutability: "view",
  inputs: [{ name: "requestId", type: "bytes32" }],
  outputs: [
    { name: "taskId", type: "uint256" },
    { name: "attemptIndex", type: "uint32" },
    { name: "exists", type: "bool" },
  ],
}] as const;

/**
 * `TaskCoordinator.getAttempt` -- the field named `solutionCidDigest` in the deployed contract is
 * today generation's keccak evidence hash (the exact value `claimSolutionDelivery`'s
 * `solutionDigest` argument writes through `recordSubmission`), not a CID digest despite the name.
 */
const GET_ATTEMPT_VIEW_ABI = [{
  name: "getAttempt", type: "function", stateMutability: "view",
  inputs: [
    { name: "taskId", type: "uint256" },
    { name: "attemptIndex", type: "uint32" },
  ],
  outputs: [{
    name: "attempt", type: "tuple",
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
  }],
}] as const;

/**
 * `JinnRouterV4.solutionReservations` public mapping getter (`contracts/src/staking/
 * JinnRouterV4.sol:156`) -- flat positional outputs matching `struct Reservation`'s field order
 * (Solidity's auto-getter convention for a struct-valued mapping). Not part of any exported
 * binding ABI; resolves `priorityMech`/`rate` for the revised settlement batch without requiring
 * the host to inject them.
 */
const SOLUTION_RESERVATION_VIEW_ABI = [{
  name: "solutionReservations", type: "function", stateMutability: "view",
  inputs: [
    { name: "taskId", type: "uint256" },
    { name: "attemptIndex", type: "uint32" },
  ],
  outputs: [
    { name: "kind", type: "uint8" },
    { name: "taskId", type: "uint256" },
    { name: "attemptIndex", type: "uint32" },
    { name: "verdictIndex", type: "uint32" },
    { name: "party", type: "address" },
    { name: "priorityMech", type: "address" },
    { name: "rate", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "settled", type: "bool" },
    { name: "released", type: "bool" },
  ],
}] as const;

const TOKEN_PAYMENT_TYPE_VIEW_ABI = [{
  name: "tokenPaymentType", type: "function", stateMutability: "view",
  inputs: [], outputs: [{ name: "", type: "bytes32" }],
}] as const;

/** `IMechMarketplaceV4` read slice (`contracts/src/staking/JinnRouterV4.sol:21-53`). */
const MECH_MARKETPLACE_NONCE_VIEW_ABI = [{
  name: "mapNonces", type: "function", stateMutability: "view",
  inputs: [{ name: "requester", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

const MECH_MARKETPLACE_REQUEST_ID_VIEW_ABI = [{
  name: "getRequestId", type: "function", stateMutability: "view",
  inputs: [
    { name: "mech", type: "address" },
    { name: "requester", type: "address" },
    { name: "data", type: "bytes" },
    { name: "deliveryRate", type: "uint256" },
    { name: "paymentType", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
  outputs: [{ name: "requestId", type: "bytes32" }],
}] as const;

/** Gnosis Safe `MultiSend` v1.3.0 canonical singleton (identical address across EVM chains). */
export const DEFAULT_MULTISEND_ADDRESS = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130" as Address;

/** 50k blocks: generous enough to cover a delivery that lands between our own poll cycles. */
export const DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS = 50_000n;

/** Inner reverts that mean "the delivery exists but this claimant may not settle it". */
const DELIVERED_UNSETTLED_INNER = new Set([
  "RouterWrongDeliveryOperator", "RouterWrongRequester", "RouterWrongRequestKind",
  "RouterV4WrongDeliveryOperator",
]);
const ALREADY_SETTLED_INNER = new Set([
  "RouterAlreadyClaimed", "TCVerdictAlreadyDelivered", "RouterV4AlreadyClaimed",
]);

function classifySettlementRevert(
  error: unknown,
): "already-settled" | "delivered-unsettled" | "rejected" | undefined {
  if (!(error instanceof SafeInnerRevertError) || error.decodedName === null) return undefined;
  if (ALREADY_SETTLED_INNER.has(error.decodedName)) return "already-settled";
  if (DELIVERED_UNSETTLED_INNER.has(error.decodedName)) return "delivered-unsettled";
  return "rejected";
}

function mechDeliverAbi(chain: MarketplaceChainConfig): Abi {
  return chain.generation === "revised" ? REVISED_MECH_DELIVER_ABI : MECH_ABI;
}

function mechDeliverDataField(chain: MarketplaceChainConfig): "data" | "deliveryData" {
  return chain.generation === "revised" ? "deliveryData" : "data";
}

/**
 * Decodes a Mech `Deliver` event's opaque `data`/`deliveryData` bytes.
 *
 * Production `deliver-leg` writes a raw 32-byte sha256 digest. Older / test fixtures write the
 * UTF-8 text of a raw-codec CID (`computeRawCodecCid`). Accept both; refuse anything else.
 */
function decodeMechDeliverDigest(dataHex: Hex): `sha256:${string}` {
  const hex = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return `sha256:${hex.toLowerCase()}`;
  }
  const cidString = hexToString(dataHex);
  return `sha256:${decodeRawCodecCidDigestHex(cidString)}`;
}

export interface SettlementWriterInput {
  readonly chain: MarketplaceChainConfig;
  readonly publicClient: PublicClient;
  readonly safeAddress: Address;
  readonly broadcaster: BaseVenueSafeBroadcaster;
  readonly logSource: ChainLogSource;
  readonly pin: SettlementPorts["pin"];
  readonly verifySettlementGrade: SettlementPorts["verifySettlementGrade"];
  /**
   * Gnosis Safe `MultiSend` address for the revised-generation three-leg settlement batch.
   * Defaults to the canonical v1.3.0 singleton; override for a chain with a different deployment.
   */
  readonly multiSendAddress?: Address;
}

async function readMechDeliveryFacts(
  input: SettlementWriterInput,
  args: { readonly requestId: Hex; readonly config: MarketplaceChainConfig },
): Promise<MechDeliveryFacts> {
  const latest = await input.publicClient.getBlockNumber();
  const checkpoint = input.logSource.cursor()?.blockNumber ?? 0n;
  const fromBlock = checkpoint > DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS
    ? checkpoint - DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS
    : 0n;
  const logs = await input.logSource.logsInRange(fromBlock, latest);
  const abi = mechDeliverAbi(args.config);
  const field = mechDeliverDataField(args.config);

  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true,
      });
      if (decoded.eventName !== "Deliver") continue;
      const decodedArgs = decoded.args as unknown as Record<string, unknown>;
      const requestId = decodedArgs.requestId as Hex | undefined;
      if (requestId === undefined || requestId.toLowerCase() !== args.requestId.toLowerCase()) continue;
      const dataHex = decodedArgs[field] as Hex;
      return { requestId: args.requestId, sha256CidDigest: decodeMechDeliverDigest(dataHex) };
    } catch {
      // Not a Deliver event on this generation's ABI; a chunk carries unrelated logs too.
    }
  }
  throw new Error(
    `no Deliver event for request ${args.requestId} in the scanned range `
    + `[${fromBlock}, ${latest}] — refusing to fabricate a digest`,
  );
}

async function readRouterDeliveryFacts(
  input: SettlementWriterInput,
  args: { readonly requestId: Hex; readonly config: MarketplaceChainConfig },
): Promise<RouterDeliveryFacts> {
  if (args.config.generation === "today") {
    const [taskId, attemptIndex, exists] = await input.publicClient.readContract({
      address: args.config.taskCoordinator, abi: REQUEST_REF_VIEW_ABI,
      functionName: "getRequestRef", args: [args.requestId],
    });
    if (!exists) {
      throw new Error(
        `requestId ${args.requestId} has no TaskCoordinator request reference — cannot read `
        + "delivery facts",
      );
    }
    const attempt = await input.publicClient.readContract({
      address: args.config.taskCoordinator, abi: GET_ATTEMPT_VIEW_ABI,
      functionName: "getAttempt", args: [taskId, attemptIndex],
    });
    return { generation: "today", requestId: args.requestId, keccakEvidenceHash: attempt.solutionCidDigest };
  }

  const events = await input.publicClient.getContractEvents({
    address: args.config.jinnRouter, abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
    eventName: "SolutionDeliveryClaimed", args: { requestId: args.requestId },
    fromBlock: 0n, toBlock: "latest",
  });
  const match = events.at(-1);
  if (match === undefined) {
    throw new Error(
      `requestId ${args.requestId} has no SolutionDeliveryClaimed record on the router — cannot `
      + "read delivery facts",
    );
  }
  const decoded = match.args as unknown as { taskId: bigint; attemptIndex: number; deliveryDigest: Hex };
  return {
    generation: "revised",
    requestId: args.requestId,
    taskId: decoded.taskId,
    attemptIndex: Number(decoded.attemptIndex),
    sha256Digest: `sha256:${decoded.deliveryDigest.slice(2)}` as `sha256:${string}`,
  };
}

async function claimSolutionDelivery(
  input: SettlementWriterInput,
  args: { readonly requestId: Hex; readonly solutionDigest: Hex; readonly operationId?: string },
): Promise<{
  readonly status: "settled" | "already-settled" | "rejected" | "delivered-unsettled";
  readonly txHash?: Hex;
}> {
  const alreadyClaimed = await input.publicClient.readContract({
    address: input.chain.jinnRouter, abi: CLAIMED_VIEW_ABI, functionName: "claimed", args: [args.requestId],
  });
  if (alreadyClaimed) {
    return {
      status: "already-settled",
      ...(await readTodaySettlementTransaction(input, args.requestId)),
    };
  }

  const data = encodeFunctionData({
    abi: JINN_ROUTER_V3_ABI, functionName: "claimSolutionDelivery",
    args: [args.requestId, args.solutionDigest],
  });
  try {
    const receipt = await input.broadcaster.execute({
      to: input.chain.jinnRouter, value: 0n, data,
      logicalTx: args.operationId ?? `settlement.claimSolutionDelivery:${args.requestId}`,
    });
    const transaction = /^0x[0-9a-fA-F]{64}$/.test(receipt.txHash)
      ? { txHash: receipt.txHash }
      : await readTodaySettlementTransaction(input, args.requestId);
    return {
      status: receipt.alreadySettled ? "already-settled" : "settled",
      ...transaction,
    };
  } catch (error) {
    const classified = classifySettlementRevert(error);
    if (classified === undefined) throw error;
    return { status: classified };
  }
}

async function readTodaySettlementTransaction(
  input: SettlementWriterInput,
  requestId: Hex,
): Promise<{ readonly txHash?: Hex }> {
  const latest = await input.publicClient.getBlockNumber();
  const fromBlock = latest > DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS
    ? latest - DEFAULT_MECH_DELIVER_LOOKBACK_BLOCKS
    : 0n;
  const logs = await input.logSource.logsInRange(fromBlock, latest);
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index]!;
    if (log.address.toLowerCase() !== input.chain.jinnRouter.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: JINN_ROUTER_V3_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      if (decoded.eventName !== "SolutionDeliveryClaimed") continue;
      const decodedRequestId = (decoded.args as unknown as { requestId: Hex }).requestId;
      if (decodedRequestId.toLowerCase() === requestId.toLowerCase()) {
        return { txHash: log.transactionHash };
      }
    } catch {
      // Not the requested V3 settlement event; the bounded router range contains other events.
    }
  }
  return {};
}

function decodeClaimedRequestIdFromLogs(logs: readonly Log[]): Hex | undefined {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true,
      });
      if (decoded.eventName === "SolutionDeliveryClaimed") {
        return (decoded.args as unknown as { requestId: Hex }).requestId;
      }
    } catch {
      // Not a router event; a MultiSend receipt carries unrelated logs too.
    }
  }
  return undefined;
}

/**
 * Recovers a replayed revised settlement's requestId from the router's already-mined
 * `SolutionDeliveryClaimed` history, filtered by the (unique, caller-known) delivery digest --
 * never trusts an in-memory value that would not survive a process restart. Mirrors the claim
 * writer's `readSettledAttemptFromChain` (Task 11).
 */
async function recoverClaimedRequestIdByDigest(
  input: SettlementWriterInput,
  deliveryDigest: Hex,
): Promise<Hex> {
  const events = await input.publicClient.getContractEvents({
    address: input.chain.jinnRouter, abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
    eventName: "SolutionDeliveryClaimed", args: { deliveryDigest }, fromBlock: 0n, toBlock: "latest",
  });
  const match = events.at(-1);
  if (match === undefined) {
    throw new Error(
      `already-settled revised settlement for delivery digest ${deliveryDigest} has no on-chain `
      + "SolutionDeliveryClaimed record — cannot recover the requestId",
    );
  }
  return (match.args as unknown as { requestId: Hex }).requestId;
}

interface BatchCall {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
}

const MULTISEND_ABI = [{
  type: "function", name: "multiSend", stateMutability: "payable",
  inputs: [{ name: "transactions", type: "bytes" }], outputs: [],
}] as const;

/**
 * Gnosis Safe `MultiSend.multiSend(bytes)` packed-transaction encoding: per call,
 * `operation(1 byte) | to(20 bytes) | value(32 bytes) | dataLength(32 bytes) | data`.
 *
 * The OUTER Safe `execTransaction` carrying this payload MUST be a DELEGATECALL
 * (`SafeBroadcastRequest.operation = 1`) into the `MultiSend` singleton: a plain CALL would make
 * `MultiSend` the inner `msg.sender` and the router's operator/party checks would reject every
 * leg. Each INNER leg stays `00` (Call) so it runs against its own target from the Safe.
 */
function encodeMultiSendCalldata(calls: readonly BatchCall[]): Hex {
  const transactions = calls.map((call) => {
    const operation = "00";
    const to = call.to.slice(2).toLowerCase().padStart(40, "0");
    const value = call.value.toString(16).padStart(64, "0");
    const dataBytes = call.data.slice(2);
    const dataLength = (dataBytes.length / 2).toString(16).padStart(64, "0");
    return `${operation}${to}${value}${dataLength}${dataBytes}`;
  }).join("");
  return encodeFunctionData({
    abi: MULTISEND_ABI, functionName: "multiSend", args: [`0x${transactions}` as Hex],
  });
}

async function settleRevisedSolutionDelivery(
  input: SettlementWriterInput,
  args: {
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly deliveryDigest: Hex;
    readonly deliveryBytes: Uint8Array;
  },
): Promise<
  | { readonly status: "rejected" }
  | {
      readonly status: "settled" | "already-settled" | "delivered-unsettled";
      readonly requestId: Hex;
    }
> {
  const reservation = await input.publicClient.readContract({
    address: input.chain.jinnRouter, abi: SOLUTION_RESERVATION_VIEW_ABI,
    functionName: "solutionReservations", args: [args.taskId, args.attemptIndex],
  });
  const priorityMech = reservation[5];
  const rate = reservation[6];
  const tokenPaymentType = await input.publicClient.readContract({
    address: input.chain.jinnRouter, abi: TOKEN_PAYMENT_TYPE_VIEW_ABI, functionName: "tokenPaymentType",
  });
  const requestData = encodeRevisedSolutionRequestData({
    taskId: args.taskId, attemptIndex: args.attemptIndex, deliveryDigest: args.deliveryDigest,
  });
  const nonce = await input.publicClient.readContract({
    address: input.chain.mechMarketplace, abi: MECH_MARKETPLACE_NONCE_VIEW_ABI,
    functionName: "mapNonces", args: [input.chain.jinnRouter],
  });
  const expectedRequestId = await input.publicClient.readContract({
    address: input.chain.mechMarketplace, abi: MECH_MARKETPLACE_REQUEST_ID_VIEW_ABI,
    functionName: "getRequestId",
    args: [priorityMech, input.chain.jinnRouter, requestData, rate, tokenPaymentType, nonce],
  });

  const prepareCalldata = encodeFunctionData({
    abi: JINN_ROUTER_V4_ABI, functionName: "prepareSolutionDelivery",
    args: [args.taskId, args.attemptIndex, args.deliveryDigest],
  });
  const deliverCalldata = encodeFunctionData({
    abi: MECH_DELIVER_TO_MARKETPLACE_ABI, functionName: "deliverToMarketplace",
    args: [[expectedRequestId], [toHex(args.deliveryBytes)]],
  });
  const claimCalldata = encodeFunctionData({
    abi: JINN_ROUTER_V4_ABI, functionName: "claimSolutionDelivery",
    args: [priorityMech, requestData, rate, tokenPaymentType, nonce],
  });
  const batchData = encodeMultiSendCalldata([
    { to: input.chain.jinnRouter, value: 0n, data: prepareCalldata },
    { to: priorityMech, value: 0n, data: deliverCalldata },
    { to: input.chain.jinnRouter, value: 0n, data: claimCalldata },
  ]);

  try {
    const receipt = await input.broadcaster.execute({
      to: input.multiSendAddress ?? DEFAULT_MULTISEND_ADDRESS, value: 0n, data: batchData,
      // DELEGATECALL: each inner leg must execute with `msg.sender == Safe`.
      operation: 1,
      logicalTx: `settlement.settleRevisedSolutionDelivery:${args.taskId}:${args.attemptIndex}`,
    });
    if (receipt.alreadySettled) {
      return {
        status: "already-settled",
        requestId: await recoverClaimedRequestIdByDigest(input, args.deliveryDigest),
      };
    }
    const requestId = decodeClaimedRequestIdFromLogs(receipt.logs);
    if (requestId === undefined) {
      throw new Error(
        `settleRevisedSolutionDelivery for task ${args.taskId} attempt ${args.attemptIndex} `
        + `produced no SolutionDeliveryClaimed event (txHash=${receipt.txHash}) — refusing to `
        + "fabricate a requestId",
      );
    }
    return { status: "settled", requestId };
  } catch (error) {
    const classified = classifySettlementRevert(error);
    if (classified === undefined) throw error;
    if (classified === "rejected") return { status: "rejected" };
    if (classified === "already-settled") {
      return {
        status: "already-settled",
        requestId: await recoverClaimedRequestIdByDigest(input, args.deliveryDigest),
      };
    }
    return { status: "delivered-unsettled", requestId: expectedRequestId };
  }
}

export function createSettlementPorts(input: SettlementWriterInput): SettlementPorts {
  const base = {
    pin: input.pin,
    verifySettlementGrade: input.verifySettlementGrade,
    readMechDeliveryFacts: (args: { readonly requestId: Hex; readonly config: MarketplaceChainConfig }) =>
      readMechDeliveryFacts(input, args),
    readRouterDeliveryFacts: (args: { readonly requestId: Hex; readonly config: MarketplaceChainConfig }) =>
      readRouterDeliveryFacts(input, args),
    claimSolutionDelivery: (args: {
      readonly requestId: Hex;
      readonly solutionDigest: Hex;
      readonly operationId?: string;
    }) =>
      claimSolutionDelivery(input, args),
  };
  if (input.chain.generation !== "revised") return base;
  return {
    ...base,
    settleRevisedSolutionDelivery: (args: {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly deliveryDigest: Hex;
      readonly deliveryBytes: Uint8Array;
    }) => settleRevisedSolutionDelivery(input, args),
  };
}
