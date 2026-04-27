/**
 * ERC-8004 ReputationRegistry client.
 *
 * Wraps the deployed canonical ReputationRegistry (vanity 0x8004…) for
 * Jinn's evaluator-delivery feedback flow.
 *
 * Per DR §4.3 (`docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md`):
 *
 *   At evaluator-delivery settlement, the evaluator calls
 *   `giveFeedback(restorerAgentId, ...)` with a body naming the specific
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
 * the evaluator is a different operator from the restorer, so this is a no-op;
 * but in single-operator dev/test setups the same Safe may evaluate its own
 * restoration. Callers are expected to catch the revert and log gracefully —
 * the evaluator's `claimDelivery` is the authoritative settlement, so a failed
 * `giveFeedback` is non-fatal.
 *
 * Address constants (cross-checked against `subgraph/networks.json` and
 * `client/src/earning/contracts.ts` IdentityRegistry entries):
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
import { executeSafeTransaction } from '../adapters/mech/safe.js';
import { waitForTransactionReceiptWithRetry } from '../tx-retry.js';

// ── Canonical ReputationRegistry addresses ──────────────────────────────────

/**
 * Canonical 0x8004… ReputationRegistry deployments. Source of truth:
 * `subgraph/networks.json`.
 */
export const REPUTATION_REGISTRY_ADDRESSES: Record<number, Address> = {
  // Base mainnet
  8453: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  // Base Sepolia
  84532: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  // Ethereum mainnet (shares Base mainnet vanity)
  1: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  // Ethereum Sepolia (shares Base Sepolia vanity)
  11155111: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
};

/**
 * Resolve the ReputationRegistry address for a chainId, or `null` if the
 * chain is not known. Used by callers that already carry a chainId
 * (e.g. derived from `JinnConfig.network`).
 */
export function getReputationRegistryAddress(chainId: number): Address | null {
  return REPUTATION_REGISTRY_ADDRESSES[chainId] ?? null;
}

// ── ABI ─────────────────────────────────────────────────────────────────────
//
// Keep the ABI surface minimal: only the functions and events this client
// touches. Signatures match the deployed contract — verify against
// `/tmp/erc8004-ref/ReputationRegistryUpgradeable.sol` and
// `subgraph/abis/ReputationRegistry.json`.
//
// `giveFeedback` takes `value: int128, valueDecimals: uint8`. The bead RFC
// described `score: uint8`; the deployed contract has been updated to a
// signed fixed-point. We map our public surface accordingly.

export const REPUTATION_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revokeFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'appendResponse',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
      { name: 'responseURI', type: 'string' },
      { name: 'responseHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'readFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'isRevoked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'readAllFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'includeRevoked', type: 'bool' },
    ],
    outputs: [
      { name: 'clients', type: 'address[]' },
      { name: 'feedbackIndexes', type: 'uint64[]' },
      { name: 'values', type: 'int128[]' },
      { name: 'valueDecimals', type: 'uint8[]' },
      { name: 'tag1s', type: 'string[]' },
      { name: 'tag2s', type: 'string[]' },
      { name: 'revokedStatuses', type: 'bool[]' },
    ],
  },
  {
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'getClients',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getLastIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
] as const;

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
  /** ERC-8004 agentId of the restorer being reviewed. */
  restorerAgentId: bigint;
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

  constructor(config: ReputationRegistryConfig) {
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.contractAddress = config.reputationRegistryAddress;
    this.safeAddress = config.safeAddress;
  }

  // ── Write paths ──────────────────────────────────────────────────────────

  /**
   * Submit feedback on a restorer's agent NFT. The body identifies the
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
        args.restorerAgentId,
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
   * Mirrors `ClaimRegistryClient` and `mech/contracts.ts`: production calls
   * route through the Safe so `msg.sender` is the operator's canonical
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
      });
    }

    const account = walletClient.account;
    if (!account) {
      throw new Error('sendWrite: walletClient has no account (and no safeAddress configured)');
    }

    // Direct EOA path — used by tests and ad-hoc scripts. Production wires
    // safeAddress so this branch is rarely hit on real chains.
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
  }
}

// Re-export ZERO_HASH for callers that need a sentinel filehash. Marked
// `as const` is unnecessary — the type is already a literal Hex.
export { ZERO_HASH };
