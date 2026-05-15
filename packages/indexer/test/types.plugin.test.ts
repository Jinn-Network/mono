import { describe, it, expect } from 'vitest';
import { parsePluginKey } from '../src/types.js';

describe('parsePluginKey (attd)', () => {
  it('returns { cid } for a well-formed plugin:<cid> key', () => {
    expect(parsePluginKey('plugin:bafyplugincid')).toEqual({ cid: 'bafyplugincid' });
  });

  it('returns null for an envelope:/evaluation:/capture: key', () => {
    expect(parsePluginKey('envelope:bafy...')).toBeNull();
    expect(parsePluginKey('evaluation:bafy...')).toBeNull();
    expect(parsePluginKey('capture:bafy...')).toBeNull();
  });

  it('returns null for a solvernet-manifest: key', () => {
    expect(parsePluginKey('solvernet-manifest:bafy...')).toBeNull();
  });

  it('returns null when the key is just "plugin:" (no cid)', () => {
    expect(parsePluginKey('plugin:')).toBeNull();
  });

  it('returns null for an unrelated key', () => {
    expect(parsePluginKey('agent-card:something')).toBeNull();
    expect(parsePluginKey('')).toBeNull();
  });
});
