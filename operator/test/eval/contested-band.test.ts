import { describe, it, expect } from 'vitest';
import {
  inContestedBand, assertBlindScreen, BlindScreenViolation, type BlindScreenFidelity,
} from '../../src/eval/contested-band.js';

const band = { lo: 0.15, hi: 0.85 };
const cleanFidelity: BlindScreenFidelity = {
  agentSha: 'abc', emptyLoadout: true, noCorpusTools: true, hostSkillDirHash: 'sha256:e3b0c442...',
  emptyHostSkillDirHash: 'sha256:e3b0c442...',
};

describe('contested band', () => {
  it('includes rates inside [lo, hi] inclusive', () => {
    expect(inContestedBand(0.15, band)).toBe(true);
    expect(inContestedBand(0.5, band)).toBe(true);
    expect(inContestedBand(0.85, band)).toBe(true);
  });
  it('excludes saturated / hopeless rates', () => {
    expect(inContestedBand(0.0, band)).toBe(false);
    expect(inContestedBand(1.0, band)).toBe(false);
    expect(inContestedBand(0.14, band)).toBe(false);
  });
  it('passes a blind screen with empty loadout + matching empty host dir hash', () => {
    expect(() => assertBlindScreen(cleanFidelity)).not.toThrow();
  });
  it('throws when the loadout was not empty', () => {
    expect(() => assertBlindScreen({ ...cleanFidelity, emptyLoadout: false })).toThrow(BlindScreenViolation);
  });
  it('throws when the host skill dir hash does not match the empty-dir hash', () => {
    expect(() => assertBlindScreen({ ...cleanFidelity, hostSkillDirHash: 'sha256:nonempty' })).toThrow(BlindScreenViolation);
  });
  it('throws when corpus tools were available during the screen', () => {
    expect(() => assertBlindScreen({ ...cleanFidelity, noCorpusTools: false })).toThrow(BlindScreenViolation);
  });
});
