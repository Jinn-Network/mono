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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isEconomicBootstrapHalt,
  isPendingMasterFundingHalt,
} from '../../src/earning/bootstrap-halt-classification.js';
import { buildEnvelope } from '../../src/errors/envelope.js';

describe('isEconomicBootstrapHalt', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

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

  // ── M2: category consultation is observability-only, never fail-closed ──

  it('does not warn when no category is present (e.g. bootstrap_incomplete)', () => {
    const env = buildEnvelope({ code: 'bootstrap_incomplete', message: 'no service ready' });
    expect(isEconomicBootstrapHalt(env)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn for a recognized economic category', () => {
    const env = buildEnvelope({
      code: 'fatal',
      message: 'tx reverted',
      details: { category: 'insufficient_funds' },
    });
    expect(isEconomicBootstrapHalt(env)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('recognizes gas_too_low and nonce_conflict without warning', () => {
    for (const category of ['gas_too_low', 'nonce_conflict']) {
      warnSpy.mockClear();
      const env = buildEnvelope({ code: 'fatal', message: 'tx reverted', details: { category } });
      expect(isEconomicBootstrapHalt(env)).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  it('degrades OPEN (not fail-closed) for an unrecognized category, with a loud warning naming it', () => {
    const env = buildEnvelope({
      code: 'fatal',
      message: 'tx reverted',
      details: { category: 'some_brand_new_error_string' },
    });
    expect(isEconomicBootstrapHalt(env)).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('some_brand_new_error_string');
  });

  it('does not consult category at all for an integrity-denylisted code (stays fail-closed, no warning)', () => {
    const env = buildEnvelope({
      code: 'invalid_invocation',
      message: 'bad config',
      details: { category: 'anything' },
    });
    expect(isEconomicBootstrapHalt(env)).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('isPendingMasterFundingHalt (#2407 B2)', () => {
  it('is true for funding_required with role: master', () => {
    const env = buildEnvelope({
      code: 'funding_required',
      message: 'needs funds',
      details: { role: 'master' },
    });
    expect(isPendingMasterFundingHalt(env)).toBe(true);
  });

  it('is false for funding_required with no role field', () => {
    const env = buildEnvelope({ code: 'funding_required', message: 'needs funds' });
    expect(isPendingMasterFundingHalt(env)).toBe(false);
  });

  it('is false for funding_required with a different role', () => {
    const env = buildEnvelope({
      code: 'funding_required',
      message: 'needs funds',
      details: { role: 'agent' },
    });
    expect(isPendingMasterFundingHalt(env)).toBe(false);
  });

  it('is false for any non-funding_required code, even with role: master', () => {
    const env = buildEnvelope({
      code: 'fatal',
      message: 'tx reverted',
      details: { role: 'master' },
    });
    expect(isPendingMasterFundingHalt(env)).toBe(false);
  });
});
