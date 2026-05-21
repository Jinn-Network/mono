import { describe, expect, it } from 'vitest';
import { buildSpendCapConfig } from '../../src/spend/daemon-config.js';

const joined = {
  bafycid1: { manifestCid: 'bafycid1', roles: ['solver'], harness: 'claude-code', plugins: [] },
  bafycid2: { manifestCid: 'bafycid2', roles: ['solver'], harness: 'hermes-agent', plugins: [] },
} as never;

describe('buildSpendCapConfig', () => {
  it('returns undefined when no caps are configured', () => {
    expect(buildSpendCapConfig({ joinedSolverNets: joined, spendCaps: undefined }, {})).toBeUndefined();
  });

  it('maps manifest cids to resolved credentials and applies explicit caps', () => {
    const out = buildSpendCapConfig(
      { joinedSolverNets: joined, spendCaps: { 'anthropic:api-key': 20 } },
      { ANTHROPIC_API_KEY: 'sk-ant-x' },
    );
    expect(out?.manifestCredentials['bafycid1']).toBe('anthropic:api-key');
    expect(out?.caps['anthropic:api-key']).toBe(20);
  });

  it('applies JINN_SPEND_CAP_USD as a blanket cap', () => {
    const out = buildSpendCapConfig(
      { joinedSolverNets: joined, spendCaps: undefined },
      { ANTHROPIC_API_KEY: 'sk-ant-x', JINN_HERMES_PROVIDER: 'openrouter', JINN_SPEND_CAP_USD: '15' },
    );
    expect(out?.caps['anthropic:api-key']).toBe(15);
    expect(out?.caps['openrouter:api-key']).toBe(15);
  });

  it('an explicit cap overrides the blanket for that credential', () => {
    const out = buildSpendCapConfig(
      { joinedSolverNets: joined, spendCaps: { 'anthropic:api-key': 50 } },
      { ANTHROPIC_API_KEY: 'sk-ant-x', JINN_HERMES_PROVIDER: 'openrouter', JINN_SPEND_CAP_USD: '15' },
    );
    expect(out?.caps['anthropic:api-key']).toBe(50);
    expect(out?.caps['openrouter:api-key']).toBe(15);
  });
});
