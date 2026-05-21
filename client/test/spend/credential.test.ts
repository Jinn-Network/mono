import { describe, expect, it } from 'vitest';
import { resolveCredentialId } from '../../src/spend/credential.js';

describe('resolveCredentialId', () => {
  it('claude-code with an OAuth token is a subscription', () => {
    expect(resolveCredentialId('claude-code', { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }))
      .toBe('anthropic:subscription');
  });

  it('claude-code with only an API key is a paid key', () => {
    expect(resolveCredentialId('claude-code', { ANTHROPIC_API_KEY: 'sk-ant-x' }))
      .toBe('anthropic:api-key');
  });

  it('claude-code prefers the OAuth token when both are set', () => {
    expect(resolveCredentialId('claude-code', { CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }))
      .toBe('anthropic:subscription');
  });

  it('codex with an API key is a paid key', () => {
    expect(resolveCredentialId('codex', { OPENAI_API_KEY: 'sk-x' })).toBe('openai:api-key');
  });

  it('codex with no API key is a subscription', () => {
    expect(resolveCredentialId('codex', {})).toBe('openai:subscription');
  });

  it('hermes-agent keys on the configured provider', () => {
    expect(resolveCredentialId('hermes-agent', { JINN_HERMES_PROVIDER: 'openrouter' }))
      .toBe('openrouter:api-key');
  });

  it('returns null for a harness with no LLM credential', () => {
    expect(resolveCredentialId('prediction-v1-baseline', {})).toBeNull();
    expect(resolveCredentialId(undefined, {})).toBeNull();
  });
});
