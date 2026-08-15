/**
 * Shared stub for verificationOfRestoration.
 *
 * TODO(plan-d): replace with real SDK verification — read tier from restoration
 * envelope, supply actual SDK version, run real checks, and return a real outcome.
 * Until then every evaluator returns this identical placeholder so there is a single
 * site to update when Plan-D lands.
 */
export function buildVerificationStub(): {
  claimedTier: 'self-signed';
  sdkVersion: string;
  timestamp: number;
  checks: Array<{ name: string; passed: boolean }>;
  overall: 'valid';
} {
  return {
    claimedTier: 'self-signed',
    sdkVersion: '0.0.0-stub',
    timestamp: Date.now(),
    checks: [{ name: 'stub', passed: true }],
    overall: 'valid',
  };
}
