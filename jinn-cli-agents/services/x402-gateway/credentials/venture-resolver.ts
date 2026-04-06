/**
 * Venture Context Resolver
 *
 * Resolves venture context from a requestId for the credential request flow:
 *   requestId → Ponder (request.sender) → Supabase (ventures.owner_address) → ventureId
 *
 * Also provides venture-scoped credential discovery for the capabilities probe.
 */

import { getOperator } from './operators.js';
import { checkVentureAccess, listVentureCredentials, getVentureCredential } from './venture-credentials.js';
import { getSupabaseClient } from './supabase.js';
import type { TrustTier, VentureCredential } from './types.js';

const ponderUrl = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';

export interface VentureContext {
  ventureId: string;
  ventureName: string;
  senderAddress: string;
}

/**
 * Resolve venture context from a requestId.
 *
 * Chain: requestId → Ponder (sender) → Supabase (venture by owner_address)
 *
 * Returns null if no venture context can be resolved (not an error — just means
 * the job isn't associated with a venture).
 */
export async function resolveVentureContext(requestId: string): Promise<VentureContext | null> {
  // Step 1: Query Ponder for the request's sender
  let sender: string | null = null;
  try {
    const res = await fetch(ponderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query ($id: String!) { request(id: $id) { sender } }`,
        variables: { id: requestId },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[venture-resolver] Ponder query failed: ${res.status}`);
      return null;
    }

    const data = await res.json() as { data?: { request?: { sender: string } } };
    sender = data?.data?.request?.sender ?? null;
  } catch (err) {
    console.warn('[venture-resolver] Ponder query error:', err instanceof Error ? err.message : String(err));
    return null;
  }

  if (!sender) return null;

  // Step 2: Look up venture by owner_address in Supabase
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('ventures')
      .select('id, name')
      .eq('owner_address', sender.toLowerCase())
      .eq('status', 'active')
      .limit(1)
      .single();

    if (error || !data) return null;

    return {
      ventureId: data.id,
      ventureName: data.name,
      senderAddress: sender.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export interface VentureAccessDecision {
  /** The venture credential to use (if venture-scoped access is granted) */
  ventureCredential: VentureCredential | null;
  /** Whether to skip global grant fallback */
  blockGlobalFallback: boolean;
  /** Whether venture-scoped access was granted */
  ventureAccessGranted: boolean;
  /** Why access was granted or denied */
  reason: string;
}

/**
 * Check venture-scoped credential access for an operator.
 *
 * Called during the credential request flow after job verification.
 * If a venture context exists and the venture has registered the provider,
 * this determines whether the operator gets venture-scoped access.
 */
export async function checkVentureCredentialAccess(params: {
  requestId: string;
  provider: string;
  operatorAddress: string;
}): Promise<VentureAccessDecision> {
  // Resolve venture context
  const ventureCtx = await resolveVentureContext(params.requestId);
  if (!ventureCtx) {
    return {
      ventureCredential: null,
      blockGlobalFallback: false,
      ventureAccessGranted: false,
      reason: 'no_venture_context',
    };
  }

  // Get operator — unregistered operators are denied outright,
  // but we must still respect venture_only access mode to block global fallback.
  const operator = await getOperator(params.operatorAddress);
  if (!operator) {
    const vc = await getVentureCredential(ventureCtx.ventureId, params.provider);
    const blockGlobal = vc?.active && vc.accessMode === 'venture_only';
    return {
      ventureCredential: null,
      blockGlobalFallback: blockGlobal ?? false,
      ventureAccessGranted: false,
      reason: 'operator_not_registered',
    };
  }

  // Check access using operator's actual trust tier
  const accessResult = await checkVentureAccess({
    ventureId: ventureCtx.ventureId,
    provider: params.provider,
    operatorAddress: params.operatorAddress,
    operatorTrustTier: operator.trustTier,
  });

  if (accessResult.reason === 'no_credential') {
    // Venture exists but hasn't registered this provider — fall through to global
    return {
      ventureCredential: null,
      blockGlobalFallback: false,
      ventureAccessGranted: false,
      reason: 'venture_no_credential',
    };
  }

  return {
    ventureCredential: accessResult.allowed ? (accessResult.ventureCredential ?? null) : null,
    blockGlobalFallback: accessResult.blockGlobalFallback,
    ventureAccessGranted: accessResult.allowed,
    reason: accessResult.reason,
  };
}

export interface VentureProviderDiscovery {
  /** Providers the operator can access via this venture */
  accessible: string[];
  /** Providers where venture_only mode blocks global fallback for this operator */
  blockedFromGlobal: string[];
}

/**
 * Discover venture-scoped credential providers for the capabilities probe.
 *
 * Given a requestId, resolves the venture and returns:
 * - accessible: providers the operator has venture-scoped access to
 * - blockedFromGlobal: providers where venture_only mode denies the operator
 *   and global fallback must be suppressed
 */
export async function discoverVentureProviders(params: {
  requestId: string;
  operatorAddress: string;
}): Promise<VentureProviderDiscovery> {
  const empty: VentureProviderDiscovery = { accessible: [], blockedFromGlobal: [] };

  const ventureCtx = await resolveVentureContext(params.requestId);
  if (!ventureCtx) return empty;

  const credentials = await listVentureCredentials(ventureCtx.ventureId);
  if (credentials.length === 0) return empty;

  const operator = await getOperator(params.operatorAddress);
  if (!operator) {
    // Unregistered operators: no venture access, but venture_only providers block global fallback
    const blockedFromGlobal: string[] = [];
    for (const vc of credentials) {
      if (vc.active && vc.accessMode === 'venture_only') {
        blockedFromGlobal.push(vc.provider);
      }
    }
    return { accessible: [], blockedFromGlobal };
  }

  const accessible: string[] = [];
  const blockedFromGlobal: string[] = [];
  for (const vc of credentials) {
    const access = await checkVentureAccess({
      ventureId: ventureCtx.ventureId,
      provider: vc.provider,
      operatorAddress: params.operatorAddress,
      operatorTrustTier: operator.trustTier,
    });
    if (access.allowed) {
      accessible.push(vc.provider);
    } else if (access.blockGlobalFallback) {
      blockedFromGlobal.push(vc.provider);
    }
  }

  return { accessible, blockedFromGlobal };
}
