import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKER_MODEL, selectGeminiModelWithPolicy, isKnownValidModel, KNOWN_VALID_MODELS } from 'jinn-node/shared/gemini-models.js';

describe('selectGeminiModelWithPolicy', () => {
  it('falls back from experimental models to policy default', () => {
    const selection = selectGeminiModelWithPolicy(
      'gemini-2.5-pro-exp-v1',
      { defaultModel: 'gemini-3-flash', allowedModels: [] },
      DEFAULT_WORKER_MODEL,
    );

    expect(selection.selected).toBe('gemini-3-flash-preview');
    expect(selection.reason).toBe('policy_fallback');
  });

  it('enforces allowlist and falls back to default', () => {
    const selection = selectGeminiModelWithPolicy(
      'gemini-3-pro-preview',
      { defaultModel: 'gemini-3-flash', allowedModels: ['gemini-3-flash'] },
      DEFAULT_WORKER_MODEL,
    );

    expect(selection.selected).toBe('gemini-3-flash-preview');
    expect(selection.reason).toBe('policy_fallback');
  });

  it('accepts allowed model after normalization', () => {
    const selection = selectGeminiModelWithPolicy(
      'models/gemini-3-flash',
      { defaultModel: 'gemini-3-flash', allowedModels: ['gemini-3-flash'] },
      DEFAULT_WORKER_MODEL,
    );

    expect(selection.selected).toBe('gemini-3-flash-preview');
  });

  it('accepts known-valid model when no explicit policy', () => {
    const selection = selectGeminiModelWithPolicy(
      'gemini-2.5-pro',
      { defaultModel: 'gemini-3-flash', allowedModels: [] },
      DEFAULT_WORKER_MODEL,
    );

    expect(selection.selected).toBe('gemini-2.5-pro');
    expect(selection.reason).toBe('requested');
  });
});

describe('isKnownValidModel', () => {
  it('accepts canonical gemini-3-flash-preview', () => {
    expect(isKnownValidModel('gemini-3-flash-preview')).toBe(true);
  });

  it('accepts canonical gemini-3-pro-preview', () => {
    expect(isKnownValidModel('gemini-3-pro-preview')).toBe(true);
  });

  it('accepts gemini-2.5-pro', () => {
    expect(isKnownValidModel('gemini-2.5-pro')).toBe(true);
  });

  it('accepts gemini-2.5-flash', () => {
    expect(isKnownValidModel('gemini-2.5-flash')).toBe(true);
  });

  it('rejects hallucinated model variant', () => {
    expect(isKnownValidModel('gemini-2.5-pro-v1-0-preview-01-26')).toBe(false);
  });

  it('rejects non-canonical alias (must normalize first)', () => {
    expect(isKnownValidModel('gemini-3-flash')).toBe(false);
  });

  it('KNOWN_VALID_MODELS is non-empty', () => {
    expect(KNOWN_VALID_MODELS.size).toBeGreaterThan(0);
  });
});
