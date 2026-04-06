/**
 * Admin Routes for Credential Management
 *
 * Mounted at /admin/* on the x402-gateway.
 *
 * Auth levels:
 * - Self-service: ERC-8128 signer on own address (operator registration)
 * - Venture owner: ERC-8128 signer matches ventures.owner_address
 * - Platform admin: ERC-8128 signer in ADMIN_ADDRESSES env var
 */

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { TrustTier, CredentialPolicy } from './types.js';
import { getOperator, listOperators, registerOperator, updateOperatorAdmin } from './operators.js';
import { getPolicy, listPolicies, upsertPolicy } from './policies.js';
import {
  getVentureCredential,
  listVentureCredentials,
  upsertVentureCredential,
  setOperatorStatus,
  removeOperatorEntry,
  listOperatorEntries,
} from './venture-credentials.js';
import { logAdminAudit } from './admin-audit.js';
import { queryAdminAudit } from './admin-audit.js';
import { verifyVentureOwner } from './supabase.js';
import { verifyRequestWithErc8128 } from '../../../jinn-node/dist/http/erc8128.js';
import { getCredentialNonceStore } from './redis.js';
import { getClientIp } from './audit.js';

const adminApp = new Hono();

// ============================================================
// Auth Helpers
// ============================================================

const ADMIN_ADDRESSES = new Set(
  (process.env.ADMIN_ADDRESSES || '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
);

if (ADMIN_ADDRESSES.size > 0) {
  console.log(`[admin] ${ADMIN_ADDRESSES.size} admin address(es) configured`);
} else {
  console.warn('[admin] No ADMIN_ADDRESSES configured — admin endpoints disabled');
}

async function authenticateAdmin(request: Request): Promise<
  | { ok: true; address: string; isAdmin: boolean }
  | { ok: false; error: string; status: ContentfulStatusCode }
> {
  const nonceStore = getCredentialNonceStore();
  const result = await verifyRequestWithErc8128({
    request,
    nonceStore,
    policy: {
      label: 'eth',
      strictLabel: true,
      replayable: false,
      clockSkewSec: 5,
      maxValiditySec: 300,
      maxNonceWindowSec: 300,
    },
  });

  if (!result.ok) {
    return { ok: false, error: `Invalid ERC-8128 signature: ${result.reason}`, status: 401 as ContentfulStatusCode };
  }

  const address = result.address.toLowerCase();
  return { ok: true, address, isAdmin: ADMIN_ADDRESSES.has(address) };
}

function requireAdmin(auth: { ok: true; isAdmin: boolean }): { ok: false; error: string; status: ContentfulStatusCode } | null {
  if (!auth.isAdmin) {
    return { ok: false, error: 'Admin access required', status: 403 as ContentfulStatusCode };
  }
  return null;
}

// ============================================================
// Operator Endpoints
// ============================================================

/**
 * POST /admin/operators — Register an operator
 *
 * Body: { serviceId?: number }
 * Auth: ERC-8128 (proves caller owns the EOA)
 *
 * Registers the operator. Tier is 'untrusted' by default —
 * an admin must whitelist to grant 'trusted' status.
 */
adminApp.post('/operators', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  let body: { serviceId?: number };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const result = await registerOperator({
    address: auth.address,
    serviceId: body.serviceId,
    actorAddress: auth.address,
    ipAddress: getClientIp(c),
  });

  return c.json({
    address: result.operator.address,
    serviceId: result.operator.serviceId,
    trustTier: result.operator.trustTier,
    grants: result.grantsAdded,
  }, 201);
});

/**
 * GET /admin/operators/:address — Look up an operator
 *
 * Auth: ERC-8128 (self or admin)
 */
adminApp.get('/operators/:address', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const targetAddress = c.req.param('address').toLowerCase();

  // Self-service: can view own record. Admin: can view any.
  if (auth.address !== targetAddress && !auth.isAdmin) {
    return c.json({ error: 'Can only view your own operator record' }, 403);
  }

  const operator = await getOperator(targetAddress);
  if (!operator) {
    return c.json({ error: 'Operator not found' }, 404);
  }

  return c.json(operator);
});

/**
 * GET /admin/operators — List operators (admin only)
 */
adminApp.get('/operators', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status);

  const tier = c.req.query('tier') as TrustTier | undefined;
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const operators = await listOperators({ trustTier: tier, limit, offset });
  return c.json({ operators });
});

/**
 * PUT /admin/operators/:address — Whitelist or override tier (admin only)
 *
 * Body: { tierOverride?: TrustTier | null }
 */
adminApp.put('/operators/:address', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status);

  let body: { tierOverride?: TrustTier | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const targetAddress = c.req.param('address').toLowerCase();

  try {
    const result = await updateOperatorAdmin({
      address: targetAddress,
      tierOverride: body.tierOverride,
      actorAddress: auth.address,
      ipAddress: getClientIp(c),
    });

    return c.json({
      address: result.operator.address,
      trustTier: result.operator.trustTier,
      tierOverride: result.operator.tierOverride,
      grantsAdded: result.grantsAdded,
      grantsRevoked: result.grantsRevoked,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not registered')) {
      return c.json({ error: msg }, 404);
    }
    throw err;
  }
});

// ============================================================
// Policy Endpoints (admin only)
// ============================================================

/**
 * GET /admin/policies — List all credential policies
 */
adminApp.get('/policies', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status);

  const policies = await listPolicies();
  return c.json({ policies });
});

/**
 * POST /admin/policies — Create or update a credential policy
 */
adminApp.post('/policies', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status);

  let body: Partial<CredentialPolicy> & { provider: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.provider) {
    return c.json({ error: 'provider is required' }, 400);
  }

  const before = await getPolicy(body.provider);

  const policy = await upsertPolicy({
    provider: body.provider,
    minTrustTier: body.minTrustTier ?? 'trusted',
    autoGrant: body.autoGrant ?? false,
    requiresApproval: body.requiresApproval ?? false,
    defaultPrice: body.defaultPrice ?? '0',
    defaultNangoConnection: body.defaultNangoConnection ?? null,
    maxRequestsPerMinute: body.maxRequestsPerMinute ?? 10,
    metadata: body.metadata ?? null,
  });

  logAdminAudit({
    action: before ? 'policy.update' : 'policy.create',
    actorAddress: auth.address,
    targetProvider: body.provider,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: policy as unknown as Record<string, unknown>,
    ipAddress: getClientIp(c),
  });

  return c.json(policy, before ? 200 : 201);
});

/**
 * PUT /admin/policies/:provider — Update a specific policy
 */
adminApp.put('/policies/:provider', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status);

  const provider = c.req.param('provider');
  const before = await getPolicy(provider);
  if (!before) {
    return c.json({ error: `Policy for ${provider} not found` }, 404);
  }

  let body: Partial<CredentialPolicy>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const policy = await upsertPolicy({
    provider,
    minTrustTier: body.minTrustTier ?? before.minTrustTier,
    autoGrant: body.autoGrant ?? before.autoGrant,
    requiresApproval: body.requiresApproval ?? before.requiresApproval,
    defaultPrice: body.defaultPrice ?? before.defaultPrice,
    defaultNangoConnection: body.defaultNangoConnection ?? before.defaultNangoConnection,
    maxRequestsPerMinute: body.maxRequestsPerMinute ?? before.maxRequestsPerMinute,
    metadata: body.metadata ?? before.metadata,
  });

  logAdminAudit({
    action: 'policy.update',
    actorAddress: auth.address,
    targetProvider: provider,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: policy as unknown as Record<string, unknown>,
    ipAddress: getClientIp(c),
  });

  return c.json(policy);
});

// ============================================================
// Venture Credential Endpoints (venture owner or admin)
// ============================================================

/**
 * Verify the caller is the venture owner or a platform admin.
 */
async function requireVentureOwnerOrAdmin(
  ventureId: string,
  auth: { ok: true; address: string; isAdmin: boolean },
): Promise<{ ok: false; error: string; status: ContentfulStatusCode } | null> {
  if (auth.isAdmin) return null;

  try {
    const venture = await verifyVentureOwner(ventureId, auth.address);
    if (!venture) {
      return { ok: false, error: 'Not the venture owner', status: 403 as ContentfulStatusCode };
    }
    return null;
  } catch (err) {
    console.error('[admin] Venture ownership check failed (fail-closed):', err instanceof Error ? err.message : String(err));
    return { ok: false, error: 'Venture ownership verification failed', status: 403 as ContentfulStatusCode };
  }
}

/**
 * POST /admin/venture-credentials — Register a credential for a venture
 */
adminApp.post('/venture-credentials', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  let body: {
    ventureId: string;
    provider: string;
    nangoConnectionId?: string;
    minTrustTier?: TrustTier;
    accessMode?: 'venture_only' | 'union_with_global';
    pricePerAccess?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.ventureId || !body.provider) {
    return c.json({ error: 'ventureId and provider are required' }, 400);
  }

  const ownerCheck = await requireVentureOwnerOrAdmin(body.ventureId, auth);
  if (ownerCheck) return c.json({ error: ownerCheck.error }, ownerCheck.status);

  const before = await getVentureCredential(body.ventureId, body.provider);

  const vc = await upsertVentureCredential({
    ventureId: body.ventureId,
    provider: body.provider,
    nangoConnectionId: body.nangoConnectionId ?? null,
    minTrustTier: body.minTrustTier ?? 'trusted',
    accessMode: body.accessMode ?? 'venture_only',
    pricePerAccess: body.pricePerAccess ?? '0',
    active: true,
  });

  logAdminAudit({
    action: before ? 'venture_credential.update' : 'venture_credential.create',
    actorAddress: auth.address,
    targetVentureId: body.ventureId,
    targetProvider: body.provider,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: vc as unknown as Record<string, unknown>,
    ipAddress: getClientIp(c),
  });

  return c.json(vc, before ? 200 : 201);
});

/**
 * PUT /admin/venture-credentials/:ventureId/:provider — Update venture credential settings
 */
adminApp.put('/venture-credentials/:ventureId/:provider', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const ventureId = c.req.param('ventureId');
  const provider = c.req.param('provider');

  const ownerCheck = await requireVentureOwnerOrAdmin(ventureId, auth);
  if (ownerCheck) return c.json({ error: ownerCheck.error }, ownerCheck.status);

  const before = await getVentureCredential(ventureId, provider);
  if (!before) {
    return c.json({ error: 'Venture credential not found' }, 404);
  }

  let body: {
    minTrustTier?: TrustTier;
    accessMode?: 'venture_only' | 'union_with_global';
    pricePerAccess?: string;
    active?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const vc = await upsertVentureCredential({
    ventureId,
    provider,
    nangoConnectionId: before.nangoConnectionId,
    minTrustTier: body.minTrustTier ?? before.minTrustTier,
    accessMode: body.accessMode ?? before.accessMode,
    pricePerAccess: body.pricePerAccess ?? before.pricePerAccess,
    active: body.active ?? before.active,
  });

  logAdminAudit({
    action: 'venture_credential.update',
    actorAddress: auth.address,
    targetVentureId: ventureId,
    targetProvider: provider,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: vc as unknown as Record<string, unknown>,
    ipAddress: getClientIp(c),
  });

  return c.json(vc);
});

/**
 * GET /admin/venture-credentials/:ventureId — List credentials for a venture
 */
adminApp.get('/venture-credentials/:ventureId', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const ventureId = c.req.param('ventureId');
  const ownerCheck = await requireVentureOwnerOrAdmin(ventureId, auth);
  if (ownerCheck) return c.json({ error: ownerCheck.error }, ownerCheck.status);

  const credentials = await listVentureCredentials(ventureId);
  return c.json({ credentials });
});

/**
 * POST /admin/venture-credentials/:ventureId/:provider/operators — Add to whitelist/blocklist
 *
 * Body: { addresses: string[], status?: 'allowed' | 'blocked' }
 */
adminApp.post('/venture-credentials/:ventureId/:provider/operators', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const ventureId = c.req.param('ventureId');
  const provider = c.req.param('provider');

  const ownerCheck = await requireVentureOwnerOrAdmin(ventureId, auth);
  if (ownerCheck) return c.json({ error: ownerCheck.error }, ownerCheck.status);

  let body: { addresses: string[]; status?: 'allowed' | 'blocked' };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.addresses || !Array.isArray(body.addresses) || body.addresses.length === 0) {
    return c.json({ error: 'addresses array is required' }, 400);
  }

  const status = body.status ?? 'allowed';
  const results = [];
  for (const addr of body.addresses) {
    const entry = await setOperatorStatus({
      ventureId,
      provider,
      operatorAddress: addr,
      status,
      grantedBy: auth.address,
    });
    results.push(entry);
  }

  logAdminAudit({
    action: `venture_credential_operators.${status === 'blocked' ? 'block' : 'allow'}`,
    actorAddress: auth.address,
    targetVentureId: ventureId,
    targetProvider: provider,
    afterState: { addresses: body.addresses, status },
    ipAddress: getClientIp(c),
  });

  return c.json({ operators: results }, 201);
});

/**
 * DELETE /admin/venture-credentials/:ventureId/:provider/operators/:address — Remove from list
 */
adminApp.delete('/venture-credentials/:ventureId/:provider/operators/:address', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const ventureId = c.req.param('ventureId');
  const provider = c.req.param('provider');
  const targetAddress = c.req.param('address');

  const ownerCheck = await requireVentureOwnerOrAdmin(ventureId, auth);
  if (ownerCheck) return c.json({ error: ownerCheck.error }, ownerCheck.status);

  const removed = await removeOperatorEntry(ventureId, provider, targetAddress);

  if (removed) {
    logAdminAudit({
      action: 'venture_credential_operators.remove',
      actorAddress: auth.address,
      targetAddress,
      targetVentureId: ventureId,
      targetProvider: provider,
      ipAddress: getClientIp(c),
    });
  }

  return c.json({ removed });
});

/**
 * GET /admin/venture-credentials/:ventureId/:provider/operators — List whitelist/blocklist
 */
adminApp.get('/venture-credentials/:ventureId/:provider/operators', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const ventureId = c.req.param('ventureId');
  const provider = c.req.param('provider');

  const ownerCheck = await requireVentureOwnerOrAdmin(ventureId, auth);
  if (ownerCheck) return c.json({ error: ownerCheck.error }, ownerCheck.status);

  const operators = await listOperatorEntries(ventureId, provider);
  return c.json({ operators });
});

// ============================================================
// Audit Log Endpoint (admin only)
// ============================================================

/**
 * GET /admin/audit-log — Query admin audit log
 */
adminApp.get('/audit-log', async (c) => {
  const auth = await authenticateAdmin(c.req.raw.clone());
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);
  const adminCheck = requireAdmin(auth);
  if (adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status);

  const entries = await queryAdminAudit({
    actor: c.req.query('actor'),
    target: c.req.query('target'),
    action: c.req.query('action'),
    ventureId: c.req.query('ventureId'),
    limit: parseInt(c.req.query('limit') || '50', 10),
    offset: parseInt(c.req.query('offset') || '0', 10),
  });

  return c.json({ entries });
});

export { adminApp };
