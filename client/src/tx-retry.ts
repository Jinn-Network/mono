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
  /** Minimum bump over the previously submitted fee for same-sender nonce replacement. */
  replacementBumpBps: 1500,
  stuckNonceAfterMs: 120_000,
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
    if (decodedName != null && PERMANENT.has(decodedName)) return false;
    if (decodedName === 'RouterNotDelivered') return true;
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
  ledger?: TxSubmissionLedger;
  logicalTx?: string;
  stuckNonceAfterMs?: number;
  /** If set, invoked before each retry (attempt >= 1) for logging/metrics */
  onRetry?: (info: { attempt: number; error: unknown; message: string }) => void;
}

export interface TxFeeSnapshot {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

export interface TxSubmissionKey {
  chainId: number;
  from: Address;
  nonce: number;
}

export interface TxSubmissionLedgerEntry extends TxSubmissionKey {
  hash?: Hex;
  logicalTx?: string;
  submittedAtMs: number;
  fees: TxFeeSnapshot;
  to?: Address;
  value?: bigint;
  data?: Hex;
  resolvedAtMs?: number | null;
}

type MaybePromise<T> = T | Promise<T>;

export interface TxSubmissionLedger {
  getTxSubmission(key: TxSubmissionKey): MaybePromise<TxSubmissionLedgerEntry | null>;
  recordTxSubmission(entry: TxSubmissionLedgerEntry): MaybePromise<void>;
  markTxSubmissionResolved(key: TxSubmissionKey & { resolvedAtMs: number }): MaybePromise<void>;
}

export function createMemoryTxSubmissionLedger(): TxSubmissionLedger {
  const entries = new Map<string, TxSubmissionLedgerEntry>();
  const keyFor = (key: TxSubmissionKey) =>
    `${key.chainId}:${key.from.toLowerCase()}:${key.nonce}`;

  return {
    getTxSubmission(key) {
      return entries.get(keyFor(key)) ?? null;
    },
    recordTxSubmission(entry) {
      entries.set(keyFor(entry), { ...entry, resolvedAtMs: entry.resolvedAtMs ?? null });
    },
    markTxSubmissionResolved(key) {
      const existing = entries.get(keyFor(key));
      if (existing) entries.set(keyFor(key), { ...existing, resolvedAtMs: key.resolvedAtMs });
    },
  };
}

let defaultTxSubmissionLedger: TxSubmissionLedger = createMemoryTxSubmissionLedger();

export function setDefaultTxSubmissionLedger(ledger: TxSubmissionLedger): void {
  defaultTxSubmissionLedger = ledger;
}

export function getDefaultTxSubmissionLedger(): TxSubmissionLedger {
  return defaultTxSubmissionLedger;
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

/**
 * Poll publicClient.getCode until bytecode is present at `address`, or give up.
 *
 * Absorbs the RPC eventual-consistency race where a deployment tx receipt
 * returns success but a getCode call against a (possibly different,
 * load-balanced) node has not yet seen the block. Same shape as the post-bind
 * retry added in jinn-mono-h74p, applied to post-deploy verification.
 */
export async function waitForContractCode(
  publicClient: PublicClient,
  address: Address,
  options: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<Hex> {
  const maxAttempts = options.maxAttempts ?? 6;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 4_000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = await publicClient.getCode({ address });
    if (code !== undefined && code !== '0x') return code;
    if (attempt === maxAttempts - 1) break;
    await backoffDelay(attempt, baseDelayMs, maxDelayMs);
  }
  throw new Error(`No contract code at ${address} after ${maxAttempts} getCode attempts`);
}

function mulDivCeil(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return (value * numerator + denominator - 1n) / denominator;
}

function maxBigInt(...values: Array<bigint | undefined>): bigint | undefined {
  const present = values.filter((value): value is bigint => value !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((max, value) => (value > max ? value : max), present[0]!);
}

function replacementBump(value: bigint): bigint {
  return mulDivCeil(
    value,
    10000n + BigInt(TX_RETRY_DEFAULTS.replacementBumpBps),
    10000n,
  );
}

function attemptBump(value: bigint, attemptIndex: number): bigint {
  if (attemptIndex <= 0) return value;
  const bps = BigInt(TX_RETRY_DEFAULTS.feeBumpBpsPerAttempt) * BigInt(attemptIndex);
  return mulDivCeil(value, 10000n + bps, 10000n);
}

export function mergeFeeEstimateWithPrevious(
  current: TxFeeSnapshot,
  previous?: TxFeeSnapshot | null,
  attemptIndex = 0,
): TxFeeSnapshot {
  if (current.gasPrice !== undefined || previous?.gasPrice !== undefined) {
    const gasPrice = maxBigInt(
      current.gasPrice === undefined ? undefined : attemptBump(current.gasPrice, attemptIndex),
      previous?.gasPrice === undefined ? undefined : replacementBump(previous.gasPrice),
    );
    return gasPrice === undefined ? {} : { gasPrice };
  }

  const maxFeePerGas = maxBigInt(
    current.maxFeePerGas === undefined ? undefined : attemptBump(current.maxFeePerGas, attemptIndex),
    previous?.maxFeePerGas === undefined ? undefined : replacementBump(previous.maxFeePerGas),
  );
  const maxPriorityFeePerGas = maxBigInt(
    current.maxPriorityFeePerGas === undefined
      ? undefined
      : attemptBump(current.maxPriorityFeePerGas, attemptIndex),
    previous?.maxPriorityFeePerGas === undefined
      ? undefined
      : replacementBump(previous.maxPriorityFeePerGas),
  );
  if (maxFeePerGas !== undefined && maxPriorityFeePerGas !== undefined) {
    return { maxFeePerGas, maxPriorityFeePerGas };
  }
  return {};
}

/** EIP-1559 or legacy gas overrides for viem, increasingly aggressive on later attempts. */
export async function viemFeeOverridesForAttempt(
  publicClient: PublicClient,
  attemptIndex: number,
  options: {
    previousFees?: TxFeeSnapshot | null;
    forceEstimate?: boolean;
  } = {},
): Promise<
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { gasPrice: bigint }
  | Record<string, never>
> {
  if (attemptIndex <= 0 && !options.previousFees && !options.forceEstimate) return {};

  try {
    const fees = await publicClient.estimateFeesPerGas();
    if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
      return mergeFeeEstimateWithPrevious(
        {
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        },
        options.previousFees,
        attemptIndex,
      ) as { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    }
  } catch {
    // fall through to gasPrice
  }

  try {
    const gasPrice = await publicClient.getGasPrice();
    return mergeFeeEstimateWithPrevious(
      { gasPrice },
      options.previousFees,
      attemptIndex,
    ) as { gasPrice: bigint };
  } catch {
    return options.previousFees
      ? (mergeFeeEstimateWithPrevious({}, options.previousFees, attemptIndex) as
          | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
          | { gasPrice: bigint }
          | Record<string, never>)
      : {};
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

async function resolveTxChainId(publicClient: PublicClient): Promise<number> {
  return Number(await (publicClient as unknown as { getChainId: () => Promise<number | bigint> }).getChainId());
}

async function resolvePendingNonce(
  publicClient: PublicClient,
  from: Address,
): Promise<number> {
  return Number(await (publicClient as unknown as {
    getTransactionCount: (args: { address: Address; blockTag: 'pending' }) => Promise<number | bigint>;
  }).getTransactionCount({ address: from, blockTag: 'pending' }));
}

async function resolveLatestNonce(
  publicClient: PublicClient,
  from: Address,
): Promise<number> {
  return Number(await (publicClient as unknown as {
    getTransactionCount: (args: { address: Address; blockTag: 'latest' }) => Promise<number | bigint>;
  }).getTransactionCount({ address: from, blockTag: 'latest' }));
}

function accountAddress(account: unknown): Address | undefined {
  if (account && typeof account === 'object' && typeof (account as { address?: unknown }).address === 'string') {
    return (account as { address: Address }).address;
  }
  return undefined;
}

function supportsNonceTracking(publicClient: PublicClient): boolean {
  const client = publicClient as unknown as {
    getChainId?: unknown;
    getTransactionCount?: unknown;
  };
  return typeof client.getChainId === 'function' && typeof client.getTransactionCount === 'function';
}

function isEmptyFees(fees: TxFeeSnapshot): boolean {
  return fees.maxFeePerGas === undefined
    && fees.maxPriorityFeePerGas === undefined
    && fees.gasPrice === undefined;
}

export async function recoverStuckNonceIfNeeded(args: {
  publicClient: PublicClient;
  walletClient: { account?: unknown; sendTransaction: (tx: any) => Promise<Hex> };
  ledger?: TxSubmissionLedger;
  from: Address;
  staleAfterMs?: number;
  nowMs?: number;
}): Promise<{
  nonce: number;
  previousHash?: Hex;
  recoveryHash: Hex;
} | null> {
  const ledger = args.ledger ?? defaultTxSubmissionLedger;
  const chainId = await resolveTxChainId(args.publicClient);
  const [pendingNonce, latestNonce] = await Promise.all([
    resolvePendingNonce(args.publicClient, args.from),
    resolveLatestNonce(args.publicClient, args.from),
  ]);
  if (pendingNonce <= latestNonce) return null;

  const nowMs = args.nowMs ?? Date.now();
  const staleAfterMs = args.staleAfterMs ?? TX_RETRY_DEFAULTS.stuckNonceAfterMs;

  for (let nonce = latestNonce; nonce < pendingNonce; nonce++) {
    const entry = await ledger.getTxSubmission({ chainId, from: args.from, nonce });
    if (!entry || entry.resolvedAtMs != null) continue;
    if (nowMs - entry.submittedAtMs < staleAfterMs) continue;

    const feeOverrides = await viemFeeOverridesForAttempt(args.publicClient, 1, {
      previousFees: entry.fees,
      forceEstimate: true,
    });
    const account = args.walletClient.account;
    const tx = {
      account,
      to: args.from,
      value: 0n,
      nonce,
      ...feeOverrides,
    };
    if ('maxFeePerGas' in tx && 'maxPriorityFeePerGas' in tx) {
      delete (tx as { gasPrice?: bigint }).gasPrice;
    }
    const recoveryHash = await args.walletClient.sendTransaction(tx);
    const fees = feeOverrides as TxFeeSnapshot;
    await ledger.recordTxSubmission({
      chainId,
      from: args.from,
      nonce,
      hash: recoveryHash,
      logicalTx: 'stuck-nonce-recovery',
      submittedAtMs: nowMs,
      fees,
      to: args.from,
      value: 0n,
    });
    await args.publicClient.waitForTransactionReceipt({ hash: recoveryHash });
    await ledger.markTxSubmissionResolved({ chainId, from: args.from, nonce, resolvedAtMs: nowMs });
    return { nonce, previousHash: entry.hash, recoveryHash };
  }
  return null;
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
  const ledger = options.ledger ?? defaultTxSubmissionLedger;
  const from = accountAddress(txRequest.account);
  const shouldTrackNonce = from !== undefined && supportsNonceTracking(publicClient);
  const chainId = shouldTrackNonce ? await resolveTxChainId(publicClient) : undefined;
  if (from && shouldTrackNonce) {
    await recoverStuckNonceIfNeeded({
      publicClient,
      walletClient: walletClient as { account?: unknown; sendTransaction: (tx: any) => Promise<Hex> },
      ledger,
      from,
      staleAfterMs: options.stuckNonceAfterMs,
    });
  }
  const explicitNonce =
    txRequest.nonce !== undefined
      ? Number(txRequest.nonce)
      : from && shouldTrackNonce
        ? await resolvePendingNonce(publicClient, from)
        : undefined;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const previous =
        from && chainId !== undefined && explicitNonce !== undefined
          ? await ledger.getTxSubmission({ chainId, from, nonce: explicitNonce })
          : null;
      const overrides = await viemFeeOverridesForAttempt(publicClient, attempt, {
        previousFees: previous?.resolvedAtMs == null ? previous?.fees : undefined,
        forceEstimate: shouldTrackNonce,
      });
      const req = {
        ...txRequest,
        ...(explicitNonce !== undefined ? { nonce: explicitNonce } : {}),
        ...overrides,
      };
      
      // If we provided maxFeePerGas, ensure gasPrice is not somehow inherited
      if ('maxFeePerGas' in req && 'maxPriorityFeePerGas' in req) {
        delete (req as any).gasPrice;
      }

      const hash = await walletClient.sendTransaction(req);
      const fees = overrides as TxFeeSnapshot;
      if (from && chainId !== undefined && explicitNonce !== undefined && !isEmptyFees(fees)) {
        await ledger.recordTxSubmission({
          chainId,
          from,
          nonce: explicitNonce,
          hash,
          logicalTx: options.logicalTx,
          submittedAtMs: Date.now(),
          fees,
          to: txRequest.to,
          value: txRequest.value,
          data: txRequest.data,
        });
      }
      return hash;
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
