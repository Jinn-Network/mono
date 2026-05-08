/**
 * ERC-8004 IdentityRegistry surface.
 *
 * Two complementary capabilities live here:
 *
 *   1. `IdentityPublisher` — per-execution `setMetadata` writes that anchor
 *      envelope/evaluation commitments under the operator's agent NFT. Implements
 *      the v1 ABI-encoded payload tuple specified in
 *      `docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md` §3.1:
 *
 *        abi.encode(
 *            uint8   version,             // = 1
 *            uint8   tier,                // 0..4
 *            bytes32 manifestHash,        // = JinnRouter evidenceHash
 *            bytes   attestationQuoteCid, // raw multibase-decoded CID bytes; 0x for tier < 3
 *            bytes32 sourceMeasurement    // 0x00...00 for tier < 3
 *        )
 *
 *      The encoded payload is passed to
 *          IdentityRegistry.setMetadata(agentId, "<kind>:<cid>", payload)
 *
 *      per the entity-model decision in §4.2 of
 *      `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md` —
 *      one operator agent NFT per Safe; per-execution commitments anchor under it.
 *
 *      This module ONLY publishes — it does not mint the agent NFT (`jinn-mono-j07`),
 *      call `setAgentWallet` (`jinn-mono-aev`), or write reputation/validation
 *      registries (`jinn-mono-2ff` / `jinn-mono-9jg`).
 *
 *   2. `resolveAgentIdForManifest` — evaluator-side lookup of the harness's
 *      `agentId` from a manifest's `evidenceHash`. Per DR §4.3, the evaluator
 *      must call `ReputationRegistry.giveFeedback(harnessAgentId, ...)` keyed
 *      on the harness's ERC-8004 agent NFT id — but the on-chain `claimDelivery`
 *      payload only carries the `requestId` and `evidenceHash`, not the
 *      harness's agentId.
 *
 *      Resolution paths:
 *
 *        (b) Subgraph: `Execution { operator { agentId } where manifestHash: $h }`
 *            — the Jinn subgraph already indexes envelope publishes joined to the
 *            operator. This is the recommended path: O(1) and aligned with the
 *            rest of the discovery surface.
 *        (c) On-chain `IdentityRegistry.Registered` event scan filtered by the
 *            harness's Safe address — cheaper than a global scan, but still O(n)
 *            in registered-events. Documented as a fallback only.
 *
 *      This module implements (b). The fallback is intentionally **not** wired in
 *      yet: the resolver returns `null` cleanly when the subgraph URL is undefined
 *      or the query has no match, and the caller (the feedback hook) treats that
 *      as a no-op (DR §4.3: "skip but don't fail — claimDelivery is authoritative").
 */

import { encodeAbiParameters, type Hex, type PublicClient, type WalletClient } from 'viem';
import {
  IDENTITY_REGISTRY_SET_METADATA_ABI,
  PAYLOAD_TUPLE,
  PAYLOAD_TUPLE_V2,
} from './abis.js';

// Re-export ABI / payload tuple so callers that import them from the identity
// module continue to work without depending on `./abis.js` directly.
export { IDENTITY_REGISTRY_SET_METADATA_ABI, PAYLOAD_TUPLE, PAYLOAD_TUPLE_V2 };

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
export type ContentKind = 'envelope' | 'evaluation' | 'capture';

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

export interface PublishContentV2Args {
  kind: ContentKind;
  /** Textual CID embedded in the metadataKey (`<kind>:<cid>`). */
  cid: string;
  payload: ExecutionPayloadV2;
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

// ── V2 payload (Tier 4 verification gap, jinn-mono-9fe5) ─────────────────────
//
// V2 appends three fields to the v1 tuple per payload-schema §3 ("Append,
// never re-order"). The first five fields keep their v1 semantics + offsets
// so a v1 prefix decoder still finds them — but indexers MUST dispatch on
// `version` (1 vs 2) before reading any field beyond the prefix.
//
// New fields surface harness identity to the on-chain payload so the subgraph
// can index `(implName, codeDigest, mode)` directly, unlocking the inert
// HarnessRollup / LanguageRollup / FreezeViolation entities.
//
// See:
//   - docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md §3
//   - docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6

/** Mode flag: 0 = train, 1 = frozen. */
export type ExecutionModeFlag = 0 | 1;

/**
 * v2 payload as caller-friendly hex strings + plain TS values.
 *
 * - `codeDigest` is the 32-byte raw bytes of the executor's implStateDir hash
 *   (NOT the textual `sha256:` prefix). All-zero is the legitimate "no digest"
 *   value used by callers that opt into v2 but don't yet produce harness
 *   identity (e.g. setMetadata callers without a fence-attached run).
 * - `implName` is the harness implementation name, e.g. "claude-code-learner".
 *   Empty string is permitted as the "no harness identity" value.
 * - `modeFlag` is 0 (train) or 1 (frozen).
 */
export interface ExecutionPayloadV2 {
  version: 2;
  tier: ExecutionTier;
  /** 32-byte hex (= JinnRouter evidenceHash). */
  manifestHash: Hex;
  /** Raw multibase-decoded CID bytes hex. `"0x"` for tier < 3. */
  attestationQuoteCid: Hex;
  /** 32-byte hex enclave measurement. All-zero for tier < 3. */
  sourceMeasurement: Hex;
  /**
   * 32-byte raw codeDigest hex. Strip the `sha256:` prefix from
   * `executor.codeDigest` and hex-decode before constructing this field.
   * All-zero when no digest is available.
   */
  codeDigest: Hex;
  /** Harness implementation name. Empty string when no harness identity. */
  implName: string;
  /** 0 = train, 1 = frozen. See HarnessExecutionMode. */
  modeFlag: ExecutionModeFlag;
}

/** Convert a textual `sha256:<hex>` codeDigest to the 32-byte raw hex form. */
export function codeDigestSha256ToBytes32(textual: string | null | undefined): Hex {
  if (!textual) return ZERO_BYTES32;
  // Accept both "sha256:<hex>" and bare "<hex>" — be liberal in what we accept
  // so callers don't have to format defensively.
  const hex = textual.startsWith('sha256:') ? textual.slice('sha256:'.length) : textual;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return ZERO_BYTES32;
  }
  return (`0x${hex}`) as Hex;
}

/** Convert a HarnessExecutionMode string to the v2 numeric flag. */
export function modeStringToFlag(mode: 'train' | 'frozen'): ExecutionModeFlag {
  return mode === 'frozen' ? 1 : 0;
}

/**
 * Validate `payload` against v2 strict-mode rules.
 *
 * Same per-tier rules as v1 (admit only {0,1,3}; tier ≥ 3 requires non-empty
 * quote + non-zero measurement). Adds modeFlag ∈ {0,1} and 32-byte codeDigest
 * shape checks. `implName` may be any string including empty.
 */
export function validatePayloadV2(payload: ExecutionPayloadV2): ExecutionPayloadV2 {
  if (payload.version !== 2) {
    throw new PayloadValidationError(payload.tier, `version must be 2, got ${payload.version}`);
  }
  if (payload.tier !== 0 && payload.tier !== 1 && payload.tier !== 3) {
    throw new PayloadValidationError(
      payload.tier,
      `V2 admits only tiers {0,1,3}; got ${payload.tier}.`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.manifestHash)) {
    throw new PayloadValidationError(
      payload.tier,
      `manifestHash must be 32-byte hex (0x + 64 hex chars)`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.sourceMeasurement)) {
    throw new PayloadValidationError(
      payload.tier,
      `sourceMeasurement must be 32-byte hex (0x + 64 hex chars)`,
    );
  }
  if (!/^0x([0-9a-fA-F]{2})*$/.test(payload.attestationQuoteCid)) {
    throw new PayloadValidationError(
      payload.tier,
      `attestationQuoteCid must be hex (0x + even number of hex chars)`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.codeDigest)) {
    throw new PayloadValidationError(
      payload.tier,
      `codeDigest must be 32-byte hex (0x + 64 hex chars)`,
    );
  }
  if (payload.modeFlag !== 0 && payload.modeFlag !== 1) {
    throw new PayloadValidationError(
      payload.tier,
      `modeFlag must be 0 (train) or 1 (frozen); got ${payload.modeFlag}`,
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
      `tier < 3 requires empty attestationQuoteCid`,
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
 * ABI-encode a v2 payload per payload-schema §3.
 *
 * Validates first; throws `PayloadValidationError` on mismatch.
 */
export function encodeExecutionPayloadV2(payload: ExecutionPayloadV2): Hex {
  validatePayloadV2(payload);
  return encodeAbiParameters(PAYLOAD_TUPLE_V2, [
    payload.version,
    payload.tier,
    payload.manifestHash,
    payload.attestationQuoteCid,
    payload.sourceMeasurement,
    payload.codeDigest,
    payload.implName,
    payload.modeFlag,
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
    return this._writeMetadata(metadataKey, metadataValue);
  }

  /**
   * Publish a per-execution commitment using the v2 payload tuple.
   *
   * Identical write path to `publishContent` — the only difference is the
   * encoder. Use this when the caller has `codeDigest`, `implName`, and
   * `mode` in hand and wants the subgraph to index harness identity directly
   * from the on-chain bytes.
   *
   * Legacy callers without harness identity should keep using `publishContent`
   * (v1) — the subgraph decoder handles both versions and treats v1 as
   * `mode='train'` with empty `codeDigest`/`implName`.
   */
  async publishContentV2(args: PublishContentV2Args): Promise<Hex> {
    const metadataKey = buildMetadataKey(args.kind, args.cid);
    const metadataValue = encodeExecutionPayloadV2(args.payload);
    return this._writeMetadata(metadataKey, metadataValue);
  }

  private async _writeMetadata(metadataKey: string, metadataValue: Hex): Promise<Hex> {
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

// ── Agent resolver ───────────────────────────────────────────────────────────

/**
 * Inputs for `resolveAgentIdForManifest`.
 *
 * `manifestHash` is the keccak256 of the harness's signed manifest — i.e.
 * the `evidenceHash` JinnRouter records on `claimDelivery`. The subgraph
 * indexes this as `Execution.manifestHash` (see `subgraph/schema.graphql`
 * § Execution).
 *
 * `subgraphUrl` is optional: when undefined, the resolver returns `null`
 * without attempting the query. This lets the call site stay terse —
 * `await resolveAgentIdForManifest({ manifestHash, subgraphUrl: cfg.subgraphUrl })`
 * — without conditional plumbing.
 */
export interface ResolveAgentIdArgs {
  manifestHash: `0x${string}`;
  /** GraphQL endpoint URL. When undefined, returns null without querying. */
  subgraphUrl?: string;
  /**
   * Optional override for `fetch`. Production passes nothing (uses global
   * `fetch`); tests pass a stub that captures the GraphQL query/variables.
   */
  fetchImpl?: typeof fetch;
}

interface GqlResponse {
  data?: {
    executions?: Array<{
      manifestCid?: string | null;
      operator?: { agentId?: string | null } | null;
    }>;
  };
  errors?: Array<{ message: string }>;
}

const EXECUTIONS_QUERY = `
  query AgentForManifest($manifestHash: Bytes!) {
    executions(
      where: { manifestHash: $manifestHash }
      first: 1
    ) {
      manifestCid
      operator { agentId }
    }
  }
`;

/**
 * Resolved record for a manifest hash. The agentId is the primary signal
 * the feedback hook needs; the optional `manifestCid` is a convenience —
 * the subgraph already knows it from indexing the operator's envelope
 * publish, so returning it here saves the caller from re-deriving it.
 */
export interface ResolvedAgent {
  agentId: bigint;
  /**
   * The manifest CID indexed alongside this manifestHash, when the
   * subgraph has it. Useful for the feedback `manifestRef` body without
   * a second round-trip.
   */
  manifestCid: string | null;
}

/**
 * Resolve the operator `agentId` for a given manifest hash.
 *
 * Returns `null` when:
 *   - `subgraphUrl` is undefined (no on-chain fallback wired yet — see
 *     module-level comment).
 *   - The subgraph has no `Execution` indexed for this `manifestHash` (the
 *     harness hasn't published an envelope yet, or the subgraph is behind
 *     head).
 *   - The query fails or returns malformed data. This is intentional: a
 *     transient subgraph failure must NOT block the evaluator's
 *     `claimDelivery` settlement, so the resolver fails closed (no
 *     feedback) rather than throwing.
 *
 * Errors are logged via `console.warn` so a flaky subgraph surface is
 * observable without rerouting through the engine's logger.
 */
export async function resolveAgentIdForManifest(
  args: ResolveAgentIdArgs,
): Promise<ResolvedAgent | null> {
  const { manifestHash, subgraphUrl } = args;

  if (!subgraphUrl) {
    // Caller has no subgraph configured. The on-chain fallback (scan
    // IdentityRegistry.Registered events for the harness's Safe) is
    // documented at module level but not wired yet — return null cleanly
    // so the feedback hook becomes a no-op.
    return null;
  }

  // The subgraph indexes `manifestHash` as Bytes; pass the 0x-prefixed hex
  // straight through. Lower-case for stability against subgraphs that
  // canonicalise to lower-case (most do).
  const lowered = manifestHash.toLowerCase() as `0x${string}`;
  const fetchFn = args.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(subgraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: EXECUTIONS_QUERY,
        variables: { manifestHash: lowered },
      }),
    });
  } catch (err) {
    console.warn(
      `[agent-resolver] subgraph fetch failed for manifestHash=${manifestHash}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  if (!response.ok) {
    console.warn(
      `[agent-resolver] subgraph HTTP ${response.status} for manifestHash=${manifestHash}`,
    );
    return null;
  }

  let json: GqlResponse;
  try {
    json = (await response.json()) as GqlResponse;
  } catch (err) {
    console.warn(
      `[agent-resolver] subgraph JSON parse failed for manifestHash=${manifestHash}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }

  if (json.errors && json.errors.length > 0) {
    console.warn(
      `[agent-resolver] subgraph errors for manifestHash=${manifestHash}: ${json.errors
        .map((e) => e.message)
        .join('; ')}`,
    );
    return null;
  }

  const executions = json.data?.executions ?? [];
  if (executions.length === 0) {
    return null;
  }

  // (manifestHash, agentId) is unique by the entity-model design — we only
  // need the first row. Defensive: if `operator` or `agentId` is null, the
  // subgraph row is malformed; skip it.
  const first = executions[0];
  const agentIdStr = first?.operator?.agentId;
  if (!agentIdStr) {
    return null;
  }

  let agentId: bigint;
  try {
    agentId = BigInt(agentIdStr);
  } catch {
    console.warn(
      `[agent-resolver] subgraph returned non-numeric agentId="${agentIdStr}" for manifestHash=${manifestHash}`,
    );
    return null;
  }

  return { agentId, manifestCid: first?.manifestCid ?? null };
}
