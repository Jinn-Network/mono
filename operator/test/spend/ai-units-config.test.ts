/**
 * buildAiUnitsConfig — assembles the daemon's AI-units gate config from
 * operator config (executionWiring — gives us the model per workKind)
 * + env (override + provider credentials). Returns undefined only when
 * nothing maps to a known credential at all; otherwise the gate always
 * runs (the ceiling is hard-coded, not opt-in).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAiUnitsConfig } from '../../src/spend/ai-units-config.js';
import { REFERENCE_CEILING } from '../../src/spend/ai-units.js';
import type { ExecutionWiringConfigEntry } from '../../src/config/shape-v2.js';

function wiringEntry(
  workKind: string,
  harness: string,
  model = 'claude-haiku-4-5-20251001',
): ExecutionWiringConfigEntry {
  return {
    workKind,
    harness,
    model,
    plugins: [],
    credentialRef: `${harness}-default`,
    isolationPolicy: 'process',
  };
}

const executionWiring: ExecutionWiringConfigEntry[] = [
  wiringEntry('bafycid1', 'hermes-agent', 'anthropic/claude-opus-4.7'),
  wiringEntry('bafycid2', 'claude-code', 'claude-opus-4-7'),
  wiringEntry('bafycid3', 'prediction-v1-baseline'),
];

describe('buildAiUnitsConfig', () => {
  let home: string;

  beforeEach(() => {
    // Empty home isolates tests from the dev machine's real `~/.claude`.
    home = mkdtempSync(join(tmpdir(), 'aiunits-cfg-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns undefined when no wiring entries resolve to a credential', () => {
    const noLlm = [wiringEntry('bafycid3', 'prediction-v1-baseline')];
    expect(
      buildAiUnitsConfig({ executionWiring: noLlm }, {}, home),
    ).toBeUndefined();
  });

  it('maps each manifest CID to its credential + projected per-task AI units', () => {
    const out = buildAiUnitsConfig({ executionWiring }, {}, home);
    // bafycid1 — hermes-agent → "hermes:api-key" (default provider)
    expect(out?.manifestCredentials['bafycid1']).toBe('hermes:api-key');
    // bafycid2 — claude-code with no env var AND no ~/.claude/ on isolated home → null
    expect(out?.manifestCredentials['bafycid2']).toBeUndefined();
    expect(out?.manifestCredentials['bafycid3']).toBeUndefined();
    // Per-manifest projected units for the priced model
    expect(out?.manifestProjectedAiUnits['bafycid1']).toBeGreaterThan(0);
    expect(out?.manifestModels['bafycid1']).toBe('anthropic/claude-opus-4.7');
  });

  it('applies the baked-in REFERENCE_CEILING by default', () => {
    const out = buildAiUnitsConfig({ executionWiring }, {}, home);
    expect(out?.capPerBlock).toBe(REFERENCE_CEILING.units_per_block);
    expect(out?.capPerWeek).toBe(REFERENCE_CEILING.units_per_week);
  });

  it('honours JINN_AI_UNITS_CEILING_OVERRIDE', () => {
    const out = buildAiUnitsConfig(
      { executionWiring },
      { JINN_AI_UNITS_CEILING_OVERRIDE: '10' },
      home,
    );
    expect(out?.capPerBlock).toBe(10);
    expect(out?.capPerWeek).toBe(280);
  });

  it('claude-code on a stock subscription install (~/.claude/ present, no env) projects model cost (#901)', () => {
    mkdirSync(join(home, '.claude'));
    const out = buildAiUnitsConfig({ executionWiring }, {}, home);
    expect(out?.manifestCredentials['bafycid2']).toBe('anthropic:subscription');
    // Opus 4.7 projects ~450 units/task at the GPT-5.4-mini peg.
    expect(out?.manifestProjectedAiUnits['bafycid2']).toBeGreaterThan(100);
  });

  it('claude-code under bare CLI session auth resolves to anthropic:subscription end-to-end (#891)', () => {
    // Regression lock for AC1/AC2: bare CLI session auth means no env var at
    // all, just `~/.claude/` on disk. #901 wired on-disk OAuth detection into
    // resolveCredentialId; this asserts it survives through buildAiUnitsConfig
    // so /v1/status enrols the credential and projects a non-zero USD cost.
    mkdirSync(join(home, '.claude'));
    const out = buildAiUnitsConfig({ executionWiring }, {}, home);
    expect(out?.manifestCredentials['bafycid2']).toBe('anthropic:subscription');
    expect(out?.manifestProjectedUsdMicros['bafycid2']).toBeGreaterThan(0);
  });

  it('codex-code resolves hosted subscription auth from CODEX_HOME/auth.json', () => {
    const codexHome = join(home, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { refresh_token: 'refresh-token' },
    }));
    const codexWiring = [wiringEntry('bafycodex', 'codex-code-learner', 'gpt-5.4-mini')];

    const out = buildAiUnitsConfig(
      { executionWiring: codexWiring },
      { CODEX_HOME: codexHome },
      home,
    );

    expect(out?.manifestCredentials['bafycodex']).toBe('openai:subscription');
    expect(out?.manifestModels['bafycodex']).toBe('gpt-5.4-mini');
  });

  describe('buildAiUnitsConfig — USD fields (issue #1004)', () => {
    it('carries peg-derived USD caps and per-manifest USD projections alongside the unit fields', () => {
      // bafycid2 (claude-code) only resolves to a credential when ~/.claude/
      // is present on the isolated home — mirror the #901 test's setup.
      mkdirSync(join(home, '.claude'));
      const cfg = buildAiUnitsConfig({ executionWiring }, {}, home);
      expect(cfg).toBeDefined();
      // Unit caps retained for the legacy (SPA-facing) surface.
      expect(cfg!.capPerBlock).toBe(REFERENCE_CEILING.units_per_block);
      // USD caps derived from the same peg: 100 units => $0.50 => 500_000 micros.
      expect(cfg!.capPerBlockUsdMicros).toBe(500_000);
      expect(cfg!.capPerWeekUsdMicros).toBe(14_000_000);
      // Each priced paid-harness manifest gets a USD projection in micros.
      // bafycid2 = claude-code + claude-opus-4-7 (priced) => > 0.
      expect(cfg!.manifestProjectedUsdMicros['bafycid2']).toBeGreaterThan(0);
      // bafycid3 = prediction-v1-baseline (no LLM) => not resolved to a
      // credential, so it carries no projection entry at all.
      expect(cfg!.manifestProjectedUsdMicros['bafycid3']).toBeUndefined();
    });
  });
});
