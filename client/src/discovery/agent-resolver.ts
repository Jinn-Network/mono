/**
 * Resolve a restorer's `agentId` from a manifest's `evidenceHash`, evaluator-side.
 *
 * Per the evaluator-delivery feedback flow (DR §4.3 in
 * `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md`), the
 * evaluator must call `ReputationRegistry.giveFeedback(restorerAgentId, ...)`
 * keyed on the restorer's ERC-8004 agent NFT id — but the on-chain
 * `claimDelivery` payload only carries the `requestId` and `evidenceHash`,
 * not the restorer's agentId. Resolving it requires either:
 *
 *   (b) Subgraph: `Execution { operator { agentId } where manifestHash: $h }` —
 *       the Jinn subgraph already indexes envelope publishes joined to the
 *       operator (see `subgraph/schema.graphql` § Execution + Operator). This
 *       is the recommended path: O(1) and aligned with the rest of the
 *       discovery surface.
 *   (c) On-chain `IdentityRegistry.Registered` event scan filtered by the
 *       restorer's Safe address — cheaper than a global scan, but still O(n)
 *       in registered-events. Documented as a fallback only.
 *
 * This module implements (b). The fallback is intentionally **not** wired in
 * yet: the resolver returns `null` cleanly when the subgraph URL is undefined
 * or the query has no match, and the caller (the feedback hook) treats that
 * as a no-op (DR §4.3: "skip but don't fail — claimDelivery is authoritative").
 */

// ── Types ───────────────────────────────────────────────────────────────────

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

// ── Internal GraphQL response shape ─────────────────────────────────────────

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

// ── Resolver ────────────────────────────────────────────────────────────────

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
