/**
 * Capability report composition (spec §1 of
 * docs/superpowers/specs/2026-07-30-skills-factory-mvp-design.md, v0.2):
 * the public artifact a skill author receives — the paired receipt block
 * (§"packaging"), a per-task outcome table, the task-set identity (sha256,
 * domain, gradeability/screening summary), and a reproduce section (raw data
 * paths + the exact rerun command). Also the badge/embed distribution
 * artifacts (§4.1): a small self-contained SVG and a markdown snippet
 * carrying the repointed `jinn.*` metadata block for the author to paste.
 *
 * Every function here is pure — no filesystem, no network. The CLI
 * (scripts/skills-bench/render-report.ts) does all the I/O (loading the
 * task set, the manifest, the attempts log, and the session transcripts for
 * trigger detection) and passes already-computed data in, mirroring how
 * render-receipts.ts composes receipt.ts's pure builders.
 *
 * `ReceiptProfile.slateSha256`/`slateHalf` are reused unchanged for a
 * task-set-driven report (`slateSha256` set to the task set's own sha256,
 * `slateHalf` read from the run's manifest — 'feedback' by convention for a
 * --task-set run, per run-bench.ts's own doc comment: "a SkillTaskSetV1 has
 * no feedback/holdout split — half is fixed... so the field stays populated
 * without implying a real split"). This mirrors that precedent rather than
 * forking receipt.ts's field names for a second, semantically-identical
 * "pinned task collection" concept.
 */
import { attemptKey, type BenchOutcome } from './attempts.js';
import { buildJinnReceiptMetadata, quoteYamlScalar } from './frontmatter.js';
import {
  buildReceipt, isLowTriggerRate, renderReceiptMd, summarizeTriggerRate,
  type ArmSummary, type ReceiptData, type ReceiptProfile, type TriggerRate,
} from './receipt.js';
import type { SkillPin } from './skill-pin.js';
import { isTaskGradeabilityPassing, type SkillTaskSetV1 } from './task-set.js';

// ---------------------------------------------------------------------------
// Per-task outcome table
// ---------------------------------------------------------------------------

export interface PerTaskRepeatOutcome {
  repeat: number;
  /** null = ungradeable (never coerced to fail — mirrors BenchOutcome.passed). */
  passed: boolean | null;
}

export interface PerTaskTreatmentOutcome extends PerTaskRepeatOutcome {
  /** null = unknown — either the attempt was ungradeable (trigger detection
   *  is not meaningful for a patch that never graded) or its session JSONL
   *  was not captured. Never coerced to `false`. */
  triggered: boolean | null;
}

export interface PerTaskRow {
  taskId: string;
  baseline: PerTaskRepeatOutcome[];
  treatment: PerTaskTreatmentOutcome[];
}

function byRepeat(outcomes: BenchOutcome[], taskId: string, arm: string): BenchOutcome[] {
  return outcomes
    .filter((o) => o.instanceId === taskId && o.arm === arm)
    .sort((a, b) => a.repeat - b.repeat);
}

/** Builds one row per task id, in the order given (callers pass the task
 *  set's own declared order — see `buildCapabilityReport`). A task with no
 *  recorded attempts in either arm (e.g. screened out, never run) is still
 *  included with empty outcome arrays; the renderer prints `n/a` for it. */
export function buildPerTaskRows(
  outcomes: BenchOutcome[],
  taskIds: string[],
  baselineArm: string,
  treatmentArm: string,
  /** attemptKey(...) -> triggered, for treatment-arm attempts whose patch
   *  graded (passed !== null). Absent key = unknown (no session captured). */
  triggerByKey: Map<string, boolean | null>,
): PerTaskRow[] {
  return taskIds.map((taskId) => {
    const baseline = byRepeat(outcomes, taskId, baselineArm).map((o) => ({ repeat: o.repeat, passed: o.passed }));
    const treatment = byRepeat(outcomes, taskId, treatmentArm).map((o) => {
      const triggered = o.passed === null
        ? null
        : triggerByKey.get(attemptKey({ instanceId: taskId, arm: treatmentArm, repeat: o.repeat })) ?? null;
      return { repeat: o.repeat, passed: o.passed, triggered };
    });
    return { taskId, baseline, treatment };
  });
}

// ---------------------------------------------------------------------------
// Task-set identity summary
// ---------------------------------------------------------------------------

export interface TaskSetIdentitySummary {
  sha256: string;
  domain: string;
  taskCount: number;
  gradeability: { passing: number; total: number };
  /** Absent when the set has never been through the discrimination gate
   *  (screen-task-set.ts) — screening is recommended but not required
   *  (task-set.ts's `selectTasksForMeasurement`). */
  screening?: { kept: number; droppedNoHeadroom: number; droppedUngradeable: number };
}

export function buildTaskSetIdentity(taskSet: SkillTaskSetV1): TaskSetIdentitySummary {
  const passing = taskSet.tasks.filter(isTaskGradeabilityPassing).length;
  const summary = taskSet.screeningSummary;
  return {
    sha256: taskSet.sha256,
    domain: taskSet.domain,
    taskCount: taskSet.tasks.length,
    gradeability: { passing, total: taskSet.tasks.length },
    ...(summary
      ? {
        screening: {
          kept: summary.kept.length,
          droppedNoHeadroom: summary.droppedNoHeadroom.length,
          droppedUngradeable: summary.droppedUngradeable.length,
        },
      }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Field contract (design §2 of
// docs/superpowers/specs/2026-07-31-capability-report-artifact-design.md) —
// one resolved object consumed by all three renderers (badge/card/report), so
// no renderer re-derives a field from `ReceiptData`/`SkillPin`/
// `TaskSetIdentitySummary` on its own and risks disagreeing with a sibling
// renderer. Composition only — every value is read straight from an
// already-computed source, never recomputed here.
// ---------------------------------------------------------------------------

export interface ReportFields {
  skill: string;
  skillSha256: string;
  /** `${pin.source}@${pin.commit}` — pinned upstream provenance. */
  skillSource: string;
  license: string | null;
  repoLicense: string | null;
  model: string;
  agent: string;
  measuredOn: string;
  taskSetSha256: string;
  sourceKind: 'slate' | 'task-set';
  domain: string;
  taskCount: number;
  gradeability: { passing: number; total: number };
  /** Absent when the set has never been through the discrimination gate —
   *  see `TaskSetIdentitySummary.screening`. */
  screening?: { kept: number; droppedNoHeadroom: number; droppedUngradeable: number };
  n: number;
  excluded: number;
  baseline: ArmSummary;
  treatment: ArmSummary;
  improved: number;
  regressed: number;
  meanCostUsd: { baseline: number; treatment: number };
  /** Absent when no session-JSONL trigger data was captured for this run. */
  triggerRate?: TriggerRate;
  /** One sentence stating the task set's discrimination-gate provenance.
   *  Truthful in both directions: when `screening` is present it states the
   *  set was screened baseline-only (the agent fails these tasks unaided);
   *  when absent it says screening was never run — an unscreened set must
   *  never claim the screening guarantee it doesn't have. */
  discriminationProvenance: string;
}

function buildDiscriminationProvenance(screening?: TaskSetIdentitySummary['screening']): string {
  if (screening) {
    const dropped = screening.droppedNoHeadroom + screening.droppedUngradeable;
    return (
      `This task set was screened baseline-only before measurement (kept ${screening.kept}, ` +
      `dropped ${dropped} with no proven headroom) — every task here is one the agent fails unaided.`
    );
  }
  return (
    'This task set has not been through the baseline-only discrimination gate — some tasks may already ' +
    'be solvable unaided, so headroom is not guaranteed.'
  );
}

export interface BuildReportFieldsOptions {
  pin: SkillPin;
  profile: ReceiptProfile;
  taskSetIdentity: TaskSetIdentitySummary;
  receipt: ReceiptData;
}

/** Pure composition of `ReportFields` from already-computed sources (design
 *  §2's field-contract table). Reuses `buildTaskSetIdentity`'s output rather
 *  than re-deriving domain/taskCount/screening from a raw `SkillTaskSetV1`. */
export function buildReportFields(opts: BuildReportFieldsOptions): ReportFields {
  const { pin, profile, taskSetIdentity, receipt } = opts;
  return {
    skill: pin.name,
    skillSha256: pin.sha256,
    skillSource: `${pin.source}@${pin.commit}`,
    license: pin.license,
    repoLicense: pin.repoLicense,
    model: profile.model,
    agent: profile.agent,
    measuredOn: profile.measuredOn,
    taskSetSha256: profile.slateSha256,
    sourceKind: profile.identityKind ?? 'slate',
    domain: taskSetIdentity.domain,
    taskCount: taskSetIdentity.taskCount,
    gradeability: taskSetIdentity.gradeability,
    ...(taskSetIdentity.screening ? { screening: taskSetIdentity.screening } : {}),
    n: receipt.n,
    excluded: receipt.excluded,
    baseline: receipt.baseline,
    treatment: receipt.treatment,
    improved: receipt.paired.improved,
    regressed: receipt.paired.regressed,
    meanCostUsd: receipt.meanCostUsd,
    ...(receipt.triggerRate ? { triggerRate: receipt.triggerRate } : {}),
    discriminationProvenance: buildDiscriminationProvenance(taskSetIdentity.screening),
  };
}

// ---------------------------------------------------------------------------
// Derived-never-stored helpers (design §2: "concordant counts... and cost
// overhead percentage" are always recomputed from ReceiptData, never
// persisted as their own fields).
// ---------------------------------------------------------------------------

/** Both-arms-agreed outcome counts, split by whether the agreement was a pass
 *  or a fail. `PairedComparison` (packages/core/src/paired.ts) already
 *  carries this split unambiguously as `concordantPass`/`concordantFail` —
 *  computed by `comparePaired` over exactly the scorable-in-both-arms pairs,
 *  the same population `improved`/`regressed` are drawn from. No further
 *  inference is possible or needed: this is a direct read, not a guess. */
export function deriveConcordant(receipt: ReceiptData): { bothPassed: number; bothFailed: number } {
  return { bothPassed: receipt.paired.concordantPass, bothFailed: receipt.paired.concordantFail };
}

/** Treatment/baseline mean-cost ratio minus one (design §2: "overhead = ratio
 *  − 1"). `null` — never `Infinity`, never a fabricated `0` — when the
 *  baseline mean is zero (no headroom to compute a ratio against) or either
 *  mean is missing. */
export function deriveCostOverhead(receipt: ReceiptData): number | null {
  const baseline = receipt.meanCostUsd?.baseline;
  const treatment = receipt.meanCostUsd?.treatment;
  if (baseline == null || treatment == null || baseline === 0) return null;
  return treatment / baseline - 1;
}

// ---------------------------------------------------------------------------
// Cohort data model (design §2, §7-8; plan work item 1). Types only — cohort
// ASSEMBLY (which skills belong in a niche, install-count sourcing) is
// explicitly deferred; nothing here computes a cohort, only validates and
// ranks one a caller already assembled.
// ---------------------------------------------------------------------------

export interface CohortInstalls {
  count: number;
  /** Where the count came from (e.g. a registry name/URL) — mandatory so an
   *  unprovenanced install count is unrepresentable (design open question 1:
   *  cite source+date, or drop the column entirely by omitting `installs`). */
  source: string;
  /** ISO date the count was observed. */
  asOf: string;
}

export interface CohortEntry {
  skill: string;
  skillSha: string;
  installs?: CohortInstalls;
  triggered: number;
  total: number;
  netTasks: number;
  costRatio: number;
  /** Exactly one entry per `Cohort` may be `true` — the skill this report is
   *  about. See `validateCohort`. */
  focal: boolean;
}

export interface Cohort {
  domain: string;
  entries: CohortEntry[];
}

export class CohortValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CohortValidationError';
  }
}

/** Fail-loud shape checks a renderer can rely on without re-checking: exactly
 *  one focal entry, no duplicate skill names, at least one entry. Does not
 *  assemble or fetch anything — the caller already built `cohort`. */
export function validateCohort(cohort: Cohort): void {
  if (cohort.entries.length === 0) {
    throw new CohortValidationError(`cohort '${cohort.domain}' has no entries`);
  }
  const focal = cohort.entries.filter((e) => e.focal);
  if (focal.length === 0) {
    throw new CohortValidationError(`cohort '${cohort.domain}' has no focal entry`);
  }
  if (focal.length > 1) {
    throw new CohortValidationError(
      `cohort '${cohort.domain}' has ${focal.length} focal entries ` +
      `(${focal.map((e) => e.skill).join(', ')}) — exactly one is required`,
    );
  }
  const seen = new Set<string>();
  for (const entry of cohort.entries) {
    if (seen.has(entry.skill)) {
      throw new CohortValidationError(`cohort '${cohort.domain}' has duplicate skill '${entry.skill}'`);
    }
    seen.add(entry.skill);
  }
}

/** The focal entry's rank by `netTasks` descending, competition-style: ties
 *  share the better (lower) rank number, and the next distinct value skips
 *  the tied slots (e.g. two entries tied for 1st, next entry is 3rd of N).
 *  Pure ranking only — renderers own how the number is phrased ("2nd of
 *  6"). */
export function cohortRank(cohort: Cohort): { rank: number; of: number } {
  const focal = cohort.entries.find((e) => e.focal);
  if (!focal) throw new CohortValidationError(`cohort '${cohort.domain}' has no focal entry`);
  const rank = 1 + cohort.entries.filter((e) => e.netTasks > focal.netTasks).length;
  return { rank, of: cohort.entries.length };
}

// ---------------------------------------------------------------------------
// Composed report
// ---------------------------------------------------------------------------

export interface ReportLinks {
  /** Paths of the raw data shipped alongside report.md, relative to the
   *  report directory (e.g. `data/attempts.jsonl`). Data, not narration —
   *  rendered verbatim. */
  dataPaths: string[];
  /** The exact command a reader runs to reproduce this measurement. */
  rerunCommand: string;
}

export interface CapabilityReport {
  skill: string;
  receipt: ReceiptData;
  perTask: PerTaskRow[];
  taskSetIdentity: TaskSetIdentitySummary;
  links: ReportLinks;
  /** The resolved field contract (design §2) every renderer reads instead of
   *  re-deriving its own copy of a field. */
  fields: ReportFields;
  /** Optional passthrough — cohort ASSEMBLY happens elsewhere (deferred);
   *  this report only carries whatever cohort the caller already built. */
  cohort?: Cohort;
}

export interface BuildCapabilityReportOptions {
  skill: string;
  outcomes: BenchOutcome[];
  taskSet: SkillTaskSetV1;
  baselineArm: string;
  treatmentArm: string;
  profile: ReceiptProfile;
  /** The measured skill's pin record — new input to the report pipeline
   *  (design §2's `skill`/`skillSha256`/`skillSource`/`license`/
   *  `repoLicense` fields all read from it). `render-report.ts` reads
   *  `pin.json` and passes it straight through. */
  pin: SkillPin;
  /** attemptKey(...) -> triggered, for treatment-arm attempts whose patch
   *  graded (passed !== null). Absent key = unknown. */
  triggerByKey: Map<string, boolean | null>;
  links: ReportLinks;
  /** Optional passthrough — see `CapabilityReport.cohort`. */
  cohort?: Cohort;
  /** `BenchManifest.eligibleTaskIds` from THIS run (final-review round 2 fix
   *  to I8) — the run-scoped source of truth for which tasks were actually
   *  eligible to be measured, reflecting `screeningRespected`/
   *  `--include-screened-out` for THIS run specifically. Pass the manifest's
   *  field straight through (render-report.ts already loads the manifest).
   *  Absent only for a manifest written before this field existed — see
   *  `buildCapabilityReport`'s fallback. Never derive this from
   *  `taskSet.screeningSummary.kept` alone: that is an AUTHORING-TIME
   *  decision (screen-task-set.ts) that does not know whether THIS run
   *  passed `--include-screened-out`, so it silently drops real outcomes for
   *  a screened-out task an `--include-screened-out` run actually measured —
   *  the exact regression this field closes. */
  eligibleTaskIds?: string[];
}

export function buildCapabilityReport(opts: BuildCapabilityReportOptions): CapabilityReport {
  // Same convention as render-receipts.ts's computeTriggerRate: the trigger
  // rate is measured over solved+failed (passed !== null) treatment-arm
  // attempts only — an ungradeable patch was never a candidate for the
  // trigger question in the first place.
  const graded = opts.outcomes.filter((o) => o.arm === opts.treatmentArm && o.passed !== null);
  const triggerRate: TriggerRate = summarizeTriggerRate(
    graded.map((o) => ({
      triggered: opts.triggerByKey.get(attemptKey({ instanceId: o.instanceId, arm: o.arm, repeat: o.repeat })) ?? null,
    })),
  );
  const receipt = buildReceipt(opts.outcomes, {
    baselineArm: opts.baselineArm,
    treatmentArm: opts.treatmentArm,
    profile: opts.profile,
    triggerRate,
  });

  // I8: every ELIGIBLE task gets a row, whether or not it has a logged
  // outcome — a task that was eligible but whose solves all failed before
  // producing a gradeable patch (solveFailures, never appended to
  // attempts.jsonl) must still be visible in the public artifact, not
  // silently disappear while taskSetIdentity.taskCount still counts it.
  //
  // Round-2 fix: "eligible" MUST be run-scoped, not authoring-time-scoped.
  // `opts.eligibleTaskIds` (BenchManifest.eligibleTaskIds) reflects what THIS
  // run actually measured — including a screened-out task when this run
  // passed `--include-screened-out` (selectTasksForMeasurement, run-bench.ts).
  // Using `taskSet.screeningSummary.kept` alone (an authoring-time decision
  // that predates and does not know about any particular run's flags) would
  // silently drop a screened-out task's REAL outcomes from an
  // `--include-screened-out` run — reintroducing the exact invisibility bug
  // I8 was meant to close, just for that path.
  //
  // Precedence: manifest's `eligibleTaskIds` when present (the run-scoped
  // truth); else, for a manifest written before this field existed, fall
  // back to the union of screening.kept and every id with a logged outcome
  // (covers both "normally screened" and "an old --include-screened-out run
  // whose extra tasks have real outcomes" without the manifest's help); else
  // (no screening receipts at all) every task counts as eligible — nothing
  // to exclude. Matches buildPerTaskRows's own doc comment ("still included
  // with empty outcome arrays... renderer prints n/a").
  const outcomeIds = new Set(
    opts.outcomes
      .filter((o) => o.arm === opts.baselineArm || o.arm === opts.treatmentArm)
      .map((o) => o.instanceId),
  );
  const eligibleIds = opts.eligibleTaskIds
    ? new Set(opts.eligibleTaskIds)
    : opts.taskSet.screeningSummary
      ? new Set([...opts.taskSet.screeningSummary.kept, ...outcomeIds])
      : null;
  const taskIds = opts.taskSet.tasks
    .map((t) => t.id)
    .filter((id) => eligibleIds === null || eligibleIds.has(id));
  const perTask = buildPerTaskRows(opts.outcomes, taskIds, opts.baselineArm, opts.treatmentArm, opts.triggerByKey);
  const taskSetIdentity = buildTaskSetIdentity(opts.taskSet);
  const fields = buildReportFields({ pin: opts.pin, profile: opts.profile, taskSetIdentity, receipt });

  return {
    skill: opts.skill,
    receipt,
    perTask,
    taskSetIdentity,
    links: opts.links,
    fields,
    ...(opts.cohort ? { cohort: opts.cohort } : {}),
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function outcomeLabel(passed: boolean | null): string {
  if (passed === true) return 'resolved';
  if (passed === false) return 'not resolved';
  return 'ungradeable';
}

function triggeredLabel(triggered: boolean | null): string {
  if (triggered === true) return 'yes';
  if (triggered === false) return 'no';
  return 'unknown';
}

function renderPerTaskTable(rows: PerTaskRow[]): string {
  if (rows.length === 0) return '_No per-task outcomes recorded._';
  const lines = ['| task | baseline | with skill | triggered |', '| --- | --- | --- | --- |'];
  for (const row of rows) {
    const baselineCell = row.baseline.length ? row.baseline.map((o) => outcomeLabel(o.passed)).join(', ') : 'n/a';
    const treatmentCell = row.treatment.length ? row.treatment.map((o) => outcomeLabel(o.passed)).join(', ') : 'n/a';
    const triggeredCell = row.treatment.length ? row.treatment.map((o) => triggeredLabel(o.triggered)).join(', ') : 'n/a';
    lines.push(`| ${row.taskId} | ${baselineCell} | ${treatmentCell} | ${triggeredCell} |`);
  }
  return lines.join('\n');
}

function renderTaskSetIdentity(identity: TaskSetIdentitySummary): string {
  const screeningLine = identity.screening
    ? `screening:  kept ${identity.screening.kept}, dropped (no headroom) ${identity.screening.droppedNoHeadroom}, ` +
      `dropped (ungradeable) ${identity.screening.droppedUngradeable}`
    : 'screening:  not run';
  return [
    '```',
    `domain:     ${identity.domain}`,
    `tasks:      ${identity.taskCount} (gradeability ${identity.gradeability.passing}/${identity.gradeability.total} passing)`,
    screeningLine,
    `sha256:     ${identity.sha256}`,
    '```',
  ].join('\n');
}

/** The public capability report: the paired-receipt block first (reused
 *  verbatim from receipt.ts), then task-set identity, the per-task outcome
 *  table, and a reproduce section. */
export function renderCapabilityReportMd(report: CapabilityReport): string {
  return [
    `# ${report.skill} — capability report`,
    '',
    renderReceiptMd(report.receipt),
    '## Task set',
    '',
    renderTaskSetIdentity(report.taskSetIdentity),
    '',
    '## Per-task outcomes',
    '',
    renderPerTaskTable(report.perTask),
    '',
    '## Reproduce',
    '',
    '```',
    `rerun: ${report.links.rerunCommand}`,
    `data:  ${report.links.dataPaths.join(', ')}`,
    '```',
    '',
  ].join('\n');
}

/** A plain, non-judgmental one-line summary for the badge (§4.1: "the badge
 *  names the report, it does not grade") — net paired delta over N, nothing
 *  color-codeable. Derived from the same ReceiptData the report renders, so
 *  the badge can never disagree with the report it points at. */
export function deriveVerdictLine(receipt: ReceiptData): string {
  const delta = receipt.treatment.passed - receipt.baseline.passed;
  const sign = delta > 0 ? '+' : '';
  return `net ${sign}${delta}/${receipt.n} paired tasks vs. baseline`;
}

// ---------------------------------------------------------------------------
// Badge SVG
// ---------------------------------------------------------------------------

export interface BadgeOptions {
  skill: string;
  /** Plain-text verdict, e.g. from `deriveVerdictLine` — never a pass/fail
   *  judgment or a color. Only rendered when `triggerRate` reads as a normal
   *  (non-low) rate — see `triggerRate` below (final-review C1). */
  verdictLine: string;
  measuredOn: string;
  /** Final-review C1: the same `TriggerRate` the report's receipt block was
   *  built from. When `isLowTriggerRate(triggerRate)` is true (low or
   *  unknown trigger rate — the identical gate `renderReceiptMd` uses), the
   *  badge's second line renders the trigger-honesty caveat INSTEAD OF
   *  `verdictLine` — the badge travels furthest of any artifact this rig
   *  produces (often the only thing a reader ever sees, per spec §1.1), so
   *  it must never carry a bare net delta the report itself would refuse to
   *  present as unqualified evidence. Absent/undefined reads as "not low"
   *  (back-compat: a caller with no trigger data at all should still pass an
   *  explicit `{ triggered: 0, total: 0, unknown: 0 }`-shaped rate to get the
   *  caveat; omitting the field entirely is only for badges that genuinely
   *  have no trigger concept, e.g. none exist yet in this rig). */
  triggerRate?: TriggerRate;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The badge's second line (final-review C1): the plain net-delta verdict
 *  when the trigger rate is normal, or the trigger-honesty caveat instead of
 *  it when `isLowTriggerRate` says the rate is low or unknown — never both,
 *  never the bare delta alongside the caveat. Mirrors `renderReceiptMd`'s
 *  `lowTrigger` branch exactly (same gate, same two caveat strings) so the
 *  badge can never disagree with the report it points at. */
function badgeLine2(opts: BadgeOptions): string {
  if (isLowTriggerRate(opts.triggerRate)) {
    const caveat = !opts.triggerRate || opts.triggerRate.total === 0
      ? 'no session data'
      : 'not exercised on this task set';
    return `${caveat} - measured ${opts.measuredOn}`;
  }
  return `${opts.verdictLine} - measured ${opts.measuredOn}`;
}

/** A small, self-contained flat SVG badge: two text lines (what was measured
 *  and when) inside a bordered box. No external fonts, images, or refs — a
 *  generic `font-family` name only, never an `@font-face`/`url()`/`xlink:href`
 *  pointing off-document. Neutral styling throughout: no color-coded
 *  pass/fail fill, because the badge names the report, it does not grade
 *  (spec §4.1/§1.1). */
export function renderBadgeSvg(opts: BadgeOptions): string {
  const line1 = `jinn capability report: ${opts.skill}`;
  const line2 = badgeLine2(opts);
  const charWidth = 6.2;
  const width = Math.max(220, Math.ceil(Math.max(line1.length, line2.length) * charWidth) + 16);
  const label = escapeXml(`${line1}; ${line2}`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="40" viewBox="0 0 ${width} 40" role="img" aria-label="${label}">`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="39" rx="4" fill="#ffffff" stroke="#33415c" stroke-width="1"/>`,
    `<text x="8" y="17" font-family="monospace" font-size="11" fill="#1b2430">${escapeXml(line1)}</text>`,
    `<text x="8" y="31" font-family="monospace" font-size="11" fill="#1b2430">${escapeXml(line2)}</text>`,
    '</svg>',
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Embed snippet
// ---------------------------------------------------------------------------

export interface EmbedSnippetOptions {
  skill: string;
  /** Public URL of the report (`reports/<skill>@<sha>/report.md`). */
  reportUrl: string;
  /** Public URL (or relative path, for a same-repo embed) of the badge SVG. */
  badgeUrl: string;
  measuredOn: string;
  /** Local path of the rendered report.md — hashed to produce
   *  `jinn.receipt-sha256` via buildJinnReceiptMetadata. */
  reportFilePath: string;
}

/** The block an author pastes into their own repo: a markdown badge image
 *  linking to the report, and the `jinn.*` metadata (§4.1 — repointed at the
 *  public report, never a fork receipt; `jinn.forked-from` is never emitted
 *  here, per spec §4.1, "there is no fork, so there is nothing to attribute a
 *  fork to") ready to paste into the skill's own frontmatter `metadata:`
 *  block. */
export async function buildEmbedSnippet(opts: EmbedSnippetOptions): Promise<string> {
  const metadata = await buildJinnReceiptMetadata({
    receiptUrl: opts.reportUrl,
    receiptFilePath: opts.reportFilePath,
    measuredOn: opts.measuredOn,
  });
  return [
    `[![jinn capability report: ${opts.skill}](${opts.badgeUrl})](${opts.reportUrl})`,
    '',
    `Capability report: ${opts.reportUrl}`,
    '',
    '```yaml',
    'metadata:',
    ...Object.entries(metadata).map(([key, value]) => `  ${key}: ${quoteYamlScalar(value)}`),
    '```',
    '',
  ].join('\n');
}
