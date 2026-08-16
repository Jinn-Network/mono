import { describe, expect, it } from 'vitest';
import { HERMES_MODELS, providerForModel } from './claudeModels.js';
import { providerRefName } from '../../../../../harnesses/provider-ref.js';
import { HERMES_AGENT_HARNESS } from './harnessNames.js';

describe('HERMES_MODELS provider route (issue #1243)', () => {
  // Acceptance #4: prevent shipping a Hermes catalog entry with no provider
  // route. Every surfaced Hermes model must declare a provider so the adapter
  // routes it first-class instead of relying on id-shape inference.
  it('every HERMES_MODELS entry declares a provider', () => {
    for (const entry of HERMES_MODELS) {
      expect(
        entry.provider,
        `HERMES_MODELS entry ${entry.id} is missing a provider route`,
      ).toBeDefined();
      expect(providerRefName(entry.provider)).toBeTruthy();
    }
  });

  it('providerForModel resolves the catalog entry provider under the hermes harness', () => {
    expect(
      providerRefName(providerForModel('anthropic/claude-opus-4.7', HERMES_AGENT_HARNESS)),
    ).toBe('openrouter');
  });

  it('providerForModel returns undefined for an unknown id', () => {
    expect(providerForModel('does/not-exist', HERMES_AGENT_HARNESS)).toBeUndefined();
  });
});
