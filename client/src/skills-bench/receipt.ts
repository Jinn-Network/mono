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
  /** I1: which kind of pinned collection `slateSha256`/`slateHalf` actually
   *  identifies. Defaults to `'slate'` for back-compat (every caller before
   *  this field existed was rendering a `SkillsBenchSlate` receipt). A
   *  `--task-set` report (capability-report.ts) reuses `slateSha256` for the
   *  task set's own sha256 and `slateHalf` for the manifest's fixed
   *  `'feedback'` value (see capability-report.ts's module doc) — those
   *  fields are correctly reused, but the reader-facing strings must not
   *  call a task set a "slate". Set by the render layer
   *  (render-report.ts/render-receipts.ts) from which manifest fields are
   *  present; never inferred here. */
  identityKind?: 'slate' | 'task-set';
}

export interface ArmSummary { passed: number; scorable: number; lo: number; hi: number }

/** Per-arm trigger rate — did the mounted skill actually load during a
 *  solve, measured from session-JSONL evidence (trigger.ts), never from
 *  model self-report. `unknown` counts attempts whose session JSONL could
 *  not be located/read (see run-bench.ts's `sessionCaptured` flag) — these
 *  are never folded into `triggered` or into `total`'s "not triggered"
 *  complement; they are reported separately so a receipt reader can see
 *  exactly how much of the sample the rate is actually based on. */
export interface TriggerRate { triggered: number; total: number; unknown: number }

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
  /** Treatment-arm trigger rate only (spec §"trigger rate as a first-class
   *  receipt field") — absent when the caller has no session-JSONL data to
   *  compute it from (e.g. a --dry-run receipt). */
  triggerRate?: TriggerRate;
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

/** Aggregates per-attempt trigger results (one entry per solved+failed
 *  treatment-arm attempt) into the receipt's TriggerRate. `triggered: null`
 *  means the attempt's session JSONL was missing/unreadable — counted as
 *  `unknown`, never folded into `triggered` or the implicit "not
 *  triggered" complement. Pure — the caller (render-receipts.ts) does the
 *  filesystem/parsing work via trigger.ts and passes results in. */
export function summarizeTriggerRate(results: Array<{ triggered: boolean | null }>): TriggerRate {
  let triggered = 0;
  let total = 0;
  let unknown = 0;
  for (const r of results) {
    if (r.triggered === null) { unknown++; continue; }
    total++;
    if (r.triggered) triggered++;
  }
  return { triggered, total, unknown };
}

export function buildReceipt(
  outcomes: BenchOutcome[],
  opts: { baselineArm: string; treatmentArm: string; profile: ReceiptProfile; triggerRate?: TriggerRate },
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
    ...(opts.triggerRate ? { triggerRate: opts.triggerRate } : {}),
  };
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;

/** Null-result honesty rule (spec §"a null result with a low trigger rate
 *  must render as 'not exercised on this task set', never as 'no effect'"),
 *  I5 fix: this gates on the trigger rate ALONE, never on `delta === 0`. A
 *  low-or-unknown trigger rate makes ANY reading from this run
 *  uninterpretable as evidence about the skill — including a non-zero delta,
 *  which the pre-fix version let through unchallenged (a treatment arm that
 *  barely triggered but still moved the resolve rate by chance/noise would
 *  otherwise read as a real effect). "Low" is under 50%; `total === 0` (no
 *  known trigger data at all) is treated as low too — an unmeasured trigger
 *  rate is not evidence of a high one.
 *
 *  Exported (final-review C1): capability-report.ts's renderBadgeSvg reuses
 *  this exact gate so the badge -- the artifact that travels furthest, often
 *  further than report.md itself -- never renders a bare net delta when the
 *  underlying trigger rate can't support reading it as evidence about the
 *  skill. */
export function isLowTriggerRate(triggerRate: TriggerRate | undefined): boolean {
  if (!triggerRate) return false;
  if (triggerRate.total === 0) return true;
  return triggerRate.triggered / triggerRate.total < 0.5;
}

export function renderReceiptMd(d: ReceiptData): string {
  const p = d.profile;
  const delta = d.treatment.passed - d.baseline.passed;
  const t = d.triggerRate;
  const lowTrigger = isLowTriggerRate(t);
  // I1: a --task-set report must not speak slate vocabulary. slateSha256/
  // slateHalf are reused unchanged for a task-set identity (see this file's
  // ReceiptProfile.identityKind doc and capability-report.ts's module doc);
  // only the reader-facing collection label changes here.
  const isTaskSet = p.identityKind === 'task-set';
  const collectionLabel = isTaskSet ? `task set ${p.slateSha256.slice(0, 8)}` : `${p.slateHalf} slate`;
  const scopeLabel = isTaskSet ? 'task set sha256' : 'slate sha256';
  return [
    '```',
    `skill:      ${d.treatmentArm}${p.forkedFrom ? `, forked from ${p.forkedFrom}` : ''}`,
    `measured:   ${d.n} paired tasks (${collectionLabel}), ${d.excluded} excluded as ungradeable`,
    `agent:      ${p.agent}, ${p.model}, one pinned configuration`,
    `result:     baseline resolved ${d.baseline.passed}/${d.baseline.scorable} ` +
      `(95% Wilson ${pct(d.baseline.lo)}–${pct(d.baseline.hi)})`,
    `            with skill resolved ${d.treatment.passed}/${d.treatment.scorable} ` +
      `(95% Wilson ${pct(d.treatment.lo)}–${pct(d.treatment.hi)})`,
    `            net ${delta >= 0 ? '+' : ''}${delta} tasks ` +
      `(improved ${d.paired.improved}, regressed ${d.paired.regressed})`,
    // I4: never render "skill loaded on 0/0 attempts" — total === 0 means no
    // session data was captured at all, not a 0% trigger rate.
    ...(t
      ? t.total === 0
        ? [`trigger:     unknown (no session data captured)`]
        : [
          `trigger:    skill loaded on ${t.triggered}/${t.total} solved+failed attempts` +
            (t.unknown > 0 ? ` (${t.unknown} unknown — session not captured)` : ''),
        ]
      : []),
    `cost:       mean per task — baseline $${d.meanCostUsd.baseline.toFixed(2)}, ` +
      `with skill $${d.meanCostUsd.treatment.toFixed(2)} (reported, never gates)`,
    `scope:      one agent configuration, one benchmark, this task list`,
    `            ${scopeLabel}: ${p.slateSha256} · measured ${p.measuredOn}`,
    ...(p.skillSha256
      ? [`            skill bytes: sha256 ${p.skillSha256}${p.skillSource ? ` · source ${p.skillSource}` : ''}`]
      : []),
    `files:      per-task outcomes, run manifests, full agent transcripts, rerun script`,
    '```',
    '',
    `This is a small paired sample; the intervals above are wide by construction and`,
    `no claim of a real effect is made. Reproduce it from the pinned ${isTaskSet ? 'task set' : 'slate'} and rig (see files).`,
    ...(lowTrigger
      ? [
        '',
        t!.total === 0
          ? `No session data was captured to measure the skill's trigger rate in this run — this reads as ` +
            `**not exercised on this task set**, not as evidence the skill has no effect.`
          : `The skill triggered on only ${t!.triggered}/${t!.total} attempts in this run — this reads as ` +
            `**not exercised on this task set**, not as evidence the skill has no effect.`,
        ...(delta !== 0
          ? [
            `A net ${delta >= 0 ? '+' : ''}${delta}-task difference was observed, but with a trigger rate ` +
              `this low it cannot be attributed to the skill.`,
          ]
          : []),
      ]
      : []),
    '',
  ].join('\n');
}
