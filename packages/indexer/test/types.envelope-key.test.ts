import { describe, it, expect } from 'vitest';
import { parseEnvelopeKey } from '../src/types.js';

describe('parseEnvelopeKey', () => {
  it('parses the three original envelope kinds', () => {
    expect(parseEnvelopeKey('envelope:bafyA')).toEqual({ kind: 'envelope', cid: 'bafyA' });
    expect(parseEnvelopeKey('evaluation:bafyB')).toEqual({ kind: 'evaluation', cid: 'bafyB' });
    expect(parseEnvelopeKey('capture:bafyC')).toEqual({ kind: 'capture', cid: 'bafyC' });
  });

  it('parses skill:<cid> (jinn.skill.v1 layer-2 consumable) so skills are indexed + discoverable', () => {
    expect(parseEnvelopeKey('skill:bafySkill')).toEqual({ kind: 'skill', cid: 'bafySkill' });
  });

  it('rejects unknown prefixes and malformed keys', () => {
    expect(parseEnvelopeKey('plugin:bafy')).toBeNull();
    expect(parseEnvelopeKey('solvernet-manifest:bafy')).toBeNull();
    expect(parseEnvelopeKey('skill:')).toBeNull(); // empty cid
    expect(parseEnvelopeKey(':bafy')).toBeNull(); // empty kind
    expect(parseEnvelopeKey('nocolon')).toBeNull();
  });
});
