import { describe, expect, it } from 'vitest';
import {
  listWiringIntent,
  postingWiringIntent,
  showWiringIntent,
  type WiringIntentInput,
} from '../../src/intents/wiring.js';

const input: WiringIntentInput = {
  executionWiring: [
    {
      workKind: 'repository-work',
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      plugins: [],
      credentialRef: 'default',
      isolationPolicy: 'worktree',
      legacyManifestDigest: '0xaa',
    },
  ],
  posting: [
    {
      workKind: 'repository-work',
      launchedRecordPath: '/records/net-a.json',
      generatorEnabled: true,
      legacyManifestDigest: '0xaa',
    },
  ],
};

describe('wiring intents (intent-module law)', () => {
  it('lists execution wiring entries with their bridge annotation', () => {
    const result = listWiringIntent(input);
    expect(result.verb).toBe('wiring list');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.legacyManifestDigest).toBe('0xaa');
  });

  it('shows one entry by work kind', () => {
    const shown = showWiringIntent(input, 'repository-work');
    expect(shown.found).toBe(true);
    if (shown.found) {
      expect(shown.entry.harness).toBe('claude-code');
      expect(shown.verb).toBe('wiring show');
    }
  });

  it('returns a discriminated not-found for an unknown work kind (no throw, no exit)', () => {
    const shown = showWiringIntent(input, 'nope');
    expect(shown.found).toBe(false);
    if (!shown.found) expect(shown.workKind).toBe('nope');
  });

  it('lists posting entries', () => {
    const result = postingWiringIntent(input);
    expect(result.verb).toBe('wiring posting');
    expect(result.posting[0]!.workKind).toBe('repository-work');
    expect(result.posting[0]!.generatorEnabled).toBe(true);
  });

  it('handles empty config slices', () => {
    const empty: WiringIntentInput = { executionWiring: [], posting: [] };
    expect(listWiringIntent(empty).entries).toEqual([]);
    expect(postingWiringIntent(empty).posting).toEqual([]);
    expect(showWiringIntent(empty, 'x').found).toBe(false);
  });
});
