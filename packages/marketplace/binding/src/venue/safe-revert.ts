// SPDX-License-Identifier: MIT

// Re-homed from `operator/src/adapters/mech/safe-revert.ts` (design §14 "declared impact"); this
// module was already standalone (viem-only), so it ports verbatim except for the trimmed
// `KNOWN_INNER_ERRORS`/`NON_RECOVERABLE_INNER_NAMES` tables, which keep only the JinnRouterV3 +
// TaskCoordinator selectors this binding actually calls into (posting today; claim/deliver at
// Milestone M3) -- the legacy JinnRouterV2 entries are dropped as dead weight (Rule 2).
import { decodeAbiParameters, parseAbiParameters, type Address, type Hex, type PublicClient } from "viem";

/**
 * Safe v1.3 wraps every inner `execTransaction` revert as `GS013` whenever
 * `safeTxGas == 0 && gasPrice == 0` (see GnosisSafe.sol §execTransaction:
 * `require(success || safeTxGas != 0 || gasPrice != 0, "GS013")`). The inner revert reason is
 * discarded at the Safe boundary, so we re-simulate the inner call as a static `eth_call` from
 * the Safe address to recover the original selector and arguments for diagnostics.
 */
export class SafeInnerRevertError extends Error {
  override readonly name = "SafeInnerRevertError";
  constructor(
    message: string,
    readonly innerSelector: Hex | null,
    readonly innerData: Hex | null,
    readonly decodedName: string | null,
    readonly decodedArgs: readonly unknown[] | null,
    readonly txHash: Hex | null,
  ) {
    super(message);
  }
}

/** Selector -> {name, params} for the JinnRouterV3 + TaskCoordinator custom errors this binding surfaces. */
export const KNOWN_INNER_ERRORS: Record<string, { name: string; params: string }> = {
  "0xd756e2d6": { name: "RouterZeroAddress", params: "" },
  "0xfd3ed483": { name: "RouterZeroValue", params: "" },
  "0xae02b05a": { name: "RouterAlreadyInitialized", params: "" },
  "0xd9395835": { name: "RouterNotInitialized", params: "" },
  "0x3739593e": { name: "RouterOwnerOnly", params: "address sender, address owner" },
  "0x4b774aa9": { name: "RouterTaskNotFound", params: "uint256 taskId" },
  "0x2051195c": { name: "RouterTaskNotRefundable", params: "uint256 taskId" },
  "0xa6b84382": { name: "RouterRefundFailed", params: "address receiver, uint256 amount" },
  "0x6fe4c8f6": { name: "RouterInvalidPaymentType", params: "bytes32 paymentType" },
  "0x19f8da4c": { name: "RouterInvalidOperatorMech", params: "address operator, address mech" },
  "0x096e300d": {
    name: "RouterInsufficientTaskBudget",
    params: "uint256 taskId, uint256 available, uint256 required",
  },
  "0xfb1ab358": { name: "RouterRequestNotFound", params: "bytes32 requestId" },
  "0x22d686d9": { name: "RouterAlreadyClaimed", params: "bytes32 requestId" },
  "0xe5a88624": { name: "RouterNotDelivered", params: "bytes32 requestId" },
  "0x008b227f": { name: "RouterWrongRequester", params: "bytes32 requestId, address requester" },
  "0x601188e3": {
    name: "RouterWrongDeliveryOperator",
    params: "bytes32 requestId, address expectedOperator, address deliveryMech",
  },
  "0x51cba8b3": { name: "RouterWrongRequestKind", params: "bytes32 requestId, uint8 expected, uint8 actual" },
  "0x45faf3d4": { name: "TCZeroAddress", params: "" },
  "0x545b063d": { name: "TCZeroValue", params: "" },
  "0xbccf1a51": { name: "TCAlreadyInitialized", params: "" },
  "0xe577ad72": { name: "TCNotInitialized", params: "" },
  "0xb6557fdb": { name: "TCOwnerOnly", params: "address sender, address owner" },
  "0xe1a99172": { name: "TCRouterOnly", params: "address sender, address router" },
  "0x70f0e3e0": { name: "TCTaskNotFound", params: "uint256 taskId" },
  "0xeb5f97c2": { name: "TCInvalidWindow", params: "" },
  "0x2a7fccab": { name: "TCInvalidPolicy", params: "" },
  "0x6880f100": { name: "TCTaskNotOpen", params: "uint256 taskId" },
  "0x6d39d84a": { name: "TCClaimWindowClosed", params: "uint256 taskId" },
  "0xaab86453": { name: "TCSubmissionDeadlinePassed", params: "uint256 taskId" },
  "0x3187a525": { name: "TCEvaluationDeadlinePassed", params: "uint256 taskId" },
  "0x90386e7c": { name: "TCMaxClaimsReached", params: "uint256 taskId" },
  "0xead43eec": { name: "TCOperatorClaimLimitReached", params: "uint256 taskId, address operator" },
  "0x3d5d48f2": { name: "TCPolicyHookRejected", params: "uint256 taskId, address operator" },
  "0xdde6d1a3": { name: "TCAttemptNotFound", params: "uint256 taskId, uint32 attemptIndex" },
  "0xee12d1c6": { name: "TCAttemptNotSubmitted", params: "uint256 taskId, uint32 attemptIndex" },
  "0x3ddf1738": { name: "TCAttemptNotClaimed", params: "uint256 taskId, uint32 attemptIndex" },
  "0x4fd76d6d": { name: "TCAttemptNotRegistered", params: "uint256 taskId, uint32 attemptIndex" },
  "0x6687bc4c": { name: "TCAttemptAlreadyRegistered", params: "uint256 taskId, uint32 attemptIndex" },
  "0x7f02fe1e": { name: "TCAttemptAlreadySubmitted", params: "uint256 taskId, uint32 attemptIndex" },
  "0xbe465de7": { name: "TCAttemptAlreadyFinalized", params: "uint256 taskId, uint32 attemptIndex" },
  "0x8832f4bb": { name: "TCRequestAlreadyRegistered", params: "bytes32 requestId" },
  "0x8d1a709e": { name: "TCRequestNotFound", params: "bytes32 requestId" },
  "0x0d3eaf4a": { name: "TCNotAttemptOperator", params: "uint256 taskId, uint32 attemptIndex, address operator" },
  "0x3dbff820": { name: "TCClaimNotExpired", params: "uint256 taskId, uint32 attemptIndex" },
  "0x1c48587f": { name: "TCAttemptClaimExpired", params: "uint256 taskId, uint32 attemptIndex" },
  "0x1aed7019": { name: "TCSolverSelfEvaluation", params: "uint256 taskId, uint32 attemptIndex, address evaluator" },
  "0xb1497e24": {
    name: "TCEvaluatorClaimLimitReached",
    params: "uint256 taskId, uint32 attemptIndex, address evaluator",
  },
  "0x39d0ed4c": { name: "TCMaxVerdictsReached", params: "uint256 taskId, uint32 attemptIndex" },
  "0x0ae7c85b": { name: "TCVerdictNotFound", params: "uint256 taskId, uint32 attemptIndex, uint32 verdictIndex" },
  "0x2bf6c59a": {
    name: "TCVerdictAlreadyRegistered",
    params: "uint256 taskId, uint32 attemptIndex, uint32 verdictIndex",
  },
  "0xb88eae99": {
    name: "TCVerdictAlreadyDelivered",
    params: "uint256 taskId, uint32 attemptIndex, uint32 verdictIndex",
  },
  "0xda1597b1": {
    name: "TCVerdictNotRegistered",
    params: "uint256 taskId, uint32 attemptIndex, uint32 verdictIndex",
  },
  "0x2c7691be": {
    name: "TCNotVerdictEvaluator",
    params: "uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, address evaluator",
  },
  "0x9d1b8dcc": { name: "TCInvalidVerdictCode", params: "uint8 verdictCode" },
  "0x748bfa13": {
    name: "TCVerdictClaimExpired",
    params: "uint256 taskId, uint32 attemptIndex, uint32 verdictIndex",
  },
};

interface InnerCallParams {
  safeAddress: Address;
  to: Address;
  value: bigint;
  data: Hex;
}

function extractRevertData(error: unknown): Hex | null {
  const candidates: unknown[] = [error];
  for (let i = 0; i < candidates.length && i < 8; i++) {
    const cur = candidates[i];
    if (cur && typeof cur === "object") {
      const obj = cur as Record<string, unknown>;
      const data = obj.data;
      if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
        return data as Hex;
      }
      if (typeof data === "object" && data !== null) {
        const inner = (data as Record<string, unknown>).data;
        if (typeof inner === "string" && inner.startsWith("0x") && inner.length >= 10) {
          return inner as Hex;
        }
      }
      if (obj.cause) candidates.push(obj.cause);
      if (obj.walk && typeof obj.walk === "function") {
        try {
          candidates.push((obj.walk as () => unknown)());
        } catch {
          /* noop */
        }
      }
    }
  }
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/0x[a-fA-F0-9]{8,}/);
  return match ? (match[0] as Hex) : null;
}

export interface KnownRevertDetail {
  name: string | null;
  reason: string;
}

export function formatKnownRevertDetail(error: unknown): KnownRevertDetail | null {
  const data = extractRevertData(error);
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const known = KNOWN_INNER_ERRORS[selector];
  if (!known) return null;
  if (data.length <= 10) return { name: known.name, reason: known.name };
  try {
    const args = decodeAbiParameters(parseAbiParameters(known.params), `0x${data.slice(10)}` as Hex);
    return { name: known.name, reason: formatDecodedRevert(known.name, args) };
  } catch {
    return { name: known.name, reason: known.name };
  }
}

/**
 * Re-simulate the inner Safe call as an `eth_call` from the Safe address. If the call reverts,
 * decode the revert into a known selector + args. Returns all-null when the call now succeeds
 * (a transient race that has since cleared).
 */
export async function decodeSafeInnerRevert(
  publicClient: PublicClient,
  params: InnerCallParams,
): Promise<{
  innerSelector: Hex | null;
  innerData: Hex | null;
  decodedName: string | null;
  decodedArgs: readonly unknown[] | null;
}> {
  try {
    await publicClient.call({
      account: params.safeAddress,
      to: params.to,
      data: params.data,
      value: params.value,
    });
    return { innerSelector: null, innerData: null, decodedName: null, decodedArgs: null };
  } catch (err) {
    const data = extractRevertData(err);
    if (!data || data.length < 10) {
      return { innerSelector: null, innerData: null, decodedName: null, decodedArgs: null };
    }
    const selector = data.slice(0, 10).toLowerCase() as Hex;
    const known = KNOWN_INNER_ERRORS[selector];
    if (!known) {
      return { innerSelector: selector, innerData: data, decodedName: null, decodedArgs: null };
    }
    try {
      const args = decodeAbiParameters(parseAbiParameters(known.params), `0x${data.slice(10)}` as Hex);
      return { innerSelector: selector, innerData: data, decodedName: known.name, decodedArgs: args };
    } catch {
      return { innerSelector: selector, innerData: data, decodedName: known.name, decodedArgs: null };
    }
  }
}

export function formatDecodedRevert(decodedName: string, decodedArgs: readonly unknown[] | null): string {
  if (!decodedArgs) return decodedName;
  const fmt = decodedArgs
    .map((a) => {
      if (typeof a === "bigint") return a.toString();
      if (typeof a === "string") return a;
      return String(a);
    })
    .join(", ");
  return `${decodedName}(${fmt})`;
}
