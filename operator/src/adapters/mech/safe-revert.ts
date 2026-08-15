import {
  decodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

/**
 * Safe v1.3 wraps every inner execTransaction revert as `GS013` whenever
 * `safeTxGas == 0 && gasPrice == 0` (see GnosisSafe.sol §execTransaction:
 * `require(success || safeTxGas != 0 || gasPrice != 0, "GS013")`). The
 * inner revert reason is discarded at the Safe boundary, so we re-simulate
 * the inner call as a static `eth_call` from the Safe address to recover
 * the original selector and arguments for diagnostics.
 */
export class SafeInnerRevertError extends Error {
  override readonly name = 'SafeInnerRevertError';
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

// Exported so the hermetic ABI/selector-conformance test (spec §5 — consumer-
// contract pairing) can assert each hardcoded selector still matches the
// keccak256 of its canonical error signature. A drifted entry silently
// mis-decodes (or fails to decode) a real on-chain revert.
export const KNOWN_INNER_ERRORS: Record<string, { name: string; params: string }> = {
  // JinnRouterV2
  '0x1a387062': { name: 'RequestNotFound', params: 'bytes32 requestId' },
  '0xa6f3b939': { name: 'DeliveryAlreadyClaimed', params: 'bytes32 requestId' },
  '0xc8426484': { name: 'AlreadyClaimed', params: 'bytes32 requestId' },
  // JinnRouterV3
  '0xd756e2d6': { name: 'RouterZeroAddress', params: '' },
  '0xfd3ed483': { name: 'RouterZeroValue', params: '' },
  '0xae02b05a': { name: 'RouterAlreadyInitialized', params: '' },
  '0xd9395835': { name: 'RouterNotInitialized', params: '' },
  '0x3739593e': { name: 'RouterOwnerOnly', params: 'address sender, address owner' },
  '0x4b774aa9': { name: 'RouterTaskNotFound', params: 'uint256 taskId' },
  '0x2051195c': { name: 'RouterTaskNotRefundable', params: 'uint256 taskId' },
  '0xa6b84382': { name: 'RouterRefundFailed', params: 'address receiver, uint256 amount' },
  '0x6fe4c8f6': { name: 'RouterInvalidPaymentType', params: 'bytes32 paymentType' },
  '0x19f8da4c': { name: 'RouterInvalidOperatorMech', params: 'address operator, address mech' },
  '0x096e300d': { name: 'RouterInsufficientTaskBudget', params: 'uint256 taskId, uint256 available, uint256 required' },
  '0xfb1ab358': { name: 'RouterRequestNotFound', params: 'bytes32 requestId' },
  '0x22d686d9': { name: 'RouterAlreadyClaimed', params: 'bytes32 requestId' },
  '0xe5a88624': { name: 'RouterNotDelivered', params: 'bytes32 requestId' },
  '0x008b227f': { name: 'RouterWrongRequester', params: 'bytes32 requestId, address requester' },
  '0x601188e3': { name: 'RouterWrongDeliveryOperator', params: 'bytes32 requestId, address expectedOperator, address deliveryMech' },
  '0x51cba8b3': { name: 'RouterWrongRequestKind', params: 'bytes32 requestId, uint8 expected, uint8 actual' },
  // TaskCoordinator
  '0x45faf3d4': { name: 'TCZeroAddress', params: '' },
  '0x545b063d': { name: 'TCZeroValue', params: '' },
  '0xbccf1a51': { name: 'TCAlreadyInitialized', params: '' },
  '0xe577ad72': { name: 'TCNotInitialized', params: '' },
  '0xb6557fdb': { name: 'TCOwnerOnly', params: 'address sender, address owner' },
  '0xe1a99172': { name: 'TCRouterOnly', params: 'address sender, address router' },
  '0x70f0e3e0': { name: 'TCTaskNotFound', params: 'uint256 taskId' },
  '0xeb5f97c2': { name: 'TCInvalidWindow', params: '' },
  '0x2a7fccab': { name: 'TCInvalidPolicy', params: '' },
  '0x6880f100': { name: 'TCTaskNotOpen', params: 'uint256 taskId' },
  '0x6d39d84a': { name: 'TCClaimWindowClosed', params: 'uint256 taskId' },
  '0xaab86453': { name: 'TCSubmissionDeadlinePassed', params: 'uint256 taskId' },
  '0x3187a525': { name: 'TCEvaluationDeadlinePassed', params: 'uint256 taskId' },
  '0x90386e7c': { name: 'TCMaxClaimsReached', params: 'uint256 taskId' },
  '0xead43eec': { name: 'TCOperatorClaimLimitReached', params: 'uint256 taskId, address operator' },
  '0x3d5d48f2': { name: 'TCPolicyHookRejected', params: 'uint256 taskId, address operator' },
  '0xdde6d1a3': { name: 'TCAttemptNotFound', params: 'uint256 taskId, uint32 attemptIndex' },
  '0xee12d1c6': { name: 'TCAttemptNotSubmitted', params: 'uint256 taskId, uint32 attemptIndex' },
  '0x3ddf1738': { name: 'TCAttemptNotClaimed', params: 'uint256 taskId, uint32 attemptIndex' },
  '0x4fd76d6d': { name: 'TCAttemptNotRegistered', params: 'uint256 taskId, uint32 attemptIndex' },
  '0x6687bc4c': { name: 'TCAttemptAlreadyRegistered', params: 'uint256 taskId, uint32 attemptIndex' },
  '0x7f02fe1e': { name: 'TCAttemptAlreadySubmitted', params: 'uint256 taskId, uint32 attemptIndex' },
  '0xbe465de7': { name: 'TCAttemptAlreadyFinalized', params: 'uint256 taskId, uint32 attemptIndex' },
  '0x8832f4bb': { name: 'TCRequestAlreadyRegistered', params: 'bytes32 requestId' },
  '0x8d1a709e': { name: 'TCRequestNotFound', params: 'bytes32 requestId' },
  '0x0d3eaf4a': { name: 'TCNotAttemptOperator', params: 'uint256 taskId, uint32 attemptIndex, address operator' },
  '0x3dbff820': { name: 'TCClaimNotExpired', params: 'uint256 taskId, uint32 attemptIndex' },
  '0x1c48587f': { name: 'TCAttemptClaimExpired', params: 'uint256 taskId, uint32 attemptIndex' },
  '0x1aed7019': { name: 'TCSolverSelfEvaluation', params: 'uint256 taskId, uint32 attemptIndex, address evaluator' },
  '0xb1497e24': { name: 'TCEvaluatorClaimLimitReached', params: 'uint256 taskId, uint32 attemptIndex, address evaluator' },
  '0x39d0ed4c': { name: 'TCMaxVerdictsReached', params: 'uint256 taskId, uint32 attemptIndex' },
  '0x0ae7c85b': { name: 'TCVerdictNotFound', params: 'uint256 taskId, uint32 attemptIndex, uint32 verdictIndex' },
  '0x2bf6c59a': { name: 'TCVerdictAlreadyRegistered', params: 'uint256 taskId, uint32 attemptIndex, uint32 verdictIndex' },
  '0xb88eae99': { name: 'TCVerdictAlreadyDelivered', params: 'uint256 taskId, uint32 attemptIndex, uint32 verdictIndex' },
  '0xda1597b1': { name: 'TCVerdictNotRegistered', params: 'uint256 taskId, uint32 attemptIndex, uint32 verdictIndex' },
  '0x2c7691be': { name: 'TCNotVerdictEvaluator', params: 'uint256 taskId, uint32 attemptIndex, uint32 verdictIndex, address evaluator' },
  '0x9d1b8dcc': { name: 'TCInvalidVerdictCode', params: 'uint8 verdictCode' },
  '0x748bfa13': { name: 'TCVerdictClaimExpired', params: 'uint256 taskId, uint32 attemptIndex, uint32 verdictIndex' },
};

interface InnerCallParams {
  safeAddress: Address;
  to: Address;
  value: bigint;
  data: Hex;
}

function extractRevertData(error: unknown): Hex | null {
  // viem CallExecutionError surfaces `data` on the cause's `data` field
  const candidates: unknown[] = [error];
  for (let i = 0; i < candidates.length && i < 8; i++) {
    const cur = candidates[i];
    if (cur && typeof cur === 'object') {
      const obj = cur as Record<string, unknown>;
      const data = obj.data;
      if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
        return data as Hex;
      }
      if (typeof data === 'object' && data !== null) {
        const inner = (data as Record<string, unknown>).data;
        if (typeof inner === 'string' && inner.startsWith('0x') && inner.length >= 10) {
          return inner as Hex;
        }
      }
      if (obj.cause) candidates.push(obj.cause);
      if (obj.walk && typeof obj.walk === 'function') {
        try { candidates.push((obj.walk as () => unknown)()); } catch { /* noop */ }
      }
    }
  }
  // Last resort: pull `0x...` revert data from the message
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/0x[a-fA-F0-9]{8,}/);
  return match ? (match[0] as Hex) : null;
}

function extractErrorSelector(error: unknown): Hex | null {
  const data = extractRevertData(error);
  if (data && data.length >= 10) return data.slice(0, 10).toLowerCase() as Hex;

  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/(?:signature|selector)\s*(?::|")?\s*(0x[a-fA-F0-9]{8})/i);
  return match?.[1] ? match[1].toLowerCase() as Hex : null;
}

/**
 * Structured result of decoding a known inner revert from an error.
 *
 * `name` is the bare revert identifier (e.g. `TCAttemptAlreadyFinalized`) — use
 * it for terminal-classification lookups (`isNonRecoverableInnerRevert`) so no
 * caller has to regex-unformat the `reason` string. `reason` is the
 * operator-facing formatted form (`Name(arg, arg)`), suitable for log lines.
 */
export interface KnownRevertDetail {
  /** Bare revert name from `KNOWN_INNER_ERRORS`. `null` when the selector is unknown. */
  name: string | null;
  /** Operator-facing formatted revert string. */
  reason: string;
}

/**
 * Decode a known inner revert into its structured `name` plus a formatted
 * `reason` string. Returns `null` only when no known selector can be extracted
 * — callers fall back to `flattenErrorMessage` in that case.
 */
export function formatKnownRevertDetail(error: unknown): KnownRevertDetail | null {
  const data = extractRevertData(error);
  const selector = extractErrorSelector(error);
  if (!selector) return null;
  const known = KNOWN_INNER_ERRORS[selector];
  if (!known) return null;
  if (!data || data.length <= 10) return { name: known.name, reason: known.name };
  try {
    const args = decodeAbiParameters(parseAbiParameters(known.params), `0x${data.slice(10)}` as Hex);
    return { name: known.name, reason: formatDecodedRevert(known.name, args) };
  } catch {
    return { name: known.name, reason: known.name };
  }
}

export function formatKnownRevert(error: unknown): string | null {
  return formatKnownRevertDetail(error)?.reason ?? null;
}

/**
 * Re-simulate the inner Safe call as an `eth_call` from the Safe address.
 * If the call reverts, decode the revert into a known selector + args.
 * Returns `null` for everything if the call now succeeds (transient race
 * that has since cleared).
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
  const fmt = decodedArgs.map((a) => {
    if (typeof a === 'bigint') return a.toString();
    if (typeof a === 'string') return a;
    return String(a);
  }).join(', ');
  return `${decodedName}(${fmt})`;
}

/** Inner reverts that mean "permanent failure for this requestId" — never worth retrying. */
const NON_RECOVERABLE_INNER_NAMES = new Set([
  'JobAlreadyClaimed',
  'IneligibleToClaim',
  'NoClaimExists',
  'NotClaimOwner',
  'DeliveryAlreadyClaimed',
  'AlreadyClaimed',
  'RequestNotFound',
  'RouterZeroAddress',
  'RouterZeroValue',
  'RouterAlreadyInitialized',
  'RouterNotInitialized',
  'RouterOwnerOnly',
  'RouterTaskNotFound',
  'RouterTaskNotRefundable',
  'RouterRefundFailed',
  'RouterInvalidPaymentType',
  'RouterInvalidOperatorMech',
  'RouterInsufficientTaskBudget',
  'RouterRequestNotFound',
  'RouterAlreadyClaimed',
  'RouterWrongRequester',
  'RouterWrongDeliveryOperator',
  'RouterWrongRequestKind',
  'TCZeroAddress',
  'TCZeroValue',
  'TCAlreadyInitialized',
  'TCNotInitialized',
  'TCOwnerOnly',
  'TCRouterOnly',
  'TCTaskNotFound',
  'TCInvalidWindow',
  'TCInvalidPolicy',
  'TCTaskNotOpen',
  'TCClaimWindowClosed',
  'TCSubmissionDeadlinePassed',
  'TCEvaluationDeadlinePassed',
  'TCMaxClaimsReached',
  'TCOperatorClaimLimitReached',
  'TCPolicyHookRejected',
  'TCAttemptNotFound',
  'TCAttemptNotSubmitted',
  'TCAttemptNotClaimed',
  'TCAttemptNotRegistered',
  'TCAttemptAlreadyRegistered',
  'TCAttemptAlreadySubmitted',
  'TCAttemptAlreadyFinalized',
  'TCRequestAlreadyRegistered',
  'TCRequestNotFound',
  'TCNotAttemptOperator',
  'TCClaimNotExpired',
  'TCAttemptClaimExpired',
  'TCSolverSelfEvaluation',
  'TCEvaluatorClaimLimitReached',
  'TCMaxVerdictsReached',
  'TCVerdictNotFound',
  'TCVerdictAlreadyRegistered',
  'TCVerdictAlreadyDelivered',
  'TCVerdictNotRegistered',
  'TCNotVerdictEvaluator',
  'TCInvalidVerdictCode',
  'TCVerdictClaimExpired',
]);

export function isNonRecoverableInnerRevert(name: string | null | undefined): boolean {
  return name != null && NON_RECOVERABLE_INNER_NAMES.has(name);
}
