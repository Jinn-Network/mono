/**
 * Classifies a caught `SetupBootstrapHalted` (earning/bootstrap-run.ts) as
 * economic (degrade-open, spec §5) or integrity (stay fail-closed).
 *
 * In practice every `failBootstrap` call site today uses one of
 * `funding_required` / `bootstrap_incomplete` / `fatal` — all economic
 * (spec §5's list: "service evicted, Safe under-funded, service unstaked,
 * agent unbound, bootstrap halted mid-way"). Integrity failures (RPC
 * chain-id mismatch, a missing/undecryptable keystore, the pinned
 * broadcast-target address-set digest mismatch) never reach
 * `SetupBootstrapHalted` — they throw or `emitEnvelope`-exit earlier in
 * `main.ts`, before the bootstrap retry loop even starts.
 *
 * `INTEGRITY_HALT_CODES` is a denylist rather than an allowlist so this
 * stays a genuine guard rather than a rubber stamp: a hypothetical future
 * `failBootstrap` call site using `invalid_invocation` or `reconcile_needed`
 * (misconfiguration / fork-detection style failures) stays fail-closed by
 * default instead of silently degrading open.
 */
import type { ErrorEnvelope } from '../errors/envelope.js';

const INTEGRITY_HALT_CODES = new Set<ErrorEnvelope['code']>(['invalid_invocation', 'reconcile_needed']);

export function isEconomicBootstrapHalt(envelope: ErrorEnvelope): boolean {
  return !INTEGRITY_HALT_CODES.has(envelope.code);
}
