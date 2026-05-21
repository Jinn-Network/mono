import { describe, expect, it } from 'vitest';
import { computeEffectivePlugins } from './effective-plugins.js';

describe('computeEffectivePlugins', () => {
  it('includes bundled defaults for Hermes (network-tools only, no learner)', () => {
    const out = computeEffectivePlugins({
      harness: 'hermes-agent',
      explicit: [],
      disabledDefaults: [],
    });
    const names = out.map((p) => p.name);
    expect(names).toContain('network-tools');
    expect(names).not.toContain('claude-code-learner');
  });

  it('includes both bundled defaults for non-Hermes harnesses', () => {
    const out = computeEffectivePlugins({
      harness: 'claude-code',
      explicit: [],
      disabledDefaults: [],
    });
    const names = out.map((p) => p.name);
    expect(names).toContain('network-tools');
    expect(names).toContain('claude-code-learner');
  });

  it('auto-includes catalog plugins in DEFAULT_COMPATIBLE_PLUGINS (swe-rebench-v2-runtime)', () => {
    const out = computeEffectivePlugins({
      harness: 'hermes-agent',
      explicit: [],
      disabledDefaults: [],
      catalogCompatible: [
        { name: 'swe-rebench-v2-runtime', version: '0.1.0', source: 'registry' },
      ],
    });
    const swe = out.find((p) => p.name === 'swe-rebench-v2-runtime');
    expect(swe).toBeTruthy();
    expect(swe?.defaultIncluded).toBe(true);
  });

  it('omits catalog plugins not in DEFAULT_COMPATIBLE_PLUGINS unless explicit', () => {
    const out = computeEffectivePlugins({
      harness: 'hermes-agent',
      explicit: [],
      disabledDefaults: [],
      catalogCompatible: [
        { name: 'some-optional-runtime', version: '0.1.0', source: 'registry' },
      ],
    });
    expect(out.find((p) => p.name === 'some-optional-runtime')).toBeUndefined();
  });

  it('includes catalog plugins added explicitly even when not default-on', () => {
    const out = computeEffectivePlugins({
      harness: 'hermes-agent',
      explicit: ['some-optional-runtime'],
      disabledDefaults: [],
      catalogCompatible: [
        { name: 'some-optional-runtime', version: '0.1.0', source: 'registry' },
      ],
    });
    const opt = out.find((p) => p.name === 'some-optional-runtime');
    expect(opt).toBeTruthy();
    expect(opt?.defaultIncluded).toBe(false);
  });

  it('excludes bundled defaults that the operator disabled', () => {
    const out = computeEffectivePlugins({
      harness: 'hermes-agent',
      explicit: [],
      disabledDefaults: ['bundled:network-tools'],
    });
    expect(out.find((p) => p.name === 'network-tools')).toBeUndefined();
  });

  it('handles the bundled: prefix in explicit + disabledDefaults consistently', () => {
    const out = computeEffectivePlugins({
      harness: 'hermes-agent',
      explicit: ['bundled:network-tools'],
      disabledDefaults: [],
    });
    // Should not double-render network-tools (once via bundled defaults,
    // again via explicit) — dedup by stripped name.
    const occurrences = out.filter((p) => p.name === 'network-tools');
    expect(occurrences).toHaveLength(1);
  });

  it('renders the SWE-rebench v2 default set correctly (Hermes + manifest)', () => {
    // This is the exact case the operator hit on the dashboard.
    const out = computeEffectivePlugins({
      harness: 'hermes-agent',
      explicit: [],
      disabledDefaults: [],
      catalogCompatible: [
        { name: 'network-tools', version: '0.1.0', source: 'bundled' },
        { name: 'swe-rebench-v2-runtime', version: '0.1.0', source: 'registry' },
      ],
    });
    const names = out.map((p) => p.name);
    expect(names).toEqual(['network-tools', 'swe-rebench-v2-runtime']);
    expect(out.every((p) => p.defaultIncluded)).toBe(true);
  });
});
