import { describe, expect, it } from 'vitest';
import { buildSpendCapConfig } from '../../src/spend/daemon-config.js';
import type { ExecutionWiringConfigEntry } from '../../src/config/shape-v2.js';

const executionWiring: ExecutionWiringConfigEntry[] = [
  {
    workKind: 'bafycid1',
    harness: 'claude-code',
    model: 'claude-haiku-4-5-20251001',
    plugins: [],
    credentialRef: 'claude-code-default',
    isolationPolicy: 'process',
  },
  {
    workKind: 'bafycid2',
    harness: 'hermes-agent',
    model: 'claude-haiku-4-5-20251001',
    plugins: [],
    credentialRef: 'hermes-agent-default',
    isolationPolicy: 'process',
  },
];

describe('buildSpendCapConfig', () => {
  it('returns undefined when no caps are configured', () => {
    expect(buildSpendCapConfig({ executionWiring, spendCaps: undefined }, {})).toBeUndefined();
  });

  it('maps participation keys to resolved credentials and applies explicit caps', () => {
    const out = buildSpendCapConfig(
      { executionWiring, spendCaps: { 'anthropic:api-key': 20 } },
      { ANTHROPIC_API_KEY: 'sk-ant-x' },
    );
    expect(out?.manifestCredentials['bafycid1']).toBe('anthropic:api-key');
    expect(out?.caps['anthropic:api-key']).toBe(20);
  });

  it('applies JINN_SPEND_CAP_USD as a blanket cap', () => {
    const out = buildSpendCapConfig(
      { executionWiring, spendCaps: undefined },
      { ANTHROPIC_API_KEY: 'sk-ant-x', JINN_HERMES_PROVIDER: 'openrouter', JINN_SPEND_CAP_USD: '15' },
    );
    expect(out?.caps['anthropic:api-key']).toBe(15);
    expect(out?.caps['openrouter:api-key']).toBe(15);
  });

  it('an explicit cap overrides the blanket for that credential', () => {
    const out = buildSpendCapConfig(
      { executionWiring, spendCaps: { 'anthropic:api-key': 50 } },
      { ANTHROPIC_API_KEY: 'sk-ant-x', JINN_HERMES_PROVIDER: 'openrouter', JINN_SPEND_CAP_USD: '15' },
    );
    expect(out?.caps['anthropic:api-key']).toBe(50);
    expect(out?.caps['openrouter:api-key']).toBe(15);
  });
});
