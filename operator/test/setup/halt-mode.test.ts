/**
 * Tests for the halt-and-resume gate (jinn-mono-hjex.6).
 *
 * `keepSetupUiOnBootstrapError()` is the predicate that decides whether
 * `failBootstrap()` in main.ts throws `SetupBootstrapHalted` (entering the
 * retry loop) vs calls `emitEnvelope()` (which exits). Headless modes
 * (JINN_NO_UI=1 / JINN_NO_DAEMON=1) MUST exit; interactive mode MUST halt
 * so the SPA can offer Retry.
 *
 * Also documents the inflight-promise coalescing pattern referenced by
 * fix #4 in PR #243 review (the endpoint-level test for coalescing lives
 * in operator/test/api/setup-retry-endpoint.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { keepSetupUiOnBootstrapError } from '../../src/setup/halt-mode.js';

describe('keepSetupUiOnBootstrapError', () => {
  it('returns true for an interactive env (neither flag set)', () => {
    expect(keepSetupUiOnBootstrapError({})).toBe(true);
  });

  it('returns false when JINN_NO_UI=1 (operator runs headless)', () => {
    expect(keepSetupUiOnBootstrapError({ JINN_NO_UI: '1' })).toBe(false);
  });

  it('returns false when JINN_NO_DAEMON=1 (CI / agent-driven one-shot)', () => {
    expect(keepSetupUiOnBootstrapError({ JINN_NO_DAEMON: '1' })).toBe(false);
  });

  it('returns false when both flags are set', () => {
    expect(
      keepSetupUiOnBootstrapError({ JINN_NO_UI: '1', JINN_NO_DAEMON: '1' }),
    ).toBe(false);
  });

  it('treats values other than exactly "1" as interactive (matches main.ts strict check)', () => {
    expect(keepSetupUiOnBootstrapError({ JINN_NO_UI: 'true' })).toBe(true);
    expect(keepSetupUiOnBootstrapError({ JINN_NO_UI: '0' })).toBe(true);
    expect(keepSetupUiOnBootstrapError({ JINN_NO_DAEMON: 'yes' })).toBe(true);
  });

  it('defaults to reading process.env when no arg is supplied', () => {
    // Smoke test — the no-arg overload exists and returns a boolean.
    expect(typeof keepSetupUiOnBootstrapError()).toBe('boolean');
  });
});
