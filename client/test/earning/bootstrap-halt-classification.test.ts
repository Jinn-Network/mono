/**
 * Issue #2407 / spec §5: classify a caught SetupBootstrapHalted's cause as
 * `economic` (degrade-open) or `integrity` (stay fail-closed / keep
 * blocking). Every code `failBootstrap` (earning/bootstrap-run.ts) actually
 * throws today — funding_required, bootstrap_incomplete, fatal — is
 * economic; integrity failures (chain-id mismatch, missing/undecryptable
 * keystore, the address-set digest mismatch) never reach
 * SetupBootstrapHalted at all — they throw/exit earlier in main.ts, before
 * the bootstrap retry loop. This classifier is a forward-looking guard: if
 * a future failBootstrap call site ever uses one of the denylisted codes,
 * it stays fail-closed by default rather than silently degrading open.
 */
import { describe, expect, it } from 'vitest';
import { isEconomicBootstrapHalt } from '../../src/earning/bootstrap-halt-classification.js';
import { buildEnvelope } from '../../src/errors/envelope.js';

describe('isEconomicBootstrapHalt', () => {
  it('classifies funding_required as economic', () => {
    const env = buildEnvelope({ code: 'funding_required', message: 'needs funds' });
    expect(isEconomicBootstrapHalt(env)).toBe(true);
  });

  it('classifies bootstrap_incomplete as economic', () => {
    const env = buildEnvelope({ code: 'bootstrap_incomplete', message: 'no service ready' });
    expect(isEconomicBootstrapHalt(env)).toBe(true);
  });

  it('classifies fatal as economic', () => {
    const env = buildEnvelope({ code: 'fatal', message: 'tx reverted' });
    expect(isEconomicBootstrapHalt(env)).toBe(true);
  });

  it('classifies transient_error as economic', () => {
    const env = buildEnvelope({ code: 'transient_error', message: 'rpc blip' });
    expect(isEconomicBootstrapHalt(env)).toBe(true);
  });

  it('classifies invalid_invocation as NOT economic (stays fail-closed)', () => {
    const env = buildEnvelope({ code: 'invalid_invocation', message: 'bad config' });
    expect(isEconomicBootstrapHalt(env)).toBe(false);
  });

  it('classifies reconcile_needed as NOT economic (stays fail-closed)', () => {
    const env = buildEnvelope({ code: 'reconcile_needed', message: 'fork detected' });
    expect(isEconomicBootstrapHalt(env)).toBe(false);
  });
});
