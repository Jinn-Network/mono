/**
 * ERC-8004 IdentityRegistry per-execution `setMetadata` publisher.
 *
 * Implements the v1 ABI-encoded payload tuple specified in
 * `docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md` §3.1:
 *
 *     abi.encode(
 *         uint8   version,             // = 1
 *         uint8   tier,                // 0..4
 *         bytes32 manifestHash,        // = JinnRouter evidenceHash
 *         bytes   attestationQuoteCid, // raw multibase-decoded CID bytes; 0x for tier < 3
 *         bytes32 sourceMeasurement    // 0x00...00 for tier < 3
 *     )
 *
 * The encoded payload is passed to
 *     IdentityRegistry.setMetadata(agentId, "<kind>:<cid>", payload)
 *
 * per the entity-model decision in §4.2 of
 * `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md` —
 * one operator agent NFT per Safe; per-execution commitments anchor under it.
 *
 * This module ONLY publishes — it does not mint the agent NFT (`jinn-mono-j07`),
 * call `setAgentWallet` (`jinn-mono-aev`), or write reputation/validation
 * registries (`jinn-mono-2ff` / `jinn-mono-9jg`).
 */

import { encodeAbiParameters, type Hex, type PublicClient, type WalletClient } from 'viem';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Evidence tier on the canonical ladder.
 *
 * V1 admits only `{0=self-signed, 1=committed, 3=attested}` — aligned with
 * `EvidenceTierSchema` in `client/src/types/envelope.ts` (PR #37 commit
 * 44cc949b stripped V2+ tiers `consensus`=2 and `proved`=4 from V1). The
 * gap at 2 and the absent 4 are intentional: future schema-version bumps
 * re-admit them. See payload-schema §5.
 */
export type ExecutionTier = 0 | 1 | 3;

/** Metadata key prefix. See payload-schema §6.1. */
export type ContentKind = 'envelope' | 'evaluation';

/**
 * v1 payload as caller-friendly hex strings. The encoder validates and
 * ABI-encodes per §3.1. `version` is fixed at 1 — this is the only schema
 * version this module emits.
 */
export interface ExecutionPayload {
  version: 1;
  tier: ExecutionTier;
  /** 32-byte hex (= JinnRouter evidenceHash). */
  manifestHash: Hex;
  /** Raw multibase-decoded CID bytes hex. `"0x"` for tier < 3. */
  attestationQuoteCid: Hex;
  /** 32-byte hex enclave measurement. All-zero for tier < 3. */
  sourceMeasurement: Hex;
}

export interface IdentityPublisherConfig {
  identityRegistryAddress: `0x${string}`;
  agentId: bigint;
  walletClient: WalletClient;
  publicClient: PublicClient;
}

export interface PublishContentArgs {
  kind: ContentKind;
  /** Textual CID embedded in the metadataKey (`<kind>:<cid>`). */
  cid: string;
  payload: ExecutionPayload;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when an `ExecutionPayload` violates §5 strict-mode validity rules. */
export class PayloadValidationError extends Error {
  readonly tier: ExecutionTier;
  readonly reason: string;
  constructor(tier: ExecutionTier, reason: string) {
    super(`payload validation failed (tier=${tier}): ${reason}`);
    this.name = 'PayloadValidationError';
    this.tier = tier;
    this.reason = reason;
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Canonical v1 ABI tuple shape. See payload-schema §3.1, §7.2. */
export const PAYLOAD_TUPLE = [
  { name: 'version', type: 'uint8' },
  { name: 'tier', type: 'uint8' },
  { name: 'manifestHash', type: 'bytes32' },
  { name: 'attestationQuoteCid', type: 'bytes' },
  { name: 'sourceMeasurement', type: 'bytes32' },
] as const;

/** ERC-8004 IdentityRegistry — only the function we call. */
export const IDENTITY_REGISTRY_SET_METADATA_ABI = [
  {
    type: 'function',
    name: 'setMetadata',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'metadataKey', type: 'string' },
      { name: 'metadataValue', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const ZERO_BYTES32: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';
const EMPTY_BYTES: Hex = '0x';

// ── Helpers ──────────────────────────────────────────────────────────────────

function isEmptyBytes(value: Hex): boolean {
  // "0x" is empty; "0x" + anything else is non-empty.
  return value === EMPTY_BYTES || value.length <= 2;
}

function isZeroBytes32(value: Hex): boolean {
  return value.toLowerCase() === ZERO_BYTES32;
}

/**
 * Validate `payload` against the strict-mode per-tier rules in payload-schema §5.
 * Throws `PayloadValidationError` on mismatch; otherwise returns the payload.
 *
 * Rules:
 *   - V1 admits only tiers {0=self-signed, 1=committed, 3=attested}. Tiers 2
 *     (consensus) and 4 (proved) are V2+ and rejected here.
 *   - tier ∈ {0,1}: attestationQuoteCid MUST be empty, sourceMeasurement MUST be zero.
 *   - tier === 3:  attestationQuoteCid MUST be non-empty, sourceMeasurement MUST be non-zero.
 *   - version MUST equal 1 (this module only emits v1).
 */
export function validatePayload(payload: ExecutionPayload): ExecutionPayload {
  if (payload.version !== 1) {
    throw new PayloadValidationError(payload.tier, `version must be 1, got ${payload.version}`);
  }
  if (payload.tier !== 0 && payload.tier !== 1 && payload.tier !== 3) {
    throw new PayloadValidationError(
      payload.tier,
      `V1 admits only tiers {0,1,3}; got ${payload.tier}. Tiers 2 (consensus) and 4 (proved) are V2+.`,
    );
  }
  // manifestHash must be a 32-byte hex (66 chars including 0x).
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.manifestHash)) {
    throw new PayloadValidationError(
      payload.tier,
      `manifestHash must be 32-byte hex (0x + 64 hex chars)`,
    );
  }
  // sourceMeasurement must be a 32-byte hex.
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.sourceMeasurement)) {
    throw new PayloadValidationError(
      payload.tier,
      `sourceMeasurement must be 32-byte hex (0x + 64 hex chars)`,
    );
  }
  // attestationQuoteCid must be valid hex (any even length).
  if (!/^0x([0-9a-fA-F]{2})*$/.test(payload.attestationQuoteCid)) {
    throw new PayloadValidationError(
      payload.tier,
      `attestationQuoteCid must be hex (0x + even number of hex chars)`,
    );
  }

  const requiresAttestation = payload.tier >= 3;
  const hasQuote = !isEmptyBytes(payload.attestationQuoteCid);
  const hasMeasurement = !isZeroBytes32(payload.sourceMeasurement);

  if (requiresAttestation && !hasQuote) {
    throw new PayloadValidationError(
      payload.tier,
      `tier >= 3 requires non-empty attestationQuoteCid`,
    );
  }
  if (!requiresAttestation && hasQuote) {
    throw new PayloadValidationError(
      payload.tier,
      `tier < 3 requires empty attestationQuoteCid (got ${payload.attestationQuoteCid.length} chars)`,
    );
  }
  if (requiresAttestation && !hasMeasurement) {
    throw new PayloadValidationError(
      payload.tier,
      `tier >= 3 requires non-zero sourceMeasurement`,
    );
  }
  if (!requiresAttestation && hasMeasurement) {
    throw new PayloadValidationError(
      payload.tier,
      `tier < 3 requires zero sourceMeasurement`,
    );
  }
  return payload;
}

/**
 * ABI-encode the v1 payload per payload-schema §3.1.
 *
 * Validates first; throws `PayloadValidationError` on mismatch. Never silently
 * produces malformed bytes.
 */
export function encodeExecutionPayload(payload: ExecutionPayload): Hex {
  validatePayload(payload);
  return encodeAbiParameters(PAYLOAD_TUPLE, [
    payload.version,
    payload.tier,
    payload.manifestHash,
    payload.attestationQuoteCid,
    payload.sourceMeasurement,
  ]);
}

/** Build the `<kind>:<cid>` metadata key per payload-schema §6.1. */
export function buildMetadataKey(kind: ContentKind, cid: string): string {
  return `${kind}:${cid}`;
}

// ── Publisher ────────────────────────────────────────────────────────────────

/**
 * Per-execution `setMetadata` client.
 *
 * Stateless beyond config. Each `publishContent()` call validates the payload,
 * ABI-encodes it, and submits a single `setMetadata(agentId, key, value)`
 * transaction. Returns the on-chain tx hash. Failures are surfaced to the
 * caller — the engine catches and logs them as non-fatal.
 */
export class IdentityPublisher {
  private readonly identityRegistryAddress: `0x${string}`;
  private readonly agentId: bigint;
  private readonly walletClient: WalletClient;
  private readonly publicClient: PublicClient;

  constructor(config: IdentityPublisherConfig) {
    this.identityRegistryAddress = config.identityRegistryAddress;
    this.agentId = config.agentId;
    this.walletClient = config.walletClient;
    this.publicClient = config.publicClient;
  }

  /** The agentId this publisher anchors metadata under. */
  get agent(): bigint {
    return this.agentId;
  }

  /** The IdentityRegistry contract this publisher writes to. */
  get registry(): `0x${string}` {
    return this.identityRegistryAddress;
  }

  /**
   * Publish a per-execution commitment under the operator's agent NFT.
   *
   * Calls `IdentityRegistry.setMetadata(agentId, "<kind>:<cid>", encode(payload))`.
   * Returns the on-chain tx hash. Throws on encode/validation/network failure.
   */
  async publishContent(args: PublishContentArgs): Promise<Hex> {
    const metadataKey = buildMetadataKey(args.kind, args.cid);
    const metadataValue = encodeExecutionPayload(args.payload);

    const account = this.walletClient.account;
    if (!account) {
      throw new Error('IdentityPublisher: walletClient has no account configured');
    }
    const chain = this.walletClient.chain;
    if (!chain) {
      throw new Error('IdentityPublisher: walletClient has no chain configured');
    }

    const txHash = await this.walletClient.writeContract({
      address: this.identityRegistryAddress,
      abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
      functionName: 'setMetadata',
      args: [this.agentId, metadataKey, metadataValue],
      account,
      chain,
    });

    // Best-effort confirmation; callers that want async fire-and-forget can
    // ignore the await — but waiting here gives us a clear pass/fail signal
    // and surfaces revert reasons promptly. The engine treats failures as
    // non-fatal regardless.
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }
}
