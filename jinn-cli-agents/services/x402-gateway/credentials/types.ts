/**
 * Credential Bridge Types
 *
 * Defines the ACL structure for mapping agent addresses to OAuth credentials.
 * Agents authenticate via ERC-8128 signed HTTP requests; the bridge verifies
 * signer identity and returns fresh OAuth tokens from Nango.
 */

// ============================================================
// Trust & Identity
// ============================================================

/** Binary trust: operators are either trusted (admin-set via tierOverride) or untrusted (default) */
export type TrustTier = 'untrusted' | 'trusted';

/** Ordered trust tiers for comparison (higher index = more trust) */
export const TRUST_TIER_ORDER: TrustTier[] = ['untrusted', 'trusted'];

/** Returns true if `actual` meets or exceeds `required` */
export function tierMeetsMinimum(actual: TrustTier, required: TrustTier): boolean {
  return TRUST_TIER_ORDER.indexOf(actual) >= TRUST_TIER_ORDER.indexOf(required);
}

/** Normalize an Ethereum address to lowercase for consistent comparisons and storage */
export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/** Registered operator with calculated trust tier */
export interface Operator {
  address: string;
  serviceId: number | null;
  trustTier: TrustTier;
  tierOverride: TrustTier | null;
  registeredAt: string;
  updatedAt: string;
}

// ============================================================
// Credential Policies
// ============================================================

/** Global policy for auto-provisioning credentials to operators */
export interface CredentialPolicy {
  provider: string;
  minTrustTier: TrustTier;
  autoGrant: boolean;
  requiresApproval: boolean;
  defaultPrice: string;
  defaultNangoConnection: string | null;
  maxRequestsPerMinute: number;
  metadata: Record<string, unknown> | null;
}

// ============================================================
// Venture-Scoped Credentials
// ============================================================

/** How venture credential access interacts with global grants */
export type AccessMode = 'venture_only' | 'union_with_global';

/** A credential registered by a venture owner */
export interface VentureCredential {
  ventureId: string;
  provider: string;
  nangoConnectionId: string | null;
  minTrustTier: TrustTier;
  accessMode: AccessMode;
  pricePerAccess: string;
  active: boolean;
}

/** Operator entry in a venture's whitelist/blocklist */
export interface VentureCredentialOperator {
  ventureId: string;
  provider: string;
  operatorAddress: string;
  status: 'allowed' | 'blocked';
  grantedBy: string;
  grantedAt: string;
}

// ============================================================
// Admin Audit
// ============================================================

/** Admin action audit entry */
export interface AdminAuditEntry {
  action: string;
  actorAddress: string;
  targetAddress?: string;
  targetVentureId?: string;
  targetProvider?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  ipAddress?: string;
}

// ============================================================
// Existing ACL Types
// ============================================================

/** Metadata about a Nango OAuth connection */
export interface ConnectionEntry {
  provider: string;
  metadata?: Record<string, string>;
}

/** A grant giving an agent address access to a specific credential */
export interface CredentialGrant {
  nangoConnectionId: string;
  pricePerAccess: string; // wei, "0" = free
  expiresAt: string | null; // ISO timestamp or null = never
  active: boolean;
  ventureId?: string;
  autoProvisioned?: boolean;
  provisionedBy?: string;
  trustTierAtGrant?: TrustTier;
}

/** Full ACL file structure */
export interface CredentialACL {
  connections: Record<string, ConnectionEntry>;
  grants: Record<string, Record<string, CredentialGrant>>; // address → provider → grant
}

/** Request body for credential access */
export interface CredentialRequest {
  requestId?: string;
}

/** Response from credential endpoint */
export interface CredentialResponse {
  access_token: string;
  expires_in: number;
  provider: string;
  config: Record<string, string>;
}

/** Error response */
export interface CredentialError {
  error: string;
  code: 'INVALID_REQUEST' | 'INVALID_SIGNATURE' | 'NOT_AUTHORIZED' | 'PAYMENT_REQUIRED' | 'PAYMENT_INVALID' | 'PROVIDER_NOT_FOUND' | 'GRANT_EXPIRED' | 'NANGO_ERROR' | 'NONCE_REUSED' | 'RATE_LIMITED' | 'DUPLICATE_REQUEST' | 'JOB_NOT_ACTIVE' | 'JOB_CLAIM_MISMATCH' | 'JOB_VERIFICATION_UNAVAILABLE';
}
