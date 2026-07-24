import { describe, it, expect } from 'vitest';
import { runThreeArm, type ArmName } from '../src/three-arm-run.js';
import type { ArmResult } from '../src/measurement.js';

function arm(n: number, passed: number): ArmResult[] {
  return Array.from({ length: n }, (_, i) => ({ instanceId: `inst-${i}`, passed: i < passed, unscorable: false, costUsd: 0.1 }));
}

describe('runThreeArm', () => {
  it('runs all three arms and feeds threeArmMeasurement (distilled dominates → ship-distilled)', async () => {
    const called: ArmName[] = [];
    const res = await runThreeArm({
      runArm: async (a) => {
        called.push(a);
        if (a === 'seedsOnly') return arm(12, 0);
        if (a === 'rawEvidence') return arm(12, 2);
        return arm(12, 10); // distilled
      },
    });
    expect(called.sort()).toEqual(['distilled', 'rawEvidence', 'seedsOnly']);
    expect(res.shipVerdict).toBe('ship-distilled');
    expect(res.pilot.powered).toBe(true);
  });

  it('runs arms sequentially by default (order preserved)', async () => {
    const order: ArmName[] = [];
    await runThreeArm({ runArm: async (a) => { order.push(a); return arm(4, 0); } });
    expect(order).toEqual(['seedsOnly', 'rawEvidence', 'distilled']);
  });

  it('propagates an inconclusive verdict from an underpowered run', async () => {
    const res = await runThreeArm({
      runArm: async (a) => (a === 'distilled' ? arm(4, 3) : arm(4, 0)),
    });
    expect(res.shipVerdict).toBe('inconclusive'); // <6 discordant pairs
  });
});
