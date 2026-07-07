/**
 * Three-arm measurement runner (spec/2026-07-06-distillation-v1.md §11).
 *
 * Orchestrates the §11 run: for each arm — seeds-only (control), raw-evidence
 * (the D11 product baseline), distilled — run the held-out slate under that
 * arm's pre-installed corpus snapshot, collect per-instance pass/fail + cost,
 * then hand all three to `threeArmMeasurement` for the gate + pilot verdict.
 *
 * The per-arm RUN is an injected port (`runArm`). Its production implementation
 * is the **capability-eval rig (#1416)** — pre-install a content-addressed corpus
 * snapshot, run the swe-rebench-v2 slate under it, grade in Docker. That rig is a
 * follow-on; keeping it a port means this orchestration is correct and tested now
 * and the real runner drops in unchanged. Arms run **sequentially by default** to
 * bound disk/inference; each is expensive.
 */

import { threeArmMeasurement, type ArmResult, type ThreeArmResult } from './measurement.js';

export type ArmName = 'seedsOnly' | 'rawEvidence' | 'distilled';

export interface ThreeArmRunDeps {
  /** Run the held-out slate under an arm's pre-installed loadout → per-instance results. */
  runArm: (arm: ArmName) => Promise<ArmResult[]>;
  alpha?: number;
  costMargin?: number;
  /** Run arms concurrently (default false — arms are disk/inference-heavy, so serialize). */
  parallel?: boolean;
  log?: (msg: string) => void;
}

const ARMS: ArmName[] = ['seedsOnly', 'rawEvidence', 'distilled'];

export async function runThreeArm(deps: ThreeArmRunDeps): Promise<ThreeArmResult> {
  const log = deps.log ?? (() => {});
  let seedsOnly: ArmResult[];
  let rawEvidence: ArmResult[];
  let distilled: ArmResult[];

  if (deps.parallel) {
    log('running three arms concurrently');
    [seedsOnly, rawEvidence, distilled] = await Promise.all(ARMS.map((a) => deps.runArm(a)));
  } else {
    const out: Partial<Record<ArmName, ArmResult[]>> = {};
    for (const arm of ARMS) {
      log(`running arm: ${arm}`);
      out[arm] = await deps.runArm(arm);
    }
    seedsOnly = out.seedsOnly!;
    rawEvidence = out.rawEvidence!;
    distilled = out.distilled!;
  }

  return threeArmMeasurement(
    { seedsOnly, rawEvidence, distilled },
    {
      ...(deps.alpha !== undefined ? { alpha: deps.alpha } : {}),
      ...(deps.costMargin !== undefined ? { costMargin: deps.costMargin } : {}),
    },
  );
}
