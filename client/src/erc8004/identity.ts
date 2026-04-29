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
 *   2. `resolveAgentIdForManifest` — evaluator-side lookup of the restorer's
 *      `agentId` from a manifest's `evidenceHash`. Per DR §4.3, the evaluator
 *      must call `ReputationRegistry.giveFeedback(restorerAgentId, ...)` keyed
 *      on the restorer's ERC-8004 agent NFT id — but the on-chain `claimDelivery`
 *      payload only carries the `requestId` and `evidenceHash`, not the
 *      restorer's agentId.
 *
 *      Resolution paths:
 *
 *        (b) Subgraph: `Execution { operator { agentId } where manifestHash: $h }`
 *            — the Jinn subgraph already indexes envelope publishes joined to the
 *            operator. This is the recommended path: O(1) and aligned with the
 *            rest of the discovery surface.
 *        (c) On-chain `IdentityRegistry.Registered` event scan filtered by the
 *            restorer's Safe address — cheaper than a global scan, but still O(n)
 *            in registered-events. Documented as a fallback only.
 *
 *      This module implements (b). The fallback is intentionally **not** wired in
 *      yet: the resolver returns `null` cleanly when the subgraph URL is undefined
 *      or the query has no match, and the caller (the feedback hook) treats that
 *      as a no-op (DR §4.3: "skip but don't fail — claimDelivery is authoritative").
 */

import { encodeAbiParameters, type Hex, type PublicClient, type WalletClient } from 'viem';
import { IDENTITY_REGISTRY_SET_METADATA_ABI, PAYLOAD_TUPLE } from './abis.js';

// Re-export ABI / payload tuple so callers that import them from the identity
// module continue to work without depending on `./abis.js` directly.
export { IDENTITY_REGISTRY_SET_METADATA_ABI, PAYLOAD_TUPLE };

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

// ── Agent resolver ───────────────────────────────────────────────────────────

/**
 * Inputs for `resolveAgentIdForManifest`.
 *
 * `manifestHash` is the keccak256 of the restorer's signed manifest — i.e.
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
 *     restorer hasn't published an envelope yet, or the subgraph is behind
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
    // IdentityRegistry.Registered events for the restorer's Safe) is
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
