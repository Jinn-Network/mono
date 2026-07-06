export interface Band { lo: number; hi: number; }

export function inContestedBand(passRate: number, band: Band): boolean {
  return passRate >= band.lo && passRate <= band.hi;
}

export interface BlindScreenFidelity {
  agentSha: string;
  emptyLoadout: boolean;
  noCorpusTools: boolean;
  /** Hash of the host skill directory at screen time. */
  hostSkillDirHash: string;
  /** The reference hash of an empty skill directory; hostSkillDirHash MUST equal this. */
  emptyHostSkillDirHash: string;
}

export class BlindScreenViolation extends Error {
  constructor(reason: string) {
    super(`blind-screen fidelity violated: ${reason}`);
    this.name = 'BlindScreenViolation';
  }
}

export function assertBlindScreen(f: BlindScreenFidelity): void {
  if (!f.emptyLoadout) throw new BlindScreenViolation('screening run did not have an empty skill loadout');
  if (!f.noCorpusTools) throw new BlindScreenViolation('screening run had a live corpus tool surface');
  if (f.hostSkillDirHash !== f.emptyHostSkillDirHash) {
    throw new BlindScreenViolation(`host skill dir was not empty (${f.hostSkillDirHash} != ${f.emptyHostSkillDirHash})`);
  }
}
