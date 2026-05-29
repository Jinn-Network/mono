/**
 * buildAiUnitsConfig — assembles the daemon's AI-units gate config from
 * operator config (joinedSolverNets — gives us the model per manifest)
 * + env (override + provider credentials). Returns undefined only when
 * nothing maps to a known credential at all; otherwise the gate always
 * runs (the ceiling is hard-coded, not opt-in).
 */
import { describe, expect, it } from 'vitest';
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
  it('returns undefined when no joined SolverNets resolve to a credential', () => {
    const noLlmJoined = {
      bafycid3: { manifestCid: 'bafycid3', name: 'net-3', roles: ['solver'], harness: 'prediction-v1-baseline', plugins: [] },
    } as never;
    expect(
      buildAiUnitsConfig({ joinedSolverNets: noLlmJoined }, {}),
    ).toBeUndefined();
  });

  it('maps each manifest CID to its credential + projected per-task AI units', () => {
    const out = buildAiUnitsConfig({ joinedSolverNets: joined }, {});
    // bafycid1 — hermes-agent → "hermes:api-key" (default provider)
    expect(out?.manifestCredentials['bafycid1']).toBe('hermes:api-key');
    // bafycid2 — claude-code subscription path → still resolves but null because no env
    // Actually: resolveCredentialId('claude-code', {}) → null (no token, no key).
    expect(out?.manifestCredentials['bafycid2']).toBeUndefined();
    expect(out?.manifestCredentials['bafycid3']).toBeUndefined();
    // Per-manifest projected units for the priced model
    expect(out?.manifestProjectedAiUnits['bafycid1']).toBeGreaterThan(0);
    expect(out?.manifestModels['bafycid1']).toBe('anthropic/claude-opus-4.7');
  });

  it('applies the baked-in REFERENCE_CEILING by default', () => {
    const out = buildAiUnitsConfig({ joinedSolverNets: joined }, {});
    expect(out?.capPerBlock).toBe(REFERENCE_CEILING.units_per_block);
    expect(out?.capPerWeek).toBe(REFERENCE_CEILING.units_per_week);
  });

  it('honours JINN_AI_UNITS_CEILING_OVERRIDE', () => {
    const out = buildAiUnitsConfig(
      { joinedSolverNets: joined },
      { JINN_AI_UNITS_CEILING_OVERRIDE: '10' },
    );
    expect(out?.capPerBlock).toBe(10);
    expect(out?.capPerWeek).toBe(280);
  });
});
