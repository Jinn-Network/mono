/**
 * Executable revised-contract conformance driver for M7 fix-round prepare-settlement.
 *
 * Generic: no Hardhat/ethers dependency. Concrete deployments wire
 * {@link RevisedContractConformancePort} (see contracts Hardhat adapter).
 */

import { keccak256, toBytes, encodeAbiParameters, parseAbiParameters, decodeAbiParameters } from "viem";

export const REVISED_REQUEST_DATA_DOMAIN = "jinn.marketplace.revised" as const;
export const REVISED_REQUEST_DATA_VERSION = 2 as const;
export const REVISED_LEG_SOLUTION = 1 as const;
export const REVISED_LEG_VERDICT = 2 as const;
export const REVISED_SOLUTION_VERDICT_SENTINEL = 0 as const;
export const REVISED_SOLUTION_VERDICT_CODE_SENTINEL = 0 as const;

export const REVISED_DOMAIN_HASH = keccak256(toBytes(REVISED_REQUEST_DATA_DOMAIN));

export type RevisedRequestData = {
  readonly domain: `0x${string}`;
  readonly version: number;
  readonly legKind: typeof REVISED_LEG_SOLUTION | typeof REVISED_LEG_VERDICT;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly deliveryDigest: `0x${string}`;
  readonly verdictCode: number;
};

/** Exact V4 claim events after Addendum 2026-07-29-r (no Mech requestId at claim). */
export const REVISED_CLAIM_EVENT_NAMES = [
  "TaskAttemptCreated",
  "EvaluationAttemptCreated",
  "SolutionDeliveryPrepared",
  "VerdictDeliveryPrepared",
  "SolutionDeliveryClaimed",
  "VerdictDeliveryClaimed",
  "ReservationForfeited",
] as const;

/**
 * Adapter delta note: projector `REVISED_COMMON_PROJECTOR_EVENTS_ABI` still lists
 * `requestId` as the third indexed topic on claim events (Addendum f). Contract core
 * emits `taskId` as the third indexed topic instead. Follow-on must update projector
 * event ABIs, claim-identity engagement (no requestId until Deliver), and
 * requestData decoding via abi.decode of this blob (v2 includes verdictCode).
 */
export const REVISED_CONTRACT_ADAPTER_DELTA = {
  claimEventsDropRequestId: true,
  claimThirdIndexedTopic: "taskId",
  requestDataEncoding:
    "abi.encode(domain,version,legKind,taskId,attemptIndex,verdictIndex,deliveryDigest,verdictCode)",
  requestDataVersion: REVISED_REQUEST_DATA_VERSION,
  settlementIsAtomicSafeBatch: true,
  settlementLegs: ["prepare", "deliverMarketplaceWithSignatures", "routerClaim"] as const,
  feeToken: "OLAS",
  paymentTypeName: "FixedPriceToken",
  accounting: "escrowed = remaining + reserved + spentOut",
} as const;

const REQUEST_DATA_ABI = parseAbiParameters(
  "bytes32 domain, uint8 version, uint8 legKind, uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, bytes32 deliveryDigest, uint8 verdictCode",
);

export function encodeRevisedSolutionRequestData(input: {
  taskId: bigint;
  attemptIndex: number;
  deliveryDigest: `0x${string}`;
}): `0x${string}` {
  if (input.deliveryDigest === ("0x" + "0".repeat(64)) as `0x${string}`) {
    throw new Error("revised requestData deliveryDigest must be nonzero");
  }
  return encodeAbiParameters(REQUEST_DATA_ABI, [
    REVISED_DOMAIN_HASH,
    REVISED_REQUEST_DATA_VERSION,
    REVISED_LEG_SOLUTION,
    input.taskId,
    input.attemptIndex,
    REVISED_SOLUTION_VERDICT_SENTINEL,
    input.deliveryDigest,
    REVISED_SOLUTION_VERDICT_CODE_SENTINEL,
  ]);
}

export function encodeRevisedVerdictRequestData(input: {
  taskId: bigint;
  attemptIndex: number;
  verdictIndex: number;
  deliveryDigest: `0x${string}`;
  verdictCode: number;
}): `0x${string}` {
  if (input.deliveryDigest === ("0x" + "0".repeat(64)) as `0x${string}`) {
    throw new Error("revised requestData deliveryDigest must be nonzero");
  }
  if (input.verdictCode < 1 || input.verdictCode > 4) {
    throw new Error(`revised verdictCode invalid: ${input.verdictCode}`);
  }
  return encodeAbiParameters(REQUEST_DATA_ABI, [
    REVISED_DOMAIN_HASH,
    REVISED_REQUEST_DATA_VERSION,
    REVISED_LEG_VERDICT,
    input.taskId,
    input.attemptIndex,
    input.verdictIndex,
    input.deliveryDigest,
    input.verdictCode,
  ]);
}

export function decodeRevisedRequestData(data: `0x${string}`): RevisedRequestData {
  const [domain, version, legKind, taskId, attemptIndex, verdictIndex, deliveryDigest, verdictCode] =
    decodeAbiParameters(REQUEST_DATA_ABI, data);
  const decoded: RevisedRequestData = {
    domain: domain as `0x${string}`,
    version: Number(version),
    legKind: Number(legKind) as RevisedRequestData["legKind"],
    taskId,
    attemptIndex: Number(attemptIndex),
    verdictIndex: Number(verdictIndex),
    deliveryDigest: deliveryDigest as `0x${string}`,
    verdictCode: Number(verdictCode),
  };
  assertRevisedRequestDataShape(decoded);
  return decoded;
}

export function assertRevisedRequestDataShape(decoded: RevisedRequestData): void {
  if (decoded.domain !== REVISED_DOMAIN_HASH) {
    throw new Error(`revised requestData domain mismatch: ${decoded.domain}`);
  }
  if (decoded.version !== REVISED_REQUEST_DATA_VERSION) {
    throw new Error(`revised requestData version mismatch: ${decoded.version}`);
  }
  if (decoded.legKind !== REVISED_LEG_SOLUTION && decoded.legKind !== REVISED_LEG_VERDICT) {
    throw new Error(`revised requestData legKind invalid: ${decoded.legKind}`);
  }
  if (decoded.legKind === REVISED_LEG_SOLUTION) {
    if (decoded.verdictIndex !== REVISED_SOLUTION_VERDICT_SENTINEL) {
      throw new Error("solution requestData must use verdictIndex sentinel 0");
    }
    if (decoded.verdictCode !== REVISED_SOLUTION_VERDICT_CODE_SENTINEL) {
      throw new Error("solution requestData must use verdictCode sentinel 0");
    }
  } else if (decoded.verdictCode < 1 || decoded.verdictCode > 4) {
    throw new Error(`revised verdictCode invalid: ${decoded.verdictCode}`);
  }
  if (decoded.deliveryDigest === ("0x" + "0".repeat(64)) as `0x${string}`) {
    throw new Error("revised requestData deliveryDigest must be nonzero");
  }
}

/** Port implemented by a Hardhat (or other) deployment adapter. */
export interface RevisedContractConformancePort {
  /** Round-trip encode/decode against the on-chain MarketplaceRequestDataView. */
  roundTripRequestData(input: {
    taskId: bigint;
    attemptIndex: number;
    verdictIndex: number;
    deliveryDigest: `0x${string}`;
    verdictCode: number;
    leg: "solution" | "verdict";
  }): Promise<RevisedRequestData>;

  /**
   * Prove claim does not take a free-standing Mech requestId argument —
   * only mech, requestData, rate, paymentType, nonce (and prepared binding).
   */
  claimWithoutRequestIdArg(): Promise<{ solutionArity: number; verdictArity: number }>;

  /** Prepare binds EIP-1271; unprepared deliver must fail; prepared path returns magic via marketplace. */
  preparationAndEip1271(): Promise<{ prepared: boolean; unpreparedRejected: boolean; preparedDelivered: boolean }>;

  /**
   * Conservation attack: task A prepare+Mech-deliver without claim; release/close cannot restore;
   * task B fully recoverable.
   */
  conservationAttackRefusal(): Promise<{
    taskAReservedStuck: boolean;
    taskBFullyRefunded: boolean;
    undeliveredPrepareReleases: boolean;
  }>;

  /** Atomic prepare→deliver→bad-claim rolls back; happy path then succeeds. */
  atomicRollback(): Promise<{ rolledBack: boolean; happyPathOk: boolean }>;

  /** Verdict code is bound in requestData; claim cannot choose freely. */
  verdictCodeBinding(): Promise<{ preparedCode: number; claimedCode: number; tamperRejected: boolean }>;

  /**
   * Forfeit clears coordinator Live occupancy / operator cap immediately without credit or
   * budget restore; replacement claim can proceed under ordinary index/cap rules.
   */
  forfeitOccupancyClearance(): Promise<{
    occupancyCleared: boolean;
    operatorCapCleared: boolean;
    noActivityCredit: boolean;
    spentOutPreserved: boolean;
    replacementProceeds: boolean;
  }>;
}

export type RevisedContractConformanceReport = {
  requestDataRoundTrip: true;
  claimWithoutRequestId: true;
  preparationEip1271: true;
  conservationAttackRefusal: true;
  atomicRollback: true;
  verdictCodeBinding: true;
  forfeitOccupancyClearance: true;
};

/**
 * Executable generic driver. Invokes every required proof against the port.
 * Throws on any failed invariant.
 */
export async function runRevisedContractConformance(
  port: RevisedContractConformancePort,
): Promise<RevisedContractConformanceReport> {
  const digest = keccak256(toBytes("conformance-digest"));
  const roundTripped = await port.roundTripRequestData({
    taskId: 7n,
    attemptIndex: 3,
    verdictIndex: 1,
    deliveryDigest: digest,
    verdictCode: 2,
    leg: "verdict",
  });
  assertRevisedRequestDataShape(roundTripped);
  if (roundTripped.verdictCode !== 2) {
    throw new Error("round-trip lost verdictCode");
  }

  const sol = await port.roundTripRequestData({
    taskId: 7n,
    attemptIndex: 3,
    verdictIndex: 0,
    deliveryDigest: digest,
    verdictCode: 0,
    leg: "solution",
  });
  if (sol.legKind !== REVISED_LEG_SOLUTION || sol.verdictCode !== 0) {
    throw new Error("solution round-trip shape invalid");
  }

  const arity = await port.claimWithoutRequestIdArg();
  // claimSolutionDelivery(mech, requestData, rate, paymentType, nonce) = 5
  // claimVerdictDelivery same = 5 (no free verdictCode)
  if (arity.solutionArity !== 5 || arity.verdictArity !== 5) {
    throw new Error(
      `claim must omit free-standing requestId and free verdictCode; got solution=${arity.solutionArity} verdict=${arity.verdictArity}`,
    );
  }

  const eip = await port.preparationAndEip1271();
  if (!eip.prepared || !eip.unpreparedRejected || !eip.preparedDelivered) {
    throw new Error("preparation/EIP-1271 invariants failed");
  }

  const conservation = await port.conservationAttackRefusal();
  if (
    !conservation.taskAReservedStuck ||
    !conservation.taskBFullyRefunded ||
    !conservation.undeliveredPrepareReleases
  ) {
    throw new Error("conservation attack refusal failed");
  }

  const atomic = await port.atomicRollback();
  if (!atomic.rolledBack || !atomic.happyPathOk) {
    throw new Error("atomic rollback invariants failed");
  }

  const verdict = await port.verdictCodeBinding();
  if (!verdict.tamperRejected || verdict.preparedCode !== verdict.claimedCode) {
    throw new Error("verdict-code binding failed");
  }

  const forfeit = await port.forfeitOccupancyClearance();
  if (
    !forfeit.occupancyCleared ||
    !forfeit.operatorCapCleared ||
    !forfeit.noActivityCredit ||
    !forfeit.spentOutPreserved ||
    !forfeit.replacementProceeds
  ) {
    throw new Error("forfeit occupancy clearance failed");
  }

  return {
    requestDataRoundTrip: true,
    claimWithoutRequestId: true,
    preparationEip1271: true,
    conservationAttackRefusal: true,
    atomicRollback: true,
    verdictCodeBinding: true,
    forfeitOccupancyClearance: true,
  };
}

/** Soft describe hook for suites that exercise deployed V4 contracts. */
export function describeRevisedContractConformance(
  label: string,
  run: () => void | Promise<void>,
): void {
  const describeFn = (globalThis as { describe?: (name: string, fn: () => void) => void }).describe;
  if (typeof describeFn === "function") {
    describeFn(`revised-contract-conformance: ${label}`, () => {
      void run();
    });
  } else {
    void run();
  }
}
