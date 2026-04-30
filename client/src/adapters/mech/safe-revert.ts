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

const KNOWN_INNER_ERRORS: Record<string, { name: string; params: string }> = {
  // ClaimRegistry
  '0xc8c9814b': { name: 'JobAlreadyClaimed', params: 'bytes32 requestId, address claimer' },
  '0x4684a763': { name: 'IneligibleToClaim', params: 'address provider, bytes32 requestId' },
  '0x76a168fd': { name: 'ClaimNotExpired', params: 'bytes32 requestId' },
  '0x75ba6595': { name: 'NotClaimOwner', params: 'address sender, bytes32 requestId' },
  '0x178fd52c': { name: 'NoClaimExists', params: 'bytes32 requestId' },
  // JinnRouterV2
  '0x1a387062': { name: 'RequestNotFound', params: 'bytes32 requestId' },
  '0xa6f3b939': { name: 'DeliveryAlreadyClaimed', params: 'bytes32 requestId' },
  '0xc8426484': { name: 'AlreadyClaimed', params: 'bytes32 requestId' },
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
]);

export function isNonRecoverableInnerRevert(name: string | null | undefined): boolean {
  return name != null && NON_RECOVERABLE_INNER_NAMES.has(name);
}
