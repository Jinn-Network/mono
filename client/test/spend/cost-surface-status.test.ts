import { describe, expect, it } from 'vitest';
import {
  buildCostSurfaceStatus,
  credentialUsesPaidApiKey,
} from '../../src/spend/cost-surface-status.js';

describe('credentialUsesPaidApiKey', () => {
  it('is true only for *:api-key credentials', () => {
    expect(credentialUsesPaidApiKey('anthropic:api-key')).toBe(true);
    expect(credentialUsesPaidApiKey('openai:api-key')).toBe(true);
    expect(credentialUsesPaidApiKey('hermes:api-key')).toBe(true);
    expect(credentialUsesPaidApiKey('anthropic:subscription')).toBe(false);
    expect(credentialUsesPaidApiKey('openai:subscription')).toBe(false);
    expect(credentialUsesPaidApiKey(null)).toBe(false);
  });
});

describe('buildCostSurfaceStatus', () => {
  it('marks claude-code paid when ANTHROPIC_API_KEY is set without OAuth', () => {
    const status = buildCostSurfaceStatus({
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    expect(status.harnesses['claude-code']).toEqual({
      credentialId: 'anthropic:api-key',
      usesPaidApiKey: true,
    });
  });

  it('marks claude-code subscription when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
    const status = buildCostSurfaceStatus({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    expect(status.harnesses['claude-code']?.usesPaidApiKey).toBe(false);
    expect(status.harnesses['claude-code']?.credentialId).toBe('anthropic:subscription');
  });

  it('marks codex paid when OPENAI_API_KEY is set', () => {
    const status = buildCostSurfaceStatus({ OPENAI_API_KEY: 'sk-test' });
    expect(status.harnesses['codex']?.usesPaidApiKey).toBe(true);
  });

  it('marks codex subscription when no OPENAI_API_KEY', () => {
    const status = buildCostSurfaceStatus({});
    expect(status.harnesses['codex']?.usesPaidApiKey).toBe(false);
    expect(status.harnesses['codex']?.credentialId).toBe('openai:subscription');
  });

  it('always marks hermes-agent paid (api-key provider)', () => {
    const status = buildCostSurfaceStatus({});
    expect(status.harnesses['hermes-agent']?.usesPaidApiKey).toBe(true);
    expect(status.harnesses['hermes-agent']?.credentialId).toMatch(/:api-key$/);
  });
});
