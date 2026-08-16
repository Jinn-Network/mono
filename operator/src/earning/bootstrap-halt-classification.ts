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
 * Two independent layers, per code review (#2407 M2):
 *
 * 1. `INTEGRITY_HALT_CODES` is a denylist rather than an allowlist on
 *    `envelope.code` so this stays a genuine guard rather than a rubber
 *    stamp: a hypothetical future `failBootstrap` call site using
 *    `invalid_invocation` or `reconcile_needed` (misconfiguration /
 *    fork-detection style failures) stays fail-closed by default instead of
 *    silently degrading open. This layer CAN return `false` (fail-closed).
 *
 * 2. For every other code, `envelope.details.category` (when present) is
 *    checked against `ECONOMIC_HALT_CATEGORIES` — but purely for
 *    observability, never to flip the result. An unrecognized category
 *    still degrades open, with a loud `console.warn` naming it, rather than
 *    failing closed: the pinned address-set digest (earning/address-digests.ts)
 *    already guards the one scenario integrity-closing would actually
 *    protect against (a misconfigured broadcaster), so treating an
 *    unrecognized category as fail-closed would instead recreate the exact
 *    absorbing state spec §5 exists to prevent — any new transient error
 *    string (a wallet-lib version bump, a new RPC provider's revert
 *    message) would silently brick every fleet that hits it, with no
 *    address-set problem to actually blame. Absent `category` (e.g.
 *    `bootstrap_incomplete`, which never sets one) is not a warning case —
 *    it's simply "no category to check," economic by the code-level result.
 */
import type { ErrorEnvelope } from '../errors/envelope.js';

const INTEGRITY_HALT_CODES = new Set<ErrorEnvelope['code']>(['invalid_invocation', 'reconcile_needed']);

/** Named categories `fatal`/`funding_required` envelopes may carry (see FleetBootstrapResult.errorCategory). */
const ECONOMIC_HALT_CATEGORIES = new Set(['insufficient_funds', 'gas_too_low', 'nonce_conflict']);

export function isEconomicBootstrapHalt(envelope: ErrorEnvelope): boolean {
  if (INTEGRITY_HALT_CODES.has(envelope.code)) return false;

  const category = envelope.details?.['category'];
  if (category !== undefined && !(typeof category === 'string' && ECONOMIC_HALT_CATEGORIES.has(category))) {
    console.warn(
      `[bootstrap-halt-classification] Unrecognized halt category '${String(category)}' for code ` +
        `'${envelope.code}' — degrading open rather than fail-closed (see this module's docstring for why).`,
    );
  }
  return true;
}

/**
 * Issue #2407 B2: true when this halt is specifically a master-EOA funding
 * shortfall (`code: 'funding_required'` with `details.role === 'master'` —
 * the only role `bootstrap-run.ts`'s funding gate ever sets today). The
 * caller uses this to omit the degraded balance-topup loop while such a
 * halt is pending: balance-topup sends ETH FROM the master wallet, so
 * running it degraded would compete with the funding poller for the exact
 * balance the poller is waiting to see cross the threshold — an absorbing
 * state where a fresh deposit gets spent on topups before the poller's next
 * check. Every OTHER economic halt (bootstrap_incomplete, a recoverable
 * on-chain error, a non-master funding shortfall if one is ever introduced)
 * still runs balance-topup normally — topups exist to keep already-working
 * agents signing, and a daemon halted on its OWN master funding isn't
 * claiming work regardless.
 */
export function isPendingMasterFundingHalt(envelope: ErrorEnvelope): boolean {
  return envelope.code === 'funding_required' && envelope.details?.['role'] === 'master';
}
