import { describe, it, expect } from 'vitest';
import {
  threeArmMeasurement,
  pilotPower,
  type ArmResult,
} from '../src/measurement.js';

/** Build an arm: `n` instances, the first `passed` of them pass. costUsd uniform. */
function arm(n: number, passed: number, costUsd = 0.1): ArmResult[] {
  return Array.from({ length: n }, (_, i) => ({
    instanceId: `inst-${i}`,
    passed: i < passed,
    unscorable: false,
    costUsd,
  }));
}

describe('pilotPower', () => {
  it('needs ≥6 discordant pairs (all-improve) to be significant at α=0.05', () => {
    expect(pilotPower(5, 0).powered).toBe(false); // 5 discordant → best-case p=0.0625
    expect(pilotPower(6, 0).powered).toBe(true); // 6 → p=0.031
    expect(pilotPower(6, 0).minDiscordantForSignificance).toBe(6);
  });
  it('counts total discordant, not net', () => {
    expect(pilotPower(4, 4).discordant).toBe(8);
    expect(pilotPower(4, 4).powered).toBe(true);
  });
});

describe('threeArmMeasurement (§11 gate + D9/D11)', () => {
  it('ships distilled when it beats BOTH seeds and raw-evidence, powered, cost non-inferior', () => {
    // seeds: 0/12 pass; raw: 2/12; distilled: 10/12 → distilled >> both, many improvements.
    const seeds = arm(12, 0);
    const raw = arm(12, 2);
    const distilled = arm(12, 10);
    const r = threeArmMeasurement({ seedsOnly: seeds, rawEvidence: raw, distilled });
    expect(r.distilledVsSeeds.capabilityPass).toBe(true);
    expect(r.distilledVsRaw.bitterLessonPass).toBe(true);
    expect(r.pilot.powered).toBe(true);
    expect(r.shipVerdict).toBe('ship-distilled');
  });

  it('ships the retrieval baseline when raw-evidence matches/beats distilled (D9/D11)', () => {
    // distilled beats seeds, but raw-evidence is just as good as distilled (no improvement over raw).
    const seeds = arm(12, 0);
    const distilled = arm(12, 10);
    const raw = arm(12, 10); // identical to distilled → distilled does not beat raw
    const r = threeArmMeasurement({ seedsOnly: seeds, rawEvidence: raw, distilled });
    expect(r.distilledVsSeeds.capabilityPass).toBe(true);
    expect(r.distilledVsRaw.bitterLessonPass).toBe(false);
    expect(r.shipVerdict).toBe('ship-retrieval-baseline');
  });

  it('is inconclusive when underpowered (too few discordant pairs)', () => {
    const seeds = arm(4, 0);
    const raw = arm(4, 0);
    const distilled = arm(4, 3); // only 3 improvements vs seeds → discordant < 6
    const r = threeArmMeasurement({ seedsOnly: seeds, rawEvidence: raw, distilled });
    expect(r.pilot.powered).toBe(false);
    expect(r.shipVerdict).toBe('inconclusive');
  });

  it('withholds ship-distilled when distilled costs materially more than seeds (cost guard)', () => {
    // seeds solve 0-5 (cost 0.1); distilled solves all 12 at 4× the cost.
    // improvements = 6 (instances 6-11) → powered & trustworthy; both-solve set = 0-5,
    // where distilled is 4× more expensive → cost guard fails.
    const seeds = arm(12, 6, 0.1);
    const raw = arm(12, 2, 0.1);
    const distilled = arm(12, 12, 0.4);
    const r = threeArmMeasurement({ seedsOnly: seeds, rawEvidence: raw, distilled }, { costMargin: 0.1 });
    expect(r.pilot.powered).toBe(true);
    expect(r.distilledVsSeeds.paired.verdict).toBe('trustworthy');
    expect(r.distilledVsSeeds.costNonInferior).toBe(false);
    expect(r.distilledVsSeeds.capabilityPass).toBe(false);
    expect(r.shipVerdict).not.toBe('ship-distilled');
  });

  it('skips the cost guard (ratio=null, non-inferior but UNVERIFIED) when no both-solve instance carries cost data', () => {
    const noCost = (n: number, passed: number): ArmResult[] =>
      Array.from({ length: n }, (_, i) => ({ instanceId: `inst-${i}`, passed: i < passed, unscorable: false }));
    const seeds = noCost(12, 6);      // both-solve set (0-5) exists, but no costUsd anywhere
    const raw = noCost(12, 2);
    const distilled = noCost(12, 12);
    const r = threeArmMeasurement({ seedsOnly: seeds, rawEvidence: raw, distilled });
    expect(r.distilledVsSeeds.costRatio).toBeNull(); // no basis
    expect(r.distilledVsSeeds.costNonInferior).toBe(true); // guard skipped (cost unverified, not verified-cheap)
    expect(r.shipVerdict).toBe('ship-distilled'); // powered + beats both; cost unverified is not blocking
  });

  it('FAILS the cost guard when the baseline is free but distilled is paid on the both-solve set (no fail-open)', () => {
    const seeds = arm(12, 6, 0);        // solves 0-5 for free
    const raw = arm(12, 2, 0.1);
    const distilled = arm(12, 12, 0.2); // solves all, paid
    const r = threeArmMeasurement({ seedsOnly: seeds, rawEvidence: raw, distilled }, { costMargin: 0.1 });
    expect(r.distilledVsSeeds.costRatio).toBe(Infinity); // free baseline + paid treatment = infinitely worse
    expect(r.distilledVsSeeds.costNonInferior).toBe(false);
    expect(r.distilledVsSeeds.capabilityPass).toBe(false);
    expect(r.shipVerdict).not.toBe('ship-distilled');
  });
});
