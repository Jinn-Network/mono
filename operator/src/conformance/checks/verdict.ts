/**
 * Layer 1 verdict-specific checks.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §3.3.
 *
 * Verdict envelopes must carry:
 *   - payload.solutionEnvelope: { cid, sha256 } — back-reference to the
 *     solution envelope being evaluated. V1: CID shape-only check; sha256
 *     verified against ctx.solutionEnvelopeBytes when provided.
 *   - payload.verificationOfRestoration: { claimedTier, sdkVersion, timestamp,
 *     checks[], overall } — structural validity.
 *
 * Both checks skip silently on solution-role envelopes.
 */

import { createHash } from 'node:crypto';
import type { CheckResult, ConformanceContext } from '../types.js';

// ─── checkVerdictBackReference ────────────────────────────────────────────────

/**
 * Check id: `verdict.back-ref`
 * Layer: 1
 *
 * For verdict-role envelopes:
 *   1. payload.solutionEnvelope must be present with string `cid` + `sha256`.
 *   2. If ctx.solutionEnvelopeBytes is provided, sha256(bytes) must match
 *      payload.solutionEnvelope.sha256.
 *   3. If ctx.solutionEnvelopeBytes is NOT provided, fail — solution
 *      CID did not resolve.
 *
 * Skipped on solution-role envelopes.
 */
export function checkVerdictBackReference(ctx: ConformanceContext): CheckResult {
  const id = 'verdict.back-ref';
  const layer = 1 as const;
  const env = ctx.envelope;

  if (!env) return { id, layer, passed: false, detail: 'envelope not loaded' };
  if (env.role !== 'verdict') {
    return { id, layer, passed: true, skipped: true };
  }

  const payload = env.payload as Record<string, unknown>;
  const ref = (payload?.solutionEnvelope ?? payload?.restorationEnvelope) as
    | { cid?: unknown; sha256?: unknown }
    | null
    | undefined;

  if (!ref || typeof ref.cid !== 'string' || typeof ref.sha256 !== 'string') {
    return {
      id,
      layer,
      passed: false,
      detail: 'payload.solutionEnvelope missing or malformed (requires cid + sha256 strings)',
    };
  }

  const solutionEnvelopeBytes = ctx.solutionEnvelopeBytes ?? ctx.restorationEnvelopeBytes;
  if (!solutionEnvelopeBytes) {
    return {
      id,
      layer,
      passed: false,
      detail: `solution CID ${ref.cid} did not resolve from IPFS`,
    };
  }

  const actualSha = createHash('sha256').update(solutionEnvelopeBytes).digest('hex');
  if (actualSha !== ref.sha256.toLowerCase()) {
    return {
      id,
      layer,
      passed: false,
      detail: `sha256 mismatch: fetched bytes sha256=${actualSha}, declared sha256=${ref.sha256}`,
    };
  }

  return { id, layer, passed: true };
}

// ─── checkVerificationRecord ──────────────────────────────────────────────────

/**
 * Check id: `verdict.verification-record`
 * Layer: 1
 *
 * For verdict-role envelopes:
 *   payload.verificationOfRestoration must be present and structurally valid:
 *     - claimedTier: string
 *     - sdkVersion: string
 *     - timestamp: number
 *     - checks: nonempty array
 *     - overall: 'valid' | 'invalid'
 *
 * Skipped on solution-role envelopes.
 */
export function checkVerificationRecord(ctx: ConformanceContext): CheckResult {
  const id = 'verdict.verification-record';
  const layer = 1 as const;
  const env = ctx.envelope;

  if (!env) return { id, layer, passed: false, detail: 'envelope not loaded' };
  if (env.role !== 'verdict') {
    return { id, layer, passed: true, skipped: true };
  }

  const payload = env.payload as Record<string, unknown>;
  const rec = payload?.verificationOfRestoration as Record<string, unknown> | null | undefined;

  if (!rec || typeof rec !== 'object') {
    return {
      id,
      layer,
      passed: false,
      detail: 'payload.verificationOfRestoration missing',
    };
  }

  const issues: string[] = [];

  if (typeof rec.claimedTier !== 'string') {
    issues.push('verificationOfRestoration.claimedTier must be a string');
  }
  if (typeof rec.sdkVersion !== 'string') {
    issues.push('verificationOfRestoration.sdkVersion must be a string');
  }
  if (typeof rec.timestamp !== 'number') {
    issues.push('verificationOfRestoration.timestamp must be a number');
  }
  if (!Array.isArray(rec.checks) || (rec.checks as unknown[]).length === 0) {
    issues.push('verificationOfRestoration.checks must be a nonempty array');
  }
  if (rec.overall !== 'valid' && rec.overall !== 'invalid') {
    issues.push(
      `verificationOfRestoration.overall must be 'valid' or 'invalid', got ${String(rec.overall)}`,
    );
  }

  if (issues.length === 0) return { id, layer, passed: true };

  return { id, layer, passed: false, detail: issues.join('; ') };
}
