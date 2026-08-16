// operator/test/harnesses/provider-ref.test.ts
import { describe, expect, it } from 'vitest';
import {
  providerRefName,
  providerRefBaseUrl,
  providerRefAuthVar,
  type ProviderRef,
} from '../../src/harnesses/provider-ref.js';

describe('provider-ref accessors', () => {
  it('string form → name only, no baseUrl/authVar', () => {
    const ref: ProviderRef = 'openrouter';
    expect(providerRefName(ref)).toBe('openrouter');
    expect(providerRefBaseUrl(ref)).toBeUndefined();
    expect(providerRefAuthVar(ref)).toBeUndefined();
  });

  it('object form → name + optional baseUrl + optional authVar', () => {
    const ref: ProviderRef = {
      name: 'my-endpoint',
      baseUrl: 'http://127.0.0.1:11434/v1',
      authVar: 'MY_ENDPOINT_KEY',
    };
    expect(providerRefName(ref)).toBe('my-endpoint');
    expect(providerRefBaseUrl(ref)).toBe('http://127.0.0.1:11434/v1');
    expect(providerRefAuthVar(ref)).toBe('MY_ENDPOINT_KEY');
  });

  it('object form with only name → name, undefined extras', () => {
    const ref: ProviderRef = { name: 'anthropic' };
    expect(providerRefName(ref)).toBe('anthropic');
    expect(providerRefBaseUrl(ref)).toBeUndefined();
    expect(providerRefAuthVar(ref)).toBeUndefined();
  });

  it('undefined → all undefined', () => {
    expect(providerRefName(undefined)).toBeUndefined();
    expect(providerRefBaseUrl(undefined)).toBeUndefined();
    expect(providerRefAuthVar(undefined)).toBeUndefined();
  });
});
