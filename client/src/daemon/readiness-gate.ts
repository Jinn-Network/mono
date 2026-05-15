/**
 * Pre-claim readiness check: cached snapshot lookup against
 * HarnessReadinessRegistry; logs on status-change transitions only.
 *
 * See docs/superpowers/specs/2026-05-15-per-harness-auth-design.md.
 */
import type { HarnessReadinessRegistry } from '../harnesses/readiness-registry.js';

export interface GateLogger {
  warn(msg: string): void;
  info(msg: string): void;
}

// Per-manifestCid status memo so we only log once per ready ↔ not-ready transition.
// MODULE-LEVEL STATE — see _resetReadinessGateMemoForTests below for the test contract.
const lastReadyByCid = new Map<string, boolean>();

export function gateClaimByReadiness(args: {
  manifestCid: string;
  registry: HarnessReadinessRegistry;
  logger: GateLogger;
}): { proceed: true } | { proceed: false; reason: string } {
  const status = args.registry.isReadyForClaim(args.manifestCid);
  const previousReady = lastReadyByCid.get(args.manifestCid);
  if (status.ready) {
    if (previousReady === false) {
      args.logger.info(`[readiness] ${args.manifestCid} now ready; resuming claims`);
    }
    lastReadyByCid.set(args.manifestCid, true);
    return { proceed: true };
  }
  if (previousReady !== false) {
    args.logger.warn(
      `[readiness] ${args.manifestCid} not ready (${status.reason ?? 'no reason'}); skipping claims`,
    );
  }
  lastReadyByCid.set(args.manifestCid, false);
  return { proceed: false, reason: status.reason ?? 'harness not ready' };
}

/**
 * Test-only: reset the per-cid memo between tests.
 *
 * IMPORTANT: any test file that imports `gateClaimByReadiness` must call this
 * in a `beforeEach` hook — the `lastReadyByCid` map is module-level state that
 * persists across tests in the same Vitest worker. Without the reset, the
 * transition-memo logic will produce false positives based on prior test runs.
 */
export function _resetReadinessGateMemoForTests(): void {
  lastReadyByCid.clear();
}
