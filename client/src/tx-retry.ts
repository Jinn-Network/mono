/**
 * Shared retry policy for transient RPC / transaction submission failures.
 */

import type { Address, Hex, PublicClient, TransactionReceipt } from 'viem';


export const TX_RETRY_DEFAULTS = {
  maxAttempts: 6,
  baseDelayMs: 400,
  maxDelayMs: 12_000,
  /** Extra fee bump per retry attempt after the first (basis points, 1500 = +15%) */
  feeBumpBpsPerAttempt: 1500,
} as const;

export function flattenErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return String(error);
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    let s = error.message;
    const withCause = error as Error & { cause?: unknown };
    if (withCause.cause !== undefined && withCause.cause !== null) {
      s += ' | ' + flattenErrorMessage(withCause.cause);
    }
    return s;
  }
  if (typeof error === 'object') {
    const o = error as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof o.shortMessage === 'string') parts.push(o.shortMessage);
    if (typeof o.details === 'string') parts.push(o.details);
    if (typeof o.message === 'string' && !parts.includes(o.message)) parts.push(o.message);
    if (parts.length > 0) return parts.join(' | ');
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * True when the failure is often fixed by waiting, refreshing nonce/fees, or switching RPC timing.
 * Intentionally conservative: do not treat insufficient balance or user rejections as recoverable.
 */
export function isRecoverableTransactionError(error: unknown): boolean {
  const msg = flattenErrorMessage(error);
  const lower = msg.toLowerCase();

  if (lower.includes('insufficient funds')) return false;
  if (lower.includes('user rejected') || lower.includes('user denied')) return false;
  if (lower.includes('rejected the request')) return false;

  // SafeInnerRevertError carries the decoded inner revert (e.g. JobAlreadyClaimed
  // when another operator wins a same-block claim race). Permanent inner errors
  // can't unstick within the retry window — bail immediately so the daemon
  // surfaces the real reason instead of burning the retry budget.
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'SafeInnerRevertError') {
    const decodedName = (error as { decodedName?: string | null }).decodedName ?? null;
    const PERMANENT = new Set([
      'JobAlreadyClaimed',
      'IneligibleToClaim',
      'NoClaimExists',
      'NotClaimOwner',
      'DeliveryAlreadyClaimed',
      'AlreadyClaimed',
      'RequestNotFound',
    ]);
    if (decodedName != null && PERMANENT.has(decodedName)) return false;
    // Unknown decoded inner — fall through to generic GS013 handling
  }

  // Gnosis Safe 1.3.0 wraps every inner execTransaction revert as GS013 when
  // safeTxGas == 0 && gasPrice == 0. When the inner reason is decodable,
  // SafeInnerRevertError above handles it. The remaining GS013/GS026 path
  // covers stale-nonce signature races, which the `executeSafeTransaction`
  // retry self-heals by re-reading nonce and re-signing.
  if (msg.includes('GS013')) return true;
  if (msg.includes('GS026')) return true;

  if (
    lower.includes('replacement transaction underpriced') ||
    lower.includes('replacement fee too low') ||
    lower.includes('fee cap less than block base fee') ||
    lower.includes('max fee per gas less than block base fee') ||
    lower.includes('transaction underpriced')
  ) {
    return true;
  }

  if (
    lower.includes('nonce too low') ||
    lower.includes('already known') ||
    lower.includes('could not coalesce')
  ) {
    return true;
  }

  if (
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('socket hang up') ||
    lower.includes('fetch failed') ||
    lower.includes('network error') ||
    lower.includes('connection refused') ||
    lower.includes('connect timeout')
  ) {
    return true;
  }

  // Multi-node RPC eventual-consistency: a contract just deployed in a
  // confirmed transaction can briefly read as "no code" / "no data" on
  // a sibling node that has not yet propagated the block. viem surfaces
  // this as 'The contract function "..." returned no data ("0x").' or
  // 'Cannot decode zero data ("0x") with ABI parameters.' Retrying
  // a few hundred ms later usually reads the now-propagated state.
  if (
    lower.includes('returned no data ("0x")') ||
    lower.includes('cannot decode zero data') ||
    lower.includes('the address is not a contract')
  ) {
    return true;
  }

  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('-32603') ||
    lower.includes('internal json-rpc error') ||
    lower.includes('-32005') ||
    lower.includes('request timed out') ||
    lower.includes('timeout') ||
    lower.includes('bad gateway') ||
    lower.includes('service unavailable') ||
    lower.includes('502') ||
    lower.includes('503')
  ) {
    return true;
  }

  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function backoffDelay(
  attemptIndex: number,
  baseMs: number,
  maxMs: number,
): Promise<void> {
  const exp = Math.min(maxMs, baseMs * 2 ** attemptIndex);
  const jitter = Math.floor(Math.random() * Math.min(250, baseMs));
  await sleep(exp + jitter);
}

export interface TxRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** If set, invoked before each retry (attempt >= 1) for logging/metrics */
  onRetry?: (info: { attempt: number; error: unknown; message: string }) => void;
}

export async function withRecoverableRetry<T>(
  fn: (attemptIndex: number) => Promise<T>,
  options: TxRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? TX_RETRY_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? TX_RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? TX_RETRY_DEFAULTS.maxDelayMs;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (!isRecoverableTransactionError(err) || attempt >= maxAttempts - 1) {
        throw err;
      }
      const message = flattenErrorMessage(err);
      options.onRetry?.({ attempt: attempt + 1, error: err, message });
      await backoffDelay(attempt, baseDelayMs, maxDelayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** EIP-1559 or legacy gas overrides for viem, increasingly aggressive on later attempts. */
export async function viemFeeOverridesForAttempt(
  publicClient: PublicClient,
  attemptIndex: number,
): Promise<
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { gasPrice: bigint }
  | Record<string, never>
> {
  if (attemptIndex <= 0) return {};

  const bps = BigInt(TX_RETRY_DEFAULTS.feeBumpBpsPerAttempt) * BigInt(attemptIndex);
  const mult = 10000n + bps;
  const apply = (v: bigint) => (v * mult) / 10000n;

  try {
    const fees = await publicClient.estimateFeesPerGas();
    if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
      return {
        maxFeePerGas: apply(fees.maxFeePerGas),
        maxPriorityFeePerGas: apply(fees.maxPriorityFeePerGas),
      };
    }
  } catch {
    // fall through to gasPrice
  }

  try {
    const gasPrice = await publicClient.getGasPrice();
    return { gasPrice: apply(gasPrice) };
  } catch {
    return {};
  }
}

export async function waitForTransactionReceiptWithRetry(
  publicClient: PublicClient,
  hash: Hex,
  options: TxRetryOptions & { pollingInterval?: number; confirmations?: number } = {},
): Promise<TransactionReceipt> {
  const maxAttempts = options.maxAttempts ?? TX_RETRY_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? TX_RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? TX_RETRY_DEFAULTS.maxDelayMs;
  const pollingInterval = options.pollingInterval ?? 4_000;
  const confirmations = options.confirmations ?? 1;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval,
        confirmations,
      });
    } catch (err) {
      lastError = err;
      if (!isRecoverableTransactionError(err) || attempt >= maxAttempts - 1) {
        throw err;
      }
      options.onRetry?.({
        attempt: attempt + 1,
        error: err,
        message: flattenErrorMessage(err),
      });
      await backoffDelay(attempt, baseDelayMs, maxDelayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function viemSendTransactionWithRetry(
  walletClient: { sendTransaction: (tx: any) => Promise<Hex> },
  publicClient: PublicClient,
  txRequest: {
    account: any;
    to?: Address;
    data?: Hex;
    value?: bigint;
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
    [key: string]: any;
  },
  options: TxRetryOptions = {},
): Promise<Hex> {
  const maxAttempts = options.maxAttempts ?? TX_RETRY_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? TX_RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? TX_RETRY_DEFAULTS.maxDelayMs;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const overrides = await viemFeeOverridesForAttempt(publicClient, attempt);
      const req = { ...txRequest, ...overrides };
      
      // If we provided maxFeePerGas, ensure gasPrice is not somehow inherited
      if ('maxFeePerGas' in req && 'maxPriorityFeePerGas' in req) {
        delete (req as any).gasPrice;
      }

      return await walletClient.sendTransaction(req);
    } catch (err) {
      lastError = err;
      if (!isRecoverableTransactionError(err) || attempt >= maxAttempts - 1) {
        throw err;
      }
      options.onRetry?.({
        attempt: attempt + 1,
        error: err,
        message: flattenErrorMessage(err),
      });
      await backoffDelay(attempt, baseDelayMs, maxDelayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
