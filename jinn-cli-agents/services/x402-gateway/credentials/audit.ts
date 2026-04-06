/**
 * Audit Logging for Credential Bridge
 *
 * Logs every credential access attempt (success or failure) for:
 * - Security monitoring and abuse detection
 * - Incident response forensics
 * - Compliance and accountability
 *
 * Two backends:
 * 1. Console (always): Structured JSON for Railway log viewer
 * 2. Postgres (optional): Queryable credential_audit_log table
 *
 * Fire-and-forget pattern — never blocks the response.
 */

import pg from 'pg';

const { Pool } = pg;

export type AuditAction =
  | 'token_issued'
  | 'auth_failed'
  | 'rate_limited'
  | 'payment_required'
  | 'payment_invalid'
  | 'not_authorized'
  | 'nango_error'
  | 'invalid_idempotency_key';

export interface AuditEntry {
  address: string;
  provider: string;
  action: AuditAction;
  ip: string;
  userAgent: string;
  requestId?: string;
  paymentRequiredAmount?: string;
  paymentPaidAmount?: string;
  paymentPayer?: string;
  paymentNetwork?: string;
  paymentErrorCode?: string;
  paymentErrorMessage?: string;
  verificationState?: 'valid' | 'invalid' | 'unavailable' | 'not_required';
  verificationError?: string;
  verificationDetail?: string;
  metadata?: Record<string, unknown>;
}

let pool: InstanceType<typeof Pool> | null = null;

function initAuditDb(): void {
  const url = process.env.AUDIT_DATABASE_URL || process.env.ACL_DATABASE_URL;
  if (url) {
    pool = new Pool({ connectionString: url, max: 3 });
    pool.on('error', (err) => console.error('[audit] Pool error:', err.message));
    console.log('[audit] Postgres audit logging ENABLED');
  } else {
    console.log('[audit] Console-only audit logging (no AUDIT_DATABASE_URL)');
  }
}

initAuditDb();

/**
 * Log an audit entry. Fire-and-forget — never blocks.
 *
 * IMPORTANT: Never include tokens or secrets in the entry!
 */
export function logAudit(entry: AuditEntry): void {
  const logObj = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  // Always emit structured console log (for Railway log viewer)
  console.log(`[audit] ${entry.action}`, JSON.stringify(logObj));

  // Fire-and-forget to Postgres if configured
  if (pool) {
    pool.query(
      `INSERT INTO credential_audit_log
       (address, provider, action, ip, user_agent, request_id,
        payment_required_amount, payment_paid_amount, payment_payer, payment_network,
        payment_error_code, payment_error_message, verification_state, verification_error, verification_detail,
        metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        entry.address,
        entry.provider,
        entry.action,
        entry.ip,
        entry.userAgent,
        entry.requestId || null,
        entry.paymentRequiredAmount || null,
        entry.paymentPaidAmount || null,
        entry.paymentPayer || null,
        entry.paymentNetwork || null,
        entry.paymentErrorCode || null,
        entry.paymentErrorMessage || null,
        entry.verificationState || null,
        entry.verificationError || null,
        entry.verificationDetail || null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ]
    ).catch((err) => console.error('[audit] DB write failed:', err.message));
  }
}

/**
 * Extract client IP from Hono request context.
 * Handles X-Forwarded-For (Railway, Cloudflare) and X-Real-IP (Nginx).
 */
export function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  // X-Forwarded-For: client, proxy1, proxy2
  const forwarded = c.req.header('X-Forwarded-For');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  // X-Real-IP (Nginx)
  const realIp = c.req.header('X-Real-IP');
  if (realIp) {
    return realIp;
  }

  return 'unknown';
}

/**
 * Extract User-Agent from Hono request context.
 */
export function getUserAgent(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('User-Agent') || 'unknown';
}
