/**
 * ERC-8004 ReputationRegistry surface.
 *
 * Wraps the deployed canonical ReputationRegistry (vanity 0x8004…) for
 * Jinn's evaluator-delivery feedback flow.
 *
 * Per DR §4.3 (`docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md`):
 *
 *   At evaluator-delivery settlement, the evaluator calls
 *   `giveFeedback(harnessAgentId, ...)` with a body naming the specific
 *   manifest CID / `evidenceHash` the verdict pertains to. Reputation
 *   accrues to the operator's `agentId`; the body anchors which execution
 *   the feedback is about.
 *
 * Canonical body convention (this module enforces it):
 *
 *   - `feedbackURI = "manifest:<cid>"`     — names the manifest being evaluated.
 *   - `feedbackHash = manifestHash`        — bytes32 binds to a specific execution.
 *
 * The on-chain function signature uses `value: int128 / valueDecimals: uint8`
 * (a signed fixed-point), not `score: uint8`. We expose a numeric-friendly
 * `score` parameter on the higher-level surface and forward it as `value` here.
 *
 * Self-feedback guard: the contract reverts on self-feedback (caller cannot
 * be the agent owner / approved / operator). For Jinn's typical deployment
 * the evaluator is a different operator from the harness, so this is a no-op;
 * but in single-operator dev/test setups the same Safe may evaluate its own
 * restoration. Callers are expected to catch the revert and log gracefully —
 * the evaluator's `claimDelivery` is the authoritative settlement, so a failed
 * `giveFeedback` is non-fatal.
 *
 * Two layers live here:
 *
 *   1. `ReputationRegistryClient` — the typed wire-level wrapper.
 *   2. `submitEvaluatorFeedback` + `mapVerdictToScore` — the engine-side
 *      hook that maps an evaluator's verdict to a score and submits feedback.
 *
 * ── Harness-agentId resolution ─────────────────────────────────────────────
 *
 * Resolving the harness's `agentId` from the evaluator's perspective is
 * the caller's job. The hook here takes `harnessAgentId` as a direct input.
 * Wave-4 D4 deleted the DiscoveryAPI envelope lookup
 * (`resolveAgentIdForManifest`).
 *
 * ── Score-mapping policy ─────────────────────────────────────────────────────
 *
 * The portfolio.v0 evaluator emits a `verdict ∈ {PASS, FAIL, INDETERMINATE,
 * REJECTED}` plus a numeric Calmar score (string). The reputation registry
 * takes a signed fixed-point. The mapping policy below is intentionally
 * conservative:
 *
 *   - PASS         → score = 100, scoreDecimals = 2 (= 1.00)  → submit feedback.
 *   - FAIL         → score =   0, scoreDecimals = 2 (= 0.00)  → submit feedback.
 *   - REJECTED     → no feedback. The harness was not eligible to attempt
 *                    this task (e.g. minClosedTrades unmet); a 0-score
 *                    feedback would unfairly tarnish their reputation for a
 *                    structural mismatch, not a quality failure.
 *   - INDETERMINATE → no feedback. The evaluator could not rederive
 *                    (HL unreachable, post-snapshot funding accrual not
 *                    settled). Not a verdict on the harness.
 *
 * If the impl emits a numeric score in `[0, 1]` separate from verdict, the
 * caller should pre-multiply it by 100 and pass `scoreDecimals=2`.
 *
 * Address constants (cross-checked against `operator/src/earning/contracts.ts`
 * IdentityRegistry entries):
 *
 *   Base mainnet  0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 *   Base Sepolia  0x8004B663056A597Dffe9eCcC1965A193B7388713
 *   Ethereum      0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
 *   Sepolia       0x8004B663056A597Dffe9eCcC1965A193B7388713
 */

import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { executeSafeTransaction, type VenueBroadcaster } from '../adapters/mech/safe.js';
import { waitForTransactionReceiptWithRetry, withEoaBroadcastLock } from '../tx-retry.js';
import { REPUTATION_REGISTRY_ABI } from './abis.js';
import {
  REPUTATION_REGISTRY_ADDRESSES,
  getReputationRegistryAddress,
} from './addresses.js';

// Re-exports so callers that imported these directly from the reputation
// module continue to work without touching `./abis.js` / `./addresses.js`.
export {
  REPUTATION_REGISTRY_ABI,
  REPUTATION_REGISTRY_ADDRESSES,
  getReputationRegistryAddress,
};

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Configuration for `ReputationRegistryClient`.
 *
 * `walletClient` is required for write paths (`giveFeedback`, `revokeFeedback`,
 * `respondToFeedback`); read-only consumers may pass it as undefined.
 *
 * `safeAddress` (optional): when present, write transactions are routed
 * through the Safe multisig via `executeSafeTransaction`, mirroring the rest
 * of the client (claim/delivery flows already use Safe-routed sends so that
 * the on-chain `msg.sender` matches the operator's canonical OLAS identity).
 * When absent, writes are sent directly from `walletClient.account` (useful
 * for tests and one-off operator scripts).
 */
export interface ReputationRegistryConfig {
  reputationRegistryAddress: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  /**
   * Optional Safe multisig address. When set, write txs are routed through
   * the Safe; when undefined, writes go directly from `walletClient.account`.
   */
  safeAddress?: Address;
  /**
   * The Safe broadcaster write txs route through when `safeAddress` is set (finding E16 / the C2
   * ruling: no process-global — construct one bound to `safeAddress`, e.g. via
   * `createDirectSafeBroadcaster`). Unused on the direct-EOA path. May also be supplied later via
   * `setBroadcaster` for hosts that build the client before a broadcaster is available.
   */
  broadcaster?: VenueBroadcaster;
}

/**
 * One feedback entry as exposed by `readFeedback` / `readAllFeedback`.
 *
 * Fields map to the on-chain layout:
 *   - `score` is the raw `int128 value` from storage (numerator).
 *   - `scoreDecimals` is the decimal exponent (`value / 10^scoreDecimals`).
 *   - `tag1`/`tag2`/`fileuri`/`filehash` mirror the `NewFeedback` event payload.
 *     `fileuri` = `feedbackURI` on chain; `filehash` = `feedbackHash` on chain.
 *     For Jinn evaluator feedback, `fileuri` is `"manifest:<cid>"` and
 *     `filehash` is the manifest's `evidenceHash` (keccak256).
 *
 * `client`, `agentId`, and `feedbackIndex` together uniquely identify a row.
 * Note: `readFeedback` does NOT return `fileuri` / `filehash` (those live only
 * in the event log, not in storage); those fields are populated by
 * `readAllFeedback` only when reconstructed from indexed events. The current
 * client populates them from event-side data when available, otherwise they
 * remain `undefined`.
 */
export interface FeedbackRecord {
  agentId: bigint;
  client: Address;
  feedbackIndex: bigint;
  /** Raw signed numerator from the contract (`int128`). */
  score: bigint;
  /** Decimal exponent (`score / 10^scoreDecimals`). */
  scoreDecimals: number;
  tag1?: string;
  tag2?: string;
  /** `feedbackURI` from the event payload (storage does not retain it). */
  fileuri?: string;
  /** `feedbackHash` from the event payload (storage does not retain it). */
  filehash?: Hex;
  revoked: boolean;
}

/** Identifies a specific feedback row for `respondToFeedback`. */
export interface FeedbackId {
  agentId: bigint;
  client: Address;
  feedbackIndex: bigint;
}

/** Shape returned by `getSummary` — reflects the on-chain tuple. */
export interface FeedbackSummary {
  count: bigint;
  /** Mode-decimals normalised value (signed fixed-point numerator). */
  summaryValue: bigint;
  /** Decimal exponent for `summaryValue`. */
  summaryValueDecimals: number;
}

// ── Argument types ──────────────────────────────────────────────────────────

export interface GiveFeedbackArgs {
  /** ERC-8004 agentId of the harness being reviewed. */
  harnessAgentId: bigint;
  /** Numerator. e.g. 100 with `scoreDecimals=2` → 1.00. Range: int128. */
  score: number | bigint;
  /** Exponent: `score / 10^scoreDecimals`. Contract bounds: <= 18. */
  scoreDecimals: number;
  /**
   * Canonical: `"manifest:<cid>"` or `"ipfs://<cid>"`. Names the specific
   * manifest the verdict is about. Subgraph parses this to a `manifestRef`.
   */
  manifestRef: string;
  /**
   * 32-byte manifest hash (`evidenceHash` from `claimDelivery`). Binds the
   * feedback to a specific execution.
   */
  manifestHash: Hex;
  /**
   * Optional tag (e.g. `"portfolio.v0"`). The first emitted `tag1` is also
   * indexed on the event, which lets subgraphs filter by kind cheaply.
   */
  tag1?: string;
  /** Optional tag — currently reserved for future use. */
  tag2?: string;
  /**
   * Optional `endpoint` field — appears in the `NewFeedback` event but is
   * not stored. Defaults to `""`. Reserved for future use; subgraph ignores.
   */
  endpoint?: string;
}

export interface RespondToFeedbackArgs {
  feedbackId: FeedbackId;
  responseURI: string;
  responseHash: Hex;
}

export interface RevokeFeedbackArgs {
  agentId: bigint;
  feedbackIndex: bigint;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const ZERO_HASH: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

function toInt128(value: number | bigint): bigint {
  const v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  // `int128` range: [-2^127, 2^127-1]. The contract additionally bounds
  // |value| <= 1e38 (well inside int128). We don't enforce 1e38 here — the
  // contract reverts on overflow with "value too large" and the caller can
  // handle that uniformly with other reverts.
  return v;
}

// ── ReputationRegistryClient ────────────────────────────────────────────────

export class ReputationRegistryClient {
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly contractAddress: Address;
  private readonly safeAddress?: Address;
  private broadcaster?: VenueBroadcaster;

  constructor(config: ReputationRegistryConfig) {
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.contractAddress = config.reputationRegistryAddress;
    this.safeAddress = config.safeAddress;
    this.broadcaster = config.broadcaster;
  }

  /**
   * Late-bind the Safe broadcaster this client's writes route through (finding E16 / the C2
   * ruling), for hosts that construct the client before a broadcaster is available.
   */
  public setBroadcaster(broadcaster: VenueBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  // ── Write paths ──────────────────────────────────────────────────────────

  /**
   * Submit feedback on a harness's agent NFT. The body identifies the
   * manifest being evaluated via `feedbackURI = "manifest:<cid>"` and
   * `feedbackHash = manifestHash` (the evidenceHash committed in
   * `claimDelivery`).
   *
   * Reverts (caught upstream and logged):
   *   - "Self-feedback not allowed" — caller is owner/approved/operator of agentId.
   *   - "ERC721NonexistentToken"   — agentId does not exist.
   *   - "value too large"          — |score| > 1e38.
   *   - "too many decimals"        — scoreDecimals > 18.
   */
  async giveFeedback(args: GiveFeedbackArgs): Promise<Hex> {
    if (!this.walletClient) {
      throw new Error('giveFeedback: walletClient required for write operations');
    }

    const value = toInt128(args.score);
    const calldata = encodeFunctionData({
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'giveFeedback',
      args: [
        args.harnessAgentId,
        value,
        args.scoreDecimals,
        args.tag1 ?? '',
        args.tag2 ?? '',
        args.endpoint ?? '',
        args.manifestRef,
        args.manifestHash,
      ],
    });

    return this.sendWrite(calldata);
  }

  /**
   * Operator-facing: respond to a feedback on your own agent NFT.
   * `msg.sender` becomes the responder; any address may call (the contract
   * does not gate by ownership — multiple parties can append responses).
   */
  async respondToFeedback(args: RespondToFeedbackArgs): Promise<Hex> {
    if (!this.walletClient) {
      throw new Error('respondToFeedback: walletClient required for write operations');
    }
    const calldata = encodeFunctionData({
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'appendResponse',
      args: [
        args.feedbackId.agentId,
        args.feedbackId.client,
        args.feedbackId.feedbackIndex,
        args.responseURI,
        args.responseHash,
      ],
    });

    return this.sendWrite(calldata);
  }

  /**
   * Revoke previously-given feedback. The contract only allows the original
   * caller (`msg.sender` on the original `giveFeedback`) to revoke; mirrored
   * here by the routing decision in `sendWrite` (Safe vs EOA).
   */
  async revokeFeedback(args: RevokeFeedbackArgs): Promise<Hex> {
    if (!this.walletClient) {
      throw new Error('revokeFeedback: walletClient required for write operations');
    }
    const calldata = encodeFunctionData({
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'revokeFeedback',
      args: [args.agentId, args.feedbackIndex],
    });

    return this.sendWrite(calldata);
  }

  // ── Read paths ───────────────────────────────────────────────────────────

  async readFeedback(args: {
    agentId: bigint;
    clientAddress: Address;
    feedbackIndex: bigint;
  }): Promise<FeedbackRecord | null> {
    try {
      const result = (await this.publicClient.readContract({
        address: this.contractAddress,
        abi: REPUTATION_REGISTRY_ABI,
        functionName: 'readFeedback',
        args: [args.agentId, args.clientAddress, args.feedbackIndex],
      })) as [bigint, number, string, string, boolean];

      const [value, valueDecimals, tag1, tag2, isRevoked] = result;
      return {
        agentId: args.agentId,
        client: args.clientAddress,
        feedbackIndex: args.feedbackIndex,
        score: value,
        scoreDecimals: valueDecimals,
        tag1: tag1 || undefined,
        tag2: tag2 || undefined,
        revoked: isRevoked,
      };
    } catch (err) {
      // The contract reverts with "index out of bounds" / "index must be > 0"
      // when the row does not exist; surface as null rather than throwing.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('out of bounds') || msg.includes('index must be > 0')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Read all feedback for an agentId. By default, queries every known client
   * (the contract walks `_clients[agentId]` when `clientAddresses=[]` is
   * passed — confirmed in the .sol, line ~268). Pass an explicit
   * `clientAddresses` filter to narrow.
   */
  async readAllFeedback(
    agentId: bigint,
    opts: {
      clientAddresses?: Address[];
      tag1Filter?: string;
      tag2Filter?: string;
      includeRevoked?: boolean;
    } = {},
  ): Promise<FeedbackRecord[]> {
    const result = (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'readAllFeedback',
      args: [
        agentId,
        opts.clientAddresses ?? [],
        opts.tag1Filter ?? '',
        opts.tag2Filter ?? '',
        opts.includeRevoked ?? false,
      ],
    })) as [
      readonly Address[],
      readonly bigint[],
      readonly bigint[],
      readonly number[],
      readonly string[],
      readonly string[],
      readonly boolean[],
    ];

    const [clients, feedbackIndexes, values, valueDecimals, tag1s, tag2s, revokedStatuses] = result;
    const records: FeedbackRecord[] = [];
    for (let i = 0; i < clients.length; i++) {
      records.push({
        agentId,
        client: clients[i]!,
        feedbackIndex: feedbackIndexes[i]!,
        score: values[i]!,
        scoreDecimals: valueDecimals[i]!,
        tag1: tag1s[i] || undefined,
        tag2: tag2s[i] || undefined,
        revoked: revokedStatuses[i]!,
      });
    }
    return records;
  }

  /**
   * Compute a summary across the supplied client addresses (or fail loudly —
   * the on-chain `getSummary` reverts when called with an empty list, by
   * design, to force callers to be explicit about which feedback sources
   * they trust).
   *
   * Pass the result of `getClients(agentId)` to get a "summary across all
   * known clients" — Jinn's typical surface.
   */
  async getSummary(
    agentId: bigint,
    opts: {
      clientAddresses: Address[];
      tag1Filter?: string;
      tag2Filter?: string;
    },
  ): Promise<FeedbackSummary> {
    if (opts.clientAddresses.length === 0) {
      throw new Error('getSummary: clientAddresses must be non-empty (contract reverts otherwise)');
    }
    const result = (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'getSummary',
      args: [agentId, opts.clientAddresses, opts.tag1Filter ?? '', opts.tag2Filter ?? ''],
    })) as [bigint, bigint, number];

    const [count, summaryValue, summaryValueDecimals] = result;
    return { count, summaryValue, summaryValueDecimals };
  }

  /** All addresses that have ever submitted feedback for this agentId. */
  async getClients(agentId: bigint): Promise<Address[]> {
    const result = (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'getClients',
      args: [agentId],
    })) as readonly Address[];
    return [...result];
  }

  /** Latest feedback index this client has submitted for `agentId`, or 0. */
  async getLastIndex(agentId: bigint, clientAddress: Address): Promise<bigint> {
    const result = (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: 'getLastIndex',
      args: [agentId, clientAddress],
    })) as bigint;
    // result is uint64; widening to bigint is safe.
    return result;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /**
   * Send a write tx, routing through the Safe when configured.
   *
   * Mirrors `mech/contracts.ts`: production calls route through the Safe so
   * `msg.sender` is the operator's canonical
   * identity (matching the OLAS staking + 8004 IdentityRegistry agent NFT
   * binding). Tests and one-off scripts can omit `safeAddress` and write
   * directly from the EOA.
   *
   * `_unused` is reserved for value-bearing writes if any are added later;
   * none of the Reputation surfaces are payable, so we always send 0.
   */
  private async sendWrite(calldata: Hex): Promise<Hex> {
    const walletClient = this.walletClient!;

    if (this.safeAddress) {
      return executeSafeTransaction(this.publicClient, walletClient, {
        safeAddress: this.safeAddress,
        to: this.contractAddress,
        value: 0n,
        data: calldata,
      }, this.broadcaster);
    }

    const account = walletClient.account;
    if (!account) {
      throw new Error('sendWrite: walletClient has no account (and no safeAddress configured)');
    }

    // Direct EOA path — used by tests and ad-hoc scripts. Production wires
    // safeAddress so this branch is rarely hit on real chains. Hold the per-EOA
    // broadcast lock across submit + receipt so a concurrent operator-EOA
    // broadcast cannot claim the same nonce (#792 / #525).
    return withEoaBroadcastLock(account.address, async () => {
      const txHash = await walletClient.sendTransaction({
        account,
        to: this.contractAddress,
        data: calldata,
        value: 0n,
        // viem requires the chain to be specified; we resolve it from the
        // public client's configured chain to avoid double-config drift.
        chain: walletClient.chain ?? null,
      });

      await waitForTransactionReceiptWithRetry(this.publicClient, txHash);
      return txHash;
    });
  }
}

// Re-export ZERO_HASH for callers that need a sentinel filehash. Marked
// `as const` is unnecessary — the type is already a literal Hex.
export { ZERO_HASH };

// ── Feedback hook ───────────────────────────────────────────────────────────

/** Harness-side outputs the hook needs to anchor the feedback on chain. */
export interface HarnessExecutionRef {
  /** ERC-8004 agentId of the harness being reviewed. */
  harnessAgentId: bigint;
  /** IPFS CID of the harness's manifest (NOT the evaluator's verdict). */
  harnessManifestCid: string;
  /** keccak256 of the harness's signed manifest = evidenceHash on JinnRouter. */
  harnessEvidenceHash: Hex;
}

/** Verdict-side output of the evaluator. */
export interface EvaluatorVerdict {
  verdict: 'PASS' | 'FAIL' | 'INDETERMINATE' | 'REJECTED';
  /**
   * Optional solverType label (e.g. `"portfolio.v0"`). Emitted as `tag1` so
   * downstream subgraphs can filter feedback by SolverType cheaply
   * (`tag1` is indexed on the `NewFeedback` event).
   */
  solverType?: string;
  /**
   * Optional opaque tag2 — reserved for future use (e.g. evaluator software
   * version). Default empty.
   */
  tag2?: string;
}

/** Mapped score input to `giveFeedback`. `null` means "do not submit". */
export interface ScoreMapping {
  score: number;
  scoreDecimals: number;
}

/**
 * Outcome of `submitEvaluatorFeedback`. The hook is fire-and-forget from the
 * caller's perspective; this return type is for tests and observability.
 */
export type FeedbackHookOutcome =
  | { kind: 'submitted'; txHash: Hex }
  | { kind: 'skipped'; reason: 'verdict-not-eligible' | 'self-feedback' | 'agent-not-found' }
  | { kind: 'failed'; error: string };

/**
 * Pure function: map a verdict to (score, scoreDecimals). Returns `null` for
 * verdicts that should not produce on-chain feedback (REJECTED, INDETERMINATE)
 * — see policy comment at the top of the module.
 *
 * Exported so tests pin the policy directly.
 */
export function mapVerdictToScore(verdict: EvaluatorVerdict['verdict']): ScoreMapping | null {
  switch (verdict) {
    case 'PASS':
      // 1.00 — full pass.
      return { score: 100, scoreDecimals: 2 };
    case 'FAIL':
      // 0.00 — quality failure; tarnishes the operator's reputation.
      return { score: 0, scoreDecimals: 2 };
    case 'REJECTED':
    case 'INDETERMINATE':
      // No feedback — see top-of-module policy comment.
      return null;
    default: {
      // Defensive: unrecognised verdict → no feedback. Future verdicts that
      // should emit feedback need an explicit case here; defaulting to "no
      // feedback" is the safe path so we never silently apply a wrong score.
      const exhaustive: never = verdict;
      void exhaustive;
      return null;
    }
  }
}

/**
 * Submit feedback on the harness's agent NFT. The body is the canonical
 * `manifest:<cid>` URI + `evidenceHash` — the subgraph parses these to
 * synthesize an `Execution` row joined to the operator.
 *
 * Errors are caught and returned as `{ kind: 'failed', ... }` — callers
 * (the engine's deliver path) should log the outcome but never let it
 * propagate. The on-chain `claimDelivery` already settled.
 *
 * Self-feedback (caller is owner/approved/operator of `harnessAgentId`)
 * reverts on chain with a known string; we surface that as a graceful
 * `{ kind: 'skipped', reason: 'self-feedback' }`.
 */
export async function submitEvaluatorFeedback(args: {
  registry: ReputationRegistryClient;
  ref: HarnessExecutionRef;
  verdict: EvaluatorVerdict;
  /** Optional logger; defaults to console.warn for failures. */
  log?: (entry: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
}): Promise<FeedbackHookOutcome> {
  const { registry, ref, verdict } = args;
  const log = args.log ?? defaultLog;

  const mapped = mapVerdictToScore(verdict.verdict);
  if (!mapped) {
    log({
      level: 'info',
      msg: `[reputation] skipping giveFeedback for verdict=${verdict.verdict} (policy: no on-chain feedback)`,
      data: { harnessAgentId: ref.harnessAgentId.toString(), verdict: verdict.verdict },
    });
    return { kind: 'skipped', reason: 'verdict-not-eligible' };
  }

  const giveArgs: GiveFeedbackArgs = {
    harnessAgentId: ref.harnessAgentId,
    score: mapped.score,
    scoreDecimals: mapped.scoreDecimals,
    manifestRef: `manifest:${ref.harnessManifestCid}`,
    manifestHash: ref.harnessEvidenceHash,
    ...(verdict.solverType ? { tag1: verdict.solverType } : {}),
    ...(verdict.tag2 ? { tag2: verdict.tag2 } : {}),
  };

  try {
    const txHash = await registry.giveFeedback(giveArgs);
    log({
      level: 'info',
      msg: '[reputation] giveFeedback submitted',
      data: {
        harnessAgentId: ref.harnessAgentId.toString(),
        verdict: verdict.verdict,
        score: mapped.score,
        scoreDecimals: mapped.scoreDecimals,
        manifestCid: ref.harnessManifestCid,
        txHash,
      },
    });
    return { kind: 'submitted', txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Self-feedback guard: contract reverts with "Self-feedback not allowed"
    // when the evaluator EOA/Safe is the owner/approved/operator of the
    // harness's agentId. This is structurally possible in single-operator
    // dev setups; treat as a graceful skip.
    if (msg.includes('Self-feedback not allowed')) {
      log({
        level: 'warn',
        msg: '[reputation] giveFeedback skipped: evaluator is the harness (self-feedback guard)',
        data: { harnessAgentId: ref.harnessAgentId.toString() },
      });
      return { kind: 'skipped', reason: 'self-feedback' };
    }

    // Agent doesn't exist on chain. The contract reverts with the canonical
    // ERC-721 error; surface as a graceful skip — the harness hasn't yet
    // minted (or we're querying the wrong chain).
    if (msg.includes('ERC721NonexistentToken') || msg.includes('nonexistent')) {
      log({
        level: 'warn',
        msg: '[reputation] giveFeedback skipped: harness agentId not minted',
        data: { harnessAgentId: ref.harnessAgentId.toString() },
      });
      return { kind: 'skipped', reason: 'agent-not-found' };
    }

    // Anything else: log warn (NOT error — the evaluator's claimDelivery
    // already landed), surface as `failed` for tests/observability.
    log({
      level: 'warn',
      msg: '[reputation] giveFeedback failed (non-fatal); claimDelivery already authoritative',
      data: {
        harnessAgentId: ref.harnessAgentId.toString(),
        error: msg,
      },
    });
    return { kind: 'failed', error: msg };
  }
}

// ── Local helpers ───────────────────────────────────────────────────────────

function defaultLog(entry: {
  level: 'info' | 'warn' | 'error';
  msg: string;
  data?: unknown;
}): void {
  const rendered = formatLogData(entry.data);
  const line = rendered ? `${entry.msg} ${rendered}` : entry.msg;
  if (entry.level === 'error') {
    console.error(line);
  } else if (entry.level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Render `data` for stdout. Plain `console.log(msg, obj)` prints `[object Object]`
 * when stdout is non-TTY (e.g. piped through the operator console), which loses
 * the structured payload operators actually need (verdict, score, txHash, …).
 * JSON.stringify with a BigInt-safe replacer keeps the line readable in both
 * TTY and non-TTY contexts. Exported for unit coverage.
 */
export function formatLogData(data: unknown): string {
  if (data === undefined || data === null) return '';
  try {
    return JSON.stringify(data, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  } catch {
    return String(data);
  }
}
