/**
 * Unit tests for pure decode helpers in src/api/explorer.ts.
 *
 * `parsePluginCids` surfaces the plugin tarball `cid`s carried in an attempt
 * envelope's pluginsJson — the join key the /explorer/slice route uses to
 * resolve builder agentIds via the pluginPublication entity (#1050).
 * `parsePluginsJson` (which drops the cid and keeps name@version) already
 * ships; this file locks the cid variant.
 */
import { describe, it, expect } from 'vitest';
import { parsePluginCids } from '../src/api/explorer.js';

describe('parsePluginCids', () => {
  it('returns [] for null / malformed JSON', () => {
    expect(parsePluginCids(null)).toEqual([]);
    expect(parsePluginCids('not json')).toEqual([]);
    expect(parsePluginCids('{"not":"an array"}')).toEqual([]);
  });

  it('skips entries with no cid', () => {
    const raw = JSON.stringify([
      { name: '@a/x', version: '0.1', sha256: 'aa' },
      { name: '@b/y', version: '0.2', cid: 'cidY', sha256: 'bb' },
    ]);
    expect(parsePluginCids(raw)).toEqual(['cidY']);
  });

  it('returns every cid across entries', () => {
    const raw = JSON.stringify([
      { name: '@a/x', version: '0.1', cid: 'cidX', sha256: 'aa' },
      { name: '@b/y', version: '0.2', cid: 'cidY', sha256: 'bb' },
    ]);
    expect(parsePluginCids(raw).sort()).toEqual(['cidX', 'cidY']);
  });

  it('dedups duplicate cids', () => {
    const raw = JSON.stringify([
      { name: '@a/x', version: '0.1', cid: 'cidX', sha256: 'aa' },
      { name: '@a/x', version: '0.2', cid: 'cidX', sha256: 'cc' },
    ]);
    expect(parsePluginCids(raw)).toEqual(['cidX']);
  });
});
