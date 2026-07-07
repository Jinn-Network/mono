/**
 * buildAiUnitsConfig — assembles the daemon's AI-units gate config from
 * operator config (joinedSolverNets — gives us the model per manifest)
 * + env (override + provider credentials). Returns undefined only when
 * nothing maps to a known credential at all; otherwise the gate always
 * runs (the ceiling is hard-coded, not opt-in).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAiUnitsConfig } from '../../src/spend/ai-units-config.js';
import { REFERENCE_CEILING } from '../../src/spend/ai-units.js';

const joined = {
  bafycid1: {
    manifestCid: 'bafycid1',
    name: 'net-1',
    roles: ['solver'],
    harness: 'hermes-agent',
    plugins: [],
    model: 'anthropic/claude-opus-4.7',
  },
  bafycid2: {
    manifestCid: 'bafycid2',
    name: 'net-2',
    roles: ['solver'],
    harness: 'claude-code',
    plugins: [],
    model: 'claude-opus-4-7',
  },
  bafycid3: {
    manifestCid: 'bafycid3',
    name: 'net-3',
    roles: ['solver'],
    harness: 'prediction-v1-baseline',
    plugins: [],
  },
} as never;

describe('buildAiUnitsConfig', () => {
  let home: string;

  beforeEach(() => {
    // Empty home isolates tests from the dev machine's real `~/.claude`.
    home = mkdtempSync(join(tmpdir(), 'aiunits-cfg-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns undefined when no joined SolverNets resolve to a credential', () => {
    const noLlmJoined = {
      bafycid3: { manifestCid: 'bafycid3', name: 'net-3', roles: ['solver'], harness: 'prediction-v1-baseline', plugins: [] },
    } as never;
    expect(
      buildAiUnitsConfig({ joinedSolverNets: noLlmJoined }, {}, home),
    ).toBeUndefined();
  });

  it('maps each manifest CID to its credential + projected per-task AI units', () => {
    const out = buildAiUnitsConfig({ joinedSolverNets: joined }, {}, home);
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
    const out = buildAiUnitsConfig({ joinedSolverNets: joined }, {}, home);
    expect(out?.capPerBlock).toBe(REFERENCE_CEILING.units_per_block);
    expect(out?.capPerWeek).toBe(REFERENCE_CEILING.units_per_week);
  });

  it('honours JINN_AI_UNITS_CEILING_OVERRIDE', () => {
    const out = buildAiUnitsConfig(
      { joinedSolverNets: joined },
      { JINN_AI_UNITS_CEILING_OVERRIDE: '10' },
      home,
    );
    expect(out?.capPerBlock).toBe(10);
    expect(out?.capPerWeek).toBe(280);
  });

  it('claude-code on a stock subscription install (~/.claude/ present, no env) projects model cost (#901)', () => {
    mkdirSync(join(home, '.claude'));
    const out = buildAiUnitsConfig({ joinedSolverNets: joined }, {}, home);
    expect(out?.manifestCredentials['bafycid2']).toBe('anthropic:subscription');
    // Opus 4.7 projects ~450 units/task at the GPT-5.4-mini peg.
    expect(out?.manifestProjectedAiUnits['bafycid2']).toBeGreaterThan(100);
  });

  describe('buildAiUnitsConfig — USD fields (issue #1004)', () => {
    it('carries peg-derived USD caps and per-manifest USD projections alongside the unit fields', () => {
      // bafycid2 (claude-code) only resolves to a credential when ~/.claude/
      // is present on the isolated home — mirror the #901 test's setup.
      mkdirSync(join(home, '.claude'));
      const cfg = buildAiUnitsConfig({ joinedSolverNets: joined }, {}, home);
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
