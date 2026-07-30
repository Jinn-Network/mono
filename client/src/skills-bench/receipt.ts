import { comparePaired, type PairedComparison, type PairedInput } from '../eval/paired.js';
import { wilsonInterval } from '../eval/wilson.js';
import type { BenchOutcome } from './attempts.js';

export interface ReceiptProfile {
  model: string;
  agent: string;
  slateSha256: string;
  slateHalf: 'feedback' | 'holdout' | 'both';
  measuredOn: string;
  forkedFrom?: string;
  /** sha256 of the measured skill's vendored bytes (manifest arms[].skillSha256) —
   *  identifies exactly which version of the skill this receipt measured. */
  skillSha256?: string;
  /** pinned upstream provenance, e.g. `owner/repo@sha` (pin.json's source@commit). */
  skillSource?: string;
}

export interface ArmSummary { passed: number; scorable: number; lo: number; hi: number }

export interface ReceiptData {
  profile: ReceiptProfile;
  baselineArm: string;
  treatmentArm: string;
  n: number;
  excluded: number;
  baseline: ArmSummary;
  treatment: ArmSummary;
  paired: PairedComparison;
  meanCostUsd: { baseline: number; treatment: number };
}

/** The paired unit is (instanceId, repeat), not instanceId alone — with
 *  `--repeats > 1` each repeat is an independent trial and must stay a
 *  distinct pair, or comparePaired's per-instance Map collapses repeats
 *  (keeping only the last) while a naive instance-count would still count
 *  every repeat, making `n`/`excluded` and improved/regressed disagree. */
function pairId(o: BenchOutcome): string {
  return `${o.instanceId}#r${o.repeat}`;
}

function armInputs(outcomes: BenchOutcome[], arm: string): PairedInput[] {
  return outcomes
    .filter((o) => o.arm === arm)
    .map((o) => ({ instance_id: pairId(o), passed: o.passed, unscorable: o.unscorable }));
}

function summarize(outcomes: BenchOutcome[], arm: string, pairedIds: Set<string>): ArmSummary {
  const scored = outcomes.filter((o) => o.arm === arm && pairedIds.has(pairId(o)) && o.passed !== null);
  const passed = scored.filter((o) => o.passed === true).length;
  const { lo, hi } = wilsonInterval(passed, scored.length);
  return { passed, scorable: scored.length, lo, hi };
}

function meanCost(outcomes: BenchOutcome[], arm: string): number {
  const xs = outcomes.filter((o) => o.arm === arm);
  return xs.length ? xs.reduce((s, o) => s + o.costUsd, 0) / xs.length : 0;
}

export function buildReceipt(
  outcomes: BenchOutcome[],
  opts: { baselineArm: string; treatmentArm: string; profile: ReceiptProfile },
): ReceiptData {
  const base = armInputs(outcomes, opts.baselineArm);
  const treat = armInputs(outcomes, opts.treatmentArm);
  const paired = comparePaired(base, treat, {});
  // A pair counts only when BOTH arms scored (matches comparePaired's exclusion rule).
  const baseById = new Map(base.map((i) => [i.instance_id, i]));
  const pairedIds = new Set(
    treat.filter((t) => {
      const b = baseById.get(t.instance_id);
      return b && b.passed !== null && t.passed !== null;
    }).map((t) => t.instance_id),
  );
  const allIds = new Set([...base, ...treat].map((i) => i.instance_id));
  return {
    profile: opts.profile,
    baselineArm: opts.baselineArm,
    treatmentArm: opts.treatmentArm,
    n: pairedIds.size,
    excluded: allIds.size - pairedIds.size,
    baseline: summarize(outcomes, opts.baselineArm, pairedIds),
    treatment: summarize(outcomes, opts.treatmentArm, pairedIds),
    paired,
    meanCostUsd: {
      baseline: meanCost(outcomes, opts.baselineArm),
      treatment: meanCost(outcomes, opts.treatmentArm),
    },
  };
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;

export function renderReceiptMd(d: ReceiptData): string {
  const p = d.profile;
  const delta = d.treatment.passed - d.baseline.passed;
  return [
    '```',
    `skill:      ${d.treatmentArm}${p.forkedFrom ? `, forked from ${p.forkedFrom}` : ''}`,
    `measured:   ${d.n} paired tasks (${p.slateHalf} slate), ${d.excluded} excluded as ungradeable`,
    `agent:      ${p.agent}, ${p.model}, one pinned configuration`,
    `result:     baseline resolved ${d.baseline.passed}/${d.baseline.scorable} ` +
      `(95% Wilson ${pct(d.baseline.lo)}–${pct(d.baseline.hi)})`,
    `            with skill resolved ${d.treatment.passed}/${d.treatment.scorable} ` +
      `(95% Wilson ${pct(d.treatment.lo)}–${pct(d.treatment.hi)})`,
    `            net ${delta >= 0 ? '+' : ''}${delta} tasks ` +
      `(improved ${d.paired.improved}, regressed ${d.paired.regressed})`,
    `cost:       mean per task — baseline $${d.meanCostUsd.baseline.toFixed(2)}, ` +
      `with skill $${d.meanCostUsd.treatment.toFixed(2)} (reported, never gates)`,
    `scope:      one agent configuration, one benchmark, this task list`,
    `            slate sha256: ${p.slateSha256} · measured ${p.measuredOn}`,
    ...(p.skillSha256
      ? [`            skill bytes: sha256 ${p.skillSha256}${p.skillSource ? ` · source ${p.skillSource}` : ''}`]
      : []),
    `files:      per-task outcomes, run manifests, full agent transcripts, rerun script`,
    '```',
    '',
    `This is a small paired sample; the intervals above are wide by construction and`,
    `no claim of a real effect is made. Reproduce it from the pinned slate and rig (see files).`,
    '',
  ].join('\n');
}
