/**
 * Executable revised-contract conformance driver for M7 fix-round prepare-settlement.
 *
 * Generic: no Hardhat/ethers dependency. Concrete deployments wire
 * {@link RevisedContractConformancePort} (see contracts Hardhat adapter).
 */

import {
  REVISED_LEG_SOLUTION,
  REVISED_LEG_VERDICT,
  assertRevisedRequestDataShape,
  type RevisedRequestData,
} from "@jinn-network/marketplace-binding";
import { keccak256, toBytes } from "viem";
export {
  REVISED_DOMAIN_HASH,
  REVISED_LEG_SOLUTION,
  REVISED_LEG_VERDICT,
  REVISED_REQUEST_DATA_DOMAIN,
  REVISED_REQUEST_DATA_VERSION,
  REVISED_SOLUTION_VERDICT_CODE_SENTINEL,
  REVISED_SOLUTION_VERDICT_SENTINEL,
  assertRevisedRequestDataShape,
  decodeRevisedRequestData,
  encodeRevisedSolutionRequestData,
  encodeRevisedVerdictRequestData,
} from "@jinn-network/marketplace-binding";
export type { RevisedRequestData } from "@jinn-network/marketplace-binding";

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
