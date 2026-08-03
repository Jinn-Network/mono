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

export const SAFE_STALE_NONCE_ERROR_TOKEN = 'possible stale Safe nonce or signature race';

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

  const errorName = error && typeof error === 'object'
    ? (error as { name?: unknown }).name
    : undefined;
  if (
    errorName === 'SafeBroadcastFenceError'
    || errorName === 'SafePostBroadcastHookError'
  ) {
    return false;
  }

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
    // Reaching here the inner reason has no known name. If re-simulation still
    // captured a raw selector, the inner call reverts deterministically (an
    // undecoded custom error such as TACTaskAlreadyCredited, 0x33f626d3) — it
    // will revert identically on every retry, so classify it terminal instead
    // of retrying the wrapping GS013 forever. Only when there is no selector
    // (re-simulation found no inner revert) do we fall through to the string
    // checks below.
    const innerSelector = (error as { innerSelector?: string | null }).innerSelector ?? null;
    if (innerSelector != null) return false;
  }

  // Gnosis Safe 1.3.0 error codes. A bare GS026 reaching this shared classifier
  // is terminal; safe.ts first distinguishes valid owners (stale signed nonce,
  // retryable via SAFE_STALE_NONCE_ERROR_TOKEN) from non-owners (issue #1986).
  // GS013 = require(success || safeTxGas != 0
  // || gasPrice != 0): the Safe's INNER call reverted, which is deterministic
  // and never clears on retry. Decodable inner reverts are already classified
  // above via SafeInnerRevertError; a bare GS013 reaching here (e.g. an
  // estimate-path revert whose custom-error selector we don't decode) must fail
  // fast rather than wedge the loop.
  if (msg.includes('GS026')) return false;
  if (msg.includes('GS013')) return false;

  // Receipt path from safe.ts: inner re-simulation succeeded but the mined
  // execTransaction reverted — a stale Safe nonce / signature race that
  // re-read + re-sign self-heals within executeSafeTransaction's retry loop.
  if (msg.includes(SAFE_STALE_NONCE_ERROR_TOKEN)) return true;

  if (
    isReplacementUnderpricedError(error) ||
    lower.includes('fee cap less than block base fee') ||
    lower.includes('max fee per gas less than block base fee')
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
    lower.includes('connect timeout') ||
    // viem fallback() throws this when EVERY provider in the chain failed the
    // request at once (transient multi-provider blip). A decodable inner revert
    // is caught earlier (SafeInnerRevertError / GS013 / GS026), so reaching here
    // with this message means a transport-level failure — retry hits a healthy
    // provider instead of failing the claim/deliver task outright.
    lower.includes('all rpc providers in the fallback chain failed')
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

/**
 * True when the error message contains the RPC's "nonce too low" signal.
 *
 * Issue #562: a daemon respawn can leave the locally-pinned ledger nonce
 * behind the RPC's pending nonce, and every retry that re-submits with the
 * stale value triggers this error. Callers use this helper to decide whether
 * to refresh the pinned nonce before the next retry attempt.
 */
export function isNonceTooLowError(error: unknown): boolean {
  return flattenErrorMessage(error).toLowerCase().includes('nonce too low');
}

/**
 * True when the RPC rejected an `eth_sendRawTransaction` because a tx already
 * occupies the target nonce and the resubmission's fee bump was insufficient to
 * replace it ("replacement underpriced"). Distinct from `nonce too low`: the
 * original tx is still PENDING at this nonce, not yet mined.
 *
 * Issue #897: the Safe execTransaction retry uses this to refresh the pinned
 * nonce before the next fee bump and to trigger a reconcile against the
 * pending original tx (it may mine mid-retry). The substrings mirror the
 * replacement branch of `isRecoverableTransactionError`.
 */
export function isReplacementUnderpricedError(error: unknown): boolean {
  const lower = flattenErrorMessage(error).toLowerCase();
  return (
    lower.includes('replacement transaction underpriced') ||
    lower.includes('replacement fee too low') ||
    lower.includes('transaction underpriced')
  );
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
  /**
   * Invoked synchronously after the wallet returns a transaction hash and
   * before any awaited nonce-ledger bookkeeping. A failure is post-broadcast
   * and is therefore never retried.
   */
  onBroadcast?: (txHash: Hex) => void;
  /** If set, invoked before each retry (attempt >= 1) for logging/metrics */
  onRetry?: (info: { attempt: number; error: unknown; message: string }) => void;
}

export interface TxFeeSnapshot {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

export type Eip1559FeeOverrides = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasPrice?: undefined;
};

export type LegacyFeeOverrides = {
  gasPrice: bigint;
  maxFeePerGas?: undefined;
  maxPriorityFeePerGas?: undefined;
};

export type EmptyFeeOverrides = {
  maxFeePerGas?: undefined;
  maxPriorityFeePerGas?: undefined;
  gasPrice?: undefined;
};

export type TxFeeOverrides = Eip1559FeeOverrides | LegacyFeeOverrides | EmptyFeeOverrides;

export type TxFeeOverrideResult =
  | { kind: 'eip1559'; overrides: Eip1559FeeOverrides; snapshot: TxFeeSnapshot }
  | { kind: 'legacy'; overrides: LegacyFeeOverrides; snapshot: TxFeeSnapshot }
  | { kind: 'none'; overrides: EmptyFeeOverrides; snapshot: TxFeeSnapshot };

export type TxRecoveryTransactionRequest = TxFeeOverrides & {
  account?: unknown;
  to: Address;
  value: bigint;
  nonce: number;
};

export interface TxRecoveryWalletClient {
  account?: unknown;
  sendTransaction(tx: TxRecoveryTransactionRequest): Promise<Hex>;
}

export type TxRetryTransactionRequest = TxFeeOverrides & {
  account?: unknown;
  to?: Address;
  data?: Hex;
  value?: bigint;
  gas?: bigint;
  nonce?: number;
  [key: string]: unknown;
};

export interface TxRetryWalletClient {
  account?: unknown;
  sendTransaction(tx: TxRetryTransactionRequest): Promise<Hex>;
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

export interface NonceLedgerSubmission {
  hash?: Hex;
  logicalTx?: string;
  submittedAtMs?: number;
  fees: TxFeeSnapshot;
  to?: Address;
  value?: bigint;
  data?: Hex;
}

export interface NonceLedgerContext {
  ledger: TxSubmissionLedger;
  chainId: number;
  from: Address;
  nonce: number;
  feeResultForAttempt(
    attemptIndex: number,
    options?: { forceEstimate?: boolean },
  ): Promise<TxFeeOverrideResult>;
  recordSubmitted(entry: NonceLedgerSubmission): Promise<void>;
  markResolved(resolvedAtMs?: number): Promise<void>;
  /**
   * Re-read the pending nonce from the RPC, update `nonce` in place, and
   * return the new value. Callers use this after a `nonce too low` revert
   * (issue #562) so the next retry attempt picks up the fresh value.
   */
  refreshNonce(): Promise<number>;
}

export interface WithNonceLedgerArgs {
  publicClient: PublicClient;
  walletClient?: TxRecoveryWalletClient;
  ledger?: TxSubmissionLedger;
  from: Address;
  nonce?: number;
  chainId?: number;
  recoverStuckNonce?: boolean;
  staleAfterMs?: number;
}

// ── Per-EOA broadcast serialization (issue #525/#562/#897 nonce-collision) ──
//
// Multiple daemon/CLI subsystems broadcast transactions from the SAME agent EOA:
//   - venue-base's `createSafeBroadcaster` (creator / claim / deliver loops,
//     Safe-mediated) — holds venue-base's own durable, SQLite-backed
//     `BroadcastLock`, keyed on `(chainId, sender)`, that ALSO excludes other
//     processes sharing the same state file.
//   - IdentityPublisher.setMetadata (launch + per-execution anchors),
//     eviction-recovery distributor.reStake, and the rest of this module's
//     `withNonceLedger` / `viemSendTransactionWithRetry` callers — go through
//     `withEoaBroadcastLock` below.
//
// Each independently reads the EOA's `pending` transaction count to choose a
// nonce. When two run concurrently they read the SAME pending nonce, assign it
// to two different transactions, and the second to land reverts "nonce too
// low" (or silently replaces the first). Left on its own, `withEoaBroadcastLock`
// only serializes calls THROUGH THIS MODULE against each other — it has no way
// to see venue-base's SQLite lock, so a venue-base Safe broadcast and an
// EOA-direct `setMetadata` could still race.
//
// `setDefaultEoaBroadcastLock` closes that gap: the composition root that
// builds a venue also builds this module's default lock as a thin adapter over
// that SAME `BroadcastLock` instance (bound to the composition's one chainId),
// so both domains funnel through one lock. Hosts that never install one (unit
// tests, one-shot CLI verbs with no venue-base state to borrow a lock from)
// fall back to the plain in-process queue below — identical to this module's
// pre-existing behavior, so single-path callers see no change (issue #525's
// original fix, kept as the default).
export interface EoaBroadcastLock {
  withSender<T>(from: Address, fn: () => Promise<T>): Promise<T>;
}

function createInProcessEoaBroadcastLock(): EoaBroadcastLock {
  // In-process-only queue, keyed by the lowercased `from` address so two
  // different EOAs never block each other. Tolerates `fn` rejecting (the lock
  // is always released in `finally`), and cannot see any lock outside this
  // module instance — that is exactly the gap `setDefaultEoaBroadcastLock`
  // exists to close for hosts that have a durable, cross-domain lock to share.
  const locks = new Map<string, Promise<unknown>>();
  return {
    async withSender<T>(from: Address, fn: () => Promise<T>): Promise<T> {
      const key = from.toLowerCase();
      // Chain onto any in-flight broadcast for this EOA. We await the prior
      // promise's settlement (success OR failure) before proceeding, so a
      // failed predecessor never deadlocks its successors.
      const prior = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      // The stored promise resolves when THIS holder releases — successors await it.
      locks.set(key, gate);
      await prior.catch(() => { /* predecessor failure must not block the queue */ });
      try {
        return await fn();
      } finally {
        release();
        // Clean up the map entry if we are the tail of the queue, so the Map
        // does not grow unbounded across many EOAs over a long-lived daemon.
        if (locks.get(key) === gate) {
          locks.delete(key);
        }
      }
    },
  };
}

let defaultEoaBroadcastLock: EoaBroadcastLock = createInProcessEoaBroadcastLock();

/**
 * Install the process-wide default `EoaBroadcastLock` that `withEoaBroadcastLock`
 * (and therefore `withNonceLedger`) delegates to. The composition root calls this
 * once, right after building its venue, with an adapter over that venue's own
 * `BroadcastLock` — see `client/src/daemon/composition-root.ts`.
 */
export function setDefaultEoaBroadcastLock(lock: EoaBroadcastLock): void {
  defaultEoaBroadcastLock = lock;
}

export function getDefaultEoaBroadcastLock(): EoaBroadcastLock {
  return defaultEoaBroadcastLock;
}

/**
 * Run `fn` while holding an exclusive per-EOA broadcast lock. Concurrent calls
 * for the same `from` address are serialized; calls for different addresses
 * proceed in parallel. The returned promise resolves/rejects with `fn`'s
 * result, and the lock is released whether `fn` succeeds or throws.
 *
 * Delegates to the installed default lock (see `setDefaultEoaBroadcastLock`) —
 * an in-process-only queue unless a host has wired in something durable.
 * Exported for tests and for non-ledger broadcast paths that still need to
 * share the EOA serialization (e.g. a raw `writeContract` that opts in).
 */
export async function withEoaBroadcastLock<T>(
  from: Address,
  fn: () => Promise<T>,
): Promise<T> {
  return defaultEoaBroadcastLock.withSender(from, fn);
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

function feeOverrideResultFromSnapshot(snapshot: TxFeeSnapshot): TxFeeOverrideResult {
  if (snapshot.maxFeePerGas !== undefined && snapshot.maxPriorityFeePerGas !== undefined) {
    const overrides: Eip1559FeeOverrides = {
      maxFeePerGas: snapshot.maxFeePerGas,
      maxPriorityFeePerGas: snapshot.maxPriorityFeePerGas,
    };
    return { kind: 'eip1559', overrides, snapshot: overrides };
  }

  if (snapshot.gasPrice !== undefined) {
    const overrides: LegacyFeeOverrides = { gasPrice: snapshot.gasPrice };
    return { kind: 'legacy', overrides, snapshot: overrides };
  }

  return { kind: 'none', overrides: {}, snapshot: {} };
}

/**
 * EIP-1559 or legacy gas overrides for viem, increasingly aggressive on later attempts.
 *
 * The result carries both the spreadable viem transaction overrides and the
 * ledger snapshot, keeping call sites from recasting the override object.
 */
export async function viemFeeOverrideResultForAttempt(
  publicClient: PublicClient,
  attemptIndex: number,
  options: {
    previousFees?: TxFeeSnapshot | null;
    forceEstimate?: boolean;
  } = {},
): Promise<TxFeeOverrideResult> {
  if (attemptIndex <= 0 && !options.previousFees && !options.forceEstimate) {
    return feeOverrideResultFromSnapshot({});
  }

  try {
    const fees = await publicClient.estimateFeesPerGas();
    if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
      return feeOverrideResultFromSnapshot(
        mergeFeeEstimateWithPrevious(
          {
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          },
          options.previousFees,
          attemptIndex,
        ),
      );
    }
  } catch {
    // fall through to gasPrice
  }

  try {
    const gasPrice = await publicClient.getGasPrice();
    return feeOverrideResultFromSnapshot(
      mergeFeeEstimateWithPrevious(
        { gasPrice },
        options.previousFees,
        attemptIndex,
      ),
    );
  } catch {
    return options.previousFees
      ? feeOverrideResultFromSnapshot(mergeFeeEstimateWithPrevious({}, options.previousFees, attemptIndex))
      : feeOverrideResultFromSnapshot({});
  }
}

/** EIP-1559 or legacy gas overrides for viem, increasingly aggressive on later attempts. */
export async function viemFeeOverridesForAttempt(
  publicClient: PublicClient,
  attemptIndex: number,
  options: {
    previousFees?: TxFeeSnapshot | null;
    forceEstimate?: boolean;
  } = {},
): Promise<TxFeeOverrides> {
  return (await viemFeeOverrideResultForAttempt(publicClient, attemptIndex, options)).overrides;
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
  return Number(await publicClient.getChainId());
}

async function resolvePendingNonce(
  publicClient: PublicClient,
  from: Address,
): Promise<number> {
  return Number(await publicClient.getTransactionCount({ address: from, blockTag: 'pending' }));
}

async function resolveLatestNonce(
  publicClient: PublicClient,
  from: Address,
): Promise<number> {
  return Number(await publicClient.getTransactionCount({ address: from, blockTag: 'latest' }));
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

export function removeConflictingLegacyGasPrice<T extends TxFeeSnapshot>(tx: T): void {
  if (tx.maxFeePerGas !== undefined && tx.maxPriorityFeePerGas !== undefined) {
    delete tx.gasPrice;
  }
}

function withoutFeeOverrides<T extends TxFeeSnapshot>(tx: T): Omit<T, keyof TxFeeSnapshot> {
  const {
    maxFeePerGas: _maxFeePerGas,
    maxPriorityFeePerGas: _maxPriorityFeePerGas,
    gasPrice: _gasPrice,
    ...baseRequest
  } = tx;
  return baseRequest;
}

export async function withNonceLedger<T>(
  args: WithNonceLedgerArgs,
  fn: (context: NonceLedgerContext) => Promise<T>,
): Promise<T> {
  // Serialize the whole nonce-read → send → record section per EOA so two
  // concurrent broadcasters from the same `from` address cannot read the same
  // `pending` nonce and collide ("nonce too low"). See `withEoaBroadcastLock`.
  return withEoaBroadcastLock(args.from, () => withNonceLedgerInner(args, fn));
}

async function withNonceLedgerInner<T>(
  args: WithNonceLedgerArgs,
  fn: (context: NonceLedgerContext) => Promise<T>,
): Promise<T> {
  const ledger = args.ledger ?? defaultTxSubmissionLedger;
  const chainId = args.chainId ?? await resolveTxChainId(args.publicClient);

  if (args.recoverStuckNonce) {
    if (!args.walletClient) {
      throw new Error('withNonceLedger recovery requested without a wallet client');
    }
    await recoverStuckNonceIfNeeded({
      publicClient: args.publicClient,
      walletClient: args.walletClient,
      ledger,
      chainId,
      from: args.from,
      staleAfterMs: args.staleAfterMs,
    });
  }

  const nonce = args.nonce ?? await resolvePendingNonce(args.publicClient, args.from);
  const key = { chainId, from: args.from, nonce };
  const context: NonceLedgerContext = {
    ledger,
    chainId,
    from: args.from,
    nonce,
    async feeResultForAttempt(attemptIndex, options = {}) {
      const previous = await ledger.getTxSubmission(key);
      return viemFeeOverrideResultForAttempt(args.publicClient, attemptIndex, {
        previousFees: previous?.resolvedAtMs == null ? previous?.fees : undefined,
        forceEstimate: options.forceEstimate,
      });
    },
    async recordSubmitted(entry) {
      await ledger.recordTxSubmission({
        chainId,
        from: args.from,
        nonce,
        hash: entry.hash,
        logicalTx: entry.logicalTx,
        submittedAtMs: entry.submittedAtMs ?? Date.now(),
        fees: entry.fees,
        to: entry.to,
        value: entry.value,
        data: entry.data,
      });
    },
    async markResolved(resolvedAtMs = Date.now()) {
      await ledger.markTxSubmissionResolved({ chainId, from: args.from, nonce, resolvedAtMs });
    },
    async refreshNonce() {
      const fresh = await resolvePendingNonce(args.publicClient, args.from);
      context.nonce = fresh;
      return fresh;
    },
  };

  return fn(context);
}

export async function recoverStuckNonceIfNeeded(args: {
  publicClient: PublicClient;
  walletClient: TxRecoveryWalletClient;
  ledger?: TxSubmissionLedger;
  from: Address;
  chainId?: number;
  staleAfterMs?: number;
  nowMs?: number;
}): Promise<{
  nonce: number;
  previousHash?: Hex;
  recoveryHash: Hex;
} | null> {
  const ledger = args.ledger ?? defaultTxSubmissionLedger;
  const [chainId, pendingNonce, latestNonce] = await Promise.all([
    args.chainId ?? resolveTxChainId(args.publicClient),
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
    const tx: TxRecoveryTransactionRequest = {
      account,
      to: args.from,
      value: 0n,
      nonce,
      ...feeOverrides,
    };
    removeConflictingLegacyGasPrice(tx);
    const recoveryHash = await args.walletClient.sendTransaction(tx);
    await ledger.recordTxSubmission({
      chainId,
      from: args.from,
      nonce,
      hash: recoveryHash,
      logicalTx: 'stuck-nonce-recovery',
      submittedAtMs: nowMs,
      fees: feeOverrides,
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
  walletClient: TxRetryWalletClient,
  publicClient: PublicClient,
  txRequest: TxRetryTransactionRequest,
  options: TxRetryOptions = {},
): Promise<Hex> {
  const maxAttempts = options.maxAttempts ?? TX_RETRY_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? TX_RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? TX_RETRY_DEFAULTS.maxDelayMs;
  const ledger = options.ledger ?? defaultTxSubmissionLedger;
  const from = accountAddress(txRequest.account);
  const shouldTrackNonce = from !== undefined && supportsNonceTracking(publicClient);
  const requestedNonce = txRequest.nonce === undefined ? undefined : Number(txRequest.nonce);

  const sendWithRetry = async (nonceLedger?: NonceLedgerContext): Promise<Hex> => {
    let pinnedNonce = nonceLedger?.nonce ?? requestedNonce;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let broadcastHash: Hex | null = null;
      try {
        const feeResult = nonceLedger
          ? await nonceLedger.feeResultForAttempt(attempt, { forceEstimate: true })
          : await viemFeeOverrideResultForAttempt(publicClient, attempt);
        const nonceOverride = pinnedNonce !== undefined ? { nonce: pinnedNonce } : {};
        const req: TxRetryTransactionRequest =
          feeResult.kind === 'none'
            ? {
                ...txRequest,
                ...nonceOverride,
              }
            : {
                ...withoutFeeOverrides(txRequest),
                ...nonceOverride,
                ...feeResult.overrides,
              };
        removeConflictingLegacyGasPrice(req);

        const hash = await walletClient.sendTransaction(req);
        broadcastHash = hash;
        options.onBroadcast?.(hash);
        if (nonceLedger && !isEmptyFees(feeResult.snapshot)) {
          await nonceLedger.recordSubmitted({
            hash,
            logicalTx: options.logicalTx,
            fees: feeResult.snapshot,
            to: txRequest.to,
            value: txRequest.value,
            data: txRequest.data,
          });
        }
        return hash;
      } catch (err) {
        if (broadcastHash !== null) {
          if (
            typeof err === 'object' &&
            err !== null &&
            (err as { txHash?: unknown }).txHash === broadcastHash
          ) {
            throw err;
          }
          throw Object.assign(
            new Error(
              `post-broadcast bookkeeping failed for ${broadcastHash}: ${flattenErrorMessage(err)}`,
              { cause: err },
            ),
            { txHash: broadcastHash },
          );
        }
        lastError = err;
        if (!isRecoverableTransactionError(err) || attempt >= maxAttempts - 1) {
          throw err;
        }
        const message = flattenErrorMessage(err);
        options.onRetry?.({ attempt: attempt + 1, error: err, message });
        // Issue #562: on `nonce too low` the locally-pinned value is stale —
        // re-derive from the RPC's pending nonce so the next attempt does
        // not resubmit with the same stale value.
        if (isNonceTooLowError(err)) {
          if (nonceLedger) {
            pinnedNonce = await nonceLedger.refreshNonce();
          } else if (from && supportsNonceTracking(publicClient)) {
            pinnedNonce = await resolvePendingNonce(publicClient, from);
          }
        }
        await backoffDelay(attempt, baseDelayMs, maxDelayMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  if (from && shouldTrackNonce) {
    return withNonceLedger(
      {
        publicClient,
        walletClient,
        ledger,
        from,
        nonce: requestedNonce,
        recoverStuckNonce: true,
        staleAfterMs: options.stuckNonceAfterMs,
      },
      sendWithRetry,
    );
  }

  return sendWithRetry();
}
