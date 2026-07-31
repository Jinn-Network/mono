/**
 * Capability report composition. The public artifact a skill author
 * receives is three pieces, one identity (design §1 of
 * docs/superpowers/specs/2026-07-31-capability-report-artifact-design.md):
 * a badge (this module's `renderBadgeSvg`), a card (capability-card.ts — the
 * card carries the numbers), and this module's `renderCapabilityReportMd` —
 * the narrative report. Design §6: "the card carries the numbers; the
 * report does not repeat them" — the report states the paired outcome in
 * words, the trigger-rate diagnosis, scope, and reproduction steps, and
 * links to `data/per-task.md` (`renderPerTaskTableMd`, rendered separately)
 * rather than embedding the per-task table in its body.
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
  buildReceipt, isLowTriggerRate, summarizeTriggerRate,
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
  /** The report's own public URL (design §6 section 9), when the caller
   *  already knows it (e.g. `--base-url`-derived, work item 5). Optional —
   *  a render-time caller that hasn't resolved a public URL yet simply omits
   *  the line rather than the renderer inventing one. */
  reportUrl?: string;
}

// ---------------------------------------------------------------------------
// Narrative inputs (design §6 sections 6-7) — human-authored for now; the
// renderer never invents a pattern or a suggested change. Absent entirely
// when the caller has nothing to say, in which case those sections are
// omitted rather than rendered empty (design §6: patterns are "explicitly
// labelled as hypothesis, not finding").
// ---------------------------------------------------------------------------

export interface ReportNarrativePattern {
  /** The hypothesis itself, in plain language. Never rendered without the
   *  "hypothesis, not finding" label (design §6 section 6). */
  text: string;
  /** A transcript excerpt or other evidence supporting the hypothesis
   *  (design §6: "with a transcript excerpt as evidence"). */
  evidence?: string;
}

export interface ReportNarrative {
  pattern?: ReportNarrativePattern;
  /** At most three concrete edits (design §6 section 7); the renderer caps
   *  display at three even if more are supplied, but never invents its
   *  own. */
  changes?: string[];
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
  /** Optional passthrough — see `ReportNarrative`'s doc comment. Never
   *  computed here; a caller (human, for now) supplies it or the report's
   *  §6/§7 sections are omitted. */
  narrative?: ReportNarrative;
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
  /** Optional passthrough — see `CapabilityReport.narrative`. */
  narrative?: ReportNarrative;
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
    ...(opts.narrative ? { narrative: opts.narrative } : {}),
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

const formatPct = (x: number): string => `${(100 * x).toFixed(0)}%`;

/** Focal cohort rank + ordinal suffix, or `null` without a cohort — shared
 *  by the title (design §6 section 1: "cohort position/superlative belongs
 *  here when a cohort exists") and the cohort table section. Caller must
 *  validate the cohort first (`renderCapabilityReportMd` does, once, before
 *  any cohort-dependent section runs). */
function cohortSuperlative(cohort: Cohort | undefined): string | null {
  if (!cohort) return null;
  const { rank, of } = cohortRank(cohort);
  return `${ordinal(rank)} of ${of} in ${cohort.domain}`;
}

/** Section 1 (design §6): the most interesting TRUE finding, not the flat
 *  number. Null-variant branch (§6.1 — the primary case, roughly 4 in 5
 *  reports): leads with the diagnosis, never the zero. */
function renderTitle(report: CapabilityReport): string {
  const { skill, receipt, cohort } = report;
  const netDelta = receipt.treatment.passed - receipt.baseline.passed;
  const isNull = netDelta === 0;
  const superlative = cohortSuperlative(cohort);
  const suffix = superlative ? ` — ${superlative}` : '';
  if (isNull) {
    const rate = receipt.triggerRate;
    const triggerText = !rate || rate.total === 0
      ? 'no session data'
      : `trigger rate ${rate.triggered}/${rate.total}`;
    return `${skill} — measured, no effect found (${triggerText})${suffix}`;
  }
  const sign = netDelta > 0 ? '+' : '';
  return `${skill} — net ${sign}${netDelta} tasks with skill loaded${suffix}`;
}

/** Section 2: one sentence — what was measured, that it is public and
 *  reproducible, that nothing is asked of the author. */
function renderOpener(fields: ReportFields): string {
  return (
    `This is an independent capability measurement of \`${fields.skill}\` on ${fields.n} paired tasks in the ` +
    `${fields.domain} domain — public, reproducible from the data linked below, and nothing is asked of you.`
  );
}

/** Section 3: one row per cohort skill (skill, installs, loaded on, net
 *  tasks, cost vs baseline), focal bolded. Installs column renders only when
 *  at least one entry carries provenance (design §6 section 3: "rendered
 *  ONLY with provenance") — an entry without it shows an em dash, never a
 *  bare count. Omitted entirely by the caller when `report.cohort` is
 *  absent (design §6: "omitted entirely without a cohort"). */
function renderCohortTable(cohort: Cohort): string {
  const hasInstalls = cohort.entries.some((e) => e.installs);
  const headers = ['skill', ...(hasInstalls ? ['installs'] : []), 'loaded on', 'net tasks', 'cost vs baseline'];
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const entry of cohort.entries) {
    const skillCell = entry.focal ? `**${entry.skill}**` : entry.skill;
    const installsCell = entry.installs
      ? `${entry.installs.count} (${entry.installs.source}, ${entry.installs.asOf})`
      : '—';
    const loadedCell = `${entry.triggered}/${entry.total}`;
    const netCell = `${entry.netTasks > 0 ? '+' : ''}${entry.netTasks}`;
    const costPct = Math.round((entry.costRatio - 1) * 100);
    const costCell = `${costPct > 0 ? '+' : ''}${costPct}%`;
    const cells = [skillCell, ...(hasInstalls ? [installsCell] : []), loadedCell, netCell, costCell];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

/** Section 4: the paired outcome in plain language — never re-rendering the
 *  card's full figure block. Intervals are still shown (design §7: "always
 *  shown" wherever a figure appears) because the uncertainty statement needs
 *  them; this is a different sentence from the card's numbers, not a
 *  restatement of them. */
function renderResult(report: CapabilityReport): string {
  const { receipt, skill } = report;
  const netDelta = receipt.treatment.passed - receipt.baseline.passed;
  const isNull = netDelta === 0;
  const sign = netDelta > 0 ? '+' : '';
  const concordant = deriveConcordant(receipt);
  const paragraphs: string[] = [
    `With \`${skill}\` loaded, the agent solved ${receipt.paired.improved} task(s) the baseline missed and missed ` +
    `${receipt.paired.regressed} the baseline solved — both arms agreed on ${concordant.bothPassed} pass and ` +
    `${concordant.bothFailed} fail. Baseline resolved ${receipt.baseline.passed}/${receipt.baseline.scorable} tasks ` +
    `(95% Wilson ${formatPct(receipt.baseline.lo)}-${formatPct(receipt.baseline.hi)}); with the skill, ` +
    `${receipt.treatment.passed}/${receipt.treatment.scorable} ` +
    `(95% Wilson ${formatPct(receipt.treatment.lo)}-${formatPct(receipt.treatment.hi)}) — ` +
    `net ${sign}${netDelta} across ${receipt.n} paired tasks.`,
  ];
  if (isNull) {
    paragraphs.push(
      'This is a null result: no measured net effect. Most publicly measured skills show no pass-rate ' +
      'improvement (SWE-Skills-Bench, 39 of 49; arXiv 2603.15401) — a null here is the normal outcome, not a ' +
      'verdict. The next section explains where in the pipeline that null likely comes from.',
    );
  } else {
    paragraphs.push(
      'This is a small paired sample; the interval above is wide by construction and this reads as a ' +
      'direction, not proof.',
    );
  }
  return paragraphs.join('\n\n');
}

/** Section 5: the trigger-rate diagnosis, in the plain words the null
 *  variant requires (design §6.1) — a low trigger rate is a discoverability
 *  result, not a quality result; a high trigger rate with a null effect
 *  means the skill was given its chance and did not change outcomes, stated
 *  without softening. Trigger rate is read straight from `ReceiptData`,
 *  never inferred (design §7: "trigger rate never inferred"). */
function renderTriggerSection(report: CapabilityReport): string {
  const { receipt, skill } = report;
  const rate = receipt.triggerRate;
  const netDelta = receipt.treatment.passed - receipt.baseline.passed;
  const isNull = netDelta === 0;
  if (!rate || rate.total === 0) {
    return (
      `No session data was captured to measure whether \`${skill}\` loaded during these runs — this reads as ` +
      'not exercised on this task set, not as evidence about the skill either way.'
    );
  }
  const low = isLowTriggerRate(rate);
  const base =
    `\`${skill}\` loaded on ${rate.triggered} of ${rate.total} solved+failed attempts` +
    (rate.unknown > 0 ? ` (${rate.unknown} unknown — session not captured)` : '') + '.';
  if (isNull && low) {
    return (
      `${base} The skill loaded on few tasks — this is a discoverability result, not a quality result: the ` +
      'agent rarely found a reason to invoke it, so this run cannot speak to whether the skill helps when it ' +
      'does load.'
    );
  }
  if (isNull) {
    return (
      `${base} The skill loaded on most tasks and still made no difference to the outcome — it was given its ` +
      'chance here and did not change results.'
    );
  }
  if (low) {
    const sign = netDelta > 0 ? '+' : '';
    return (
      `${base} That is too low a trigger rate to attribute the measured net ${sign}${netDelta}-task difference ` +
      'to the skill — it reads as not exercised on this task set, not as evidence of an effect.'
    );
  }
  return `${base} The trigger rate is high enough that the measured effect can plausibly be attributed to the skill.`;
}

/** Section 6: any conditional signal, explicitly labelled hypothesis, not
 *  finding (design §6 section 6). Omitted entirely without a caller-supplied
 *  pattern — nothing here computes one (plan work item 4: "never fabricate a
 *  pattern"). */
function renderPattern(narrative: ReportNarrative | undefined): string | null {
  const pattern = narrative?.pattern;
  if (!pattern) return null;
  const lines = [`**Hypothesis, not finding:** ${pattern.text}`];
  if (pattern.evidence) lines.push('', `> ${pattern.evidence}`);
  return lines.join('\n');
}

/** Section 7: at most three concrete edits — again caller-supplied or
 *  omitted, never invented by the renderer (design §6 section 7). */
function renderChanges(narrative: ReportNarrative | undefined): string | null {
  const changes = narrative?.changes;
  if (!changes || changes.length === 0) return null;
  return changes.slice(0, 3).map((c) => `- ${c}`).join('\n');
}

/** Section 8: one model, one agent, n tasks, one domain — and what it does
 *  not tell you. */
function renderScope(fields: ReportFields): string {
  return (
    `This measured one agent configuration — ${fields.agent} running ${fields.model} — on ${fields.n} tasks in ` +
    `the ${fields.domain} domain, one pinned skill version. It does not tell you how \`${fields.skill}\` performs ` +
    'on other domains, other agents, other models, or at a larger sample size.'
  );
}

/** Section 9: the report's own URL (when known), the exact rerun command,
 *  the per-task table's location, and the invitation to substitute a
 *  reader's own task set. */
function renderReproduce(report: CapabilityReport): string {
  const lines: string[] = [];
  if (report.links.reportUrl) lines.push(`Report: ${report.links.reportUrl}`);
  lines.push(`Rerun: \`${report.links.rerunCommand}\``);
  lines.push('Per-task outcomes: `data/per-task.md`');
  lines.push(`Raw data: ${report.links.dataPaths.join(', ')}`);
  lines.push('Substitute your own task set with the same command to check this against your own repository.');
  return lines.join('\n\n');
}

/** Section 10: revise and reply; re-measured on freshly drawn tasks not used
 *  to derive this diagnosis (design §6 section 10). */
function renderReevalOffer(fields: ReportFields): string {
  return (
    `If you revise \`${fields.skill}\` in response to this, reply and we will re-measure it — on freshly drawn ` +
    'tasks not used to derive this diagnosis, so the re-evaluation checks the change rather than fitting what ' +
    'we already showed you.'
  );
}

/** The public capability report (design §6): narrative only — the card
 *  carries the figures (capability-card.ts), and this renderer never repeats
 *  the receipt's full figure block. Eleven sections in order; §3 (cohort
 *  table), §6 (pattern), and §7 (changes) are omitted entirely, rather than
 *  rendered empty, when the caller supplied no cohort or narrative — the
 *  renderer never invents a cohort, a pattern, or a change. The null variant
 *  (§6.1 — the primary case, roughly 4 in 5 reports) is a content branch
 *  inside the title, result, and trigger sections, not a separate
 *  structure; §6.2 (degrading) stays deferred — a negative net delta falls
 *  through the same generic branch as any other non-null effect, with no
 *  degrading-specific language drafted. */
export function renderCapabilityReportMd(report: CapabilityReport): string {
  if (report.cohort) validateCohort(report.cohort);

  const sections: string[] = [`# ${renderTitle(report)}`, '', renderOpener(report.fields), ''];

  if (report.cohort) {
    sections.push('## Cohort', '', renderCohortTable(report.cohort), '');
  }

  sections.push('## Result', '', renderResult(report), '');
  sections.push('## Where it did not load', '', renderTriggerSection(report), '');

  const pattern = renderPattern(report.narrative);
  if (pattern) sections.push('## Pattern worth testing', '', pattern, '');

  const changes = renderChanges(report.narrative);
  if (changes) sections.push('## What we would change', '', changes, '');

  sections.push('## Scope', '', renderScope(report.fields), '');
  sections.push('## Reproduce', '', renderReproduce(report), '');
  sections.push('## Re-evaluation', '', renderReevalOffer(report.fields), '');

  // Footer (design §6 section 11): exactly this one line, nothing further —
  // no closing neutrality claim (design §6: a self-asserted neutrality claim
  // is the unverifiable-assertion class this product exists to replace).
  sections.push('Evaluated by [Jinn](https://jinn.network).', '');

  return sections.join('\n');
}

/** The per-task outcome table as its own markdown file (plan work item 4:
 *  "The per-task table moves into `data/` as a generated markdown file
 *  rather than the report body"). `render-report.ts` (work item 5) writes
 *  this to `data/per-task.md`; the report links to it (§9) rather than
 *  containing it. */
export function renderPerTaskTableMd(report: CapabilityReport): string {
  return [`# ${report.skill} — per-task outcomes`, '', renderPerTaskTable(report.perTask), ''].join('\n');
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
// Badge SVG (design §3 of
// docs/superpowers/specs/2026-07-31-capability-report-artifact-design.md) —
// variant C, the three-axis segmented badge:
//
//   [ jinn ][ +2 tasks ][ loads 9/12 ][ +17% cost ]
//
// Chosen over effect-only, cohort-rank-only, and letter grade because the
// paired-effect number is the rig's LEAST reliable measurement at n≈12 (wide
// interval, noisy), while trigger rate is a direct log observation and cost
// overhead is exact — a badge leading with effect alone leads with the
// weakest number. Segment 2 (effect) is tinted by sign; segments 1/3/4 stay
// neutral.
// ---------------------------------------------------------------------------

// Hex values inlined from DESIGN.json's semantic ramps — SVG cannot consume
// CSS custom properties across a `<img src>` embed context, so these five
// are the only colors this module may use anywhere in a badge.
const BADGE_PAPER = '#ffffff';
const BADGE_BORDER = '#33415c';
const BADGE_INK = '#1b2430';
/** vow-green — segment 2 text color when the net paired delta is positive. */
const BADGE_SUCCESS = '#527a70';
/** break-red — segment 2 text color when the net paired delta is negative. */
const BADGE_DANGER = '#934c4c';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface BadgeSegment {
  text: string;
  /** Tinting approach chosen (design §3 offers a choice: tint the segment
   *  fill with a light ramp stop, or tint the text): this module tints the
   *  TEXT color and keeps every segment's background paper-white. The five
   *  approved hexes above are used exactly as given — no derived "lighter
   *  ramp stop" is invented, and the background never varies, so there is
   *  nothing here that could read as a red/green pass-fail fill. */
  textFill: string;
}

/** Assembles any left-to-right run of segments into one self-contained flat
 *  SVG: a single bordered, softened-brutalist-radius box (`rx="4"`, matching
 *  DESIGN.json's `--radius-1` chip token) with a vertical divider between
 *  each segment and center-aligned monospace text. Shared by both
 *  `renderBadgeSvg` and `renderCohortRankBadgeSvg` so the two badges can
 *  never drift in markup shape. No external fonts, images, or refs — a
 *  generic `font-family` name only, never `@font-face`/an external
 *  `url()`/`xlink:href`. */
function renderSegmentedBadgeSvg(segments: BadgeSegment[], ariaLabel: string): string {
  const charWidth = 6.2;
  const padX = 8;
  const height = 20;
  const widths = segments.map((s) => Math.max(1, Math.ceil(s.text.length * charWidth)) + padX * 2);
  const width = widths.reduce((a, b) => a + b, 0);

  let x = 0;
  const textEls: string[] = [];
  const dividerEls: string[] = [];
  segments.forEach((seg, i) => {
    const w = widths[i]!;
    textEls.push(
      `<text x="${x + w / 2}" y="${height - 6}" font-family="monospace" font-size="11" ` +
      `fill="${seg.textFill}" text-anchor="middle">${escapeXml(seg.text)}</text>`,
    );
    if (i > 0) {
      dividerEls.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${BADGE_BORDER}" stroke-width="1"/>`);
    }
    x += w;
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `role="img" aria-label="${escapeXml(ariaLabel)}">`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="4" fill="${BADGE_PAPER}" ` +
    `stroke="${BADGE_BORDER}" stroke-width="1"/>`,
    ...dividerEls,
    ...textEls,
    '</svg>',
  ].join('\n') + '\n';
}

export interface BadgeOptions {
  skill: string;
  measuredOn: string;
  /** Net paired delta: `receipt.treatment.passed - receipt.baseline.passed`.
   *  Design §3: the rig's least reliable number at n≈12 — segment 2, never
   *  segment 1, and replaced outright by the low-trigger caveat below when
   *  the trigger rate can't support reading it as evidence at all. */
  netDelta: number;
  /** The same `TriggerRate` the report's receipt block was built from.
   *  `undefined` (no session-JSONL captured for this run at all) is
   *  normalized internally to `{ triggered: 0, total: 0, unknown: 0 }` — the
   *  identical "no session data" branch an explicit zero-total rate takes.
   *  This deliberately drops the old two-line badge's back-compat allowance
   *  of showing a bare effect number when no trigger data exists: the new
   *  badge always renders a dedicated loads segment, so there is no reading
   *  of "no data" for that segment that isn't itself the honest answer for
   *  segment 2 too. */
  triggerRate?: TriggerRate;
  /** `deriveCostOverhead(receipt)`'s result, passed straight through — `null`
   *  renders `cost unknown` rather than a fabricated `0`. */
  costOverhead: number | null;
}

/** Segment 2's text + tint (design §3: "Segment 2 takes the success tint
 *  when positive, the danger tint when negative, neutral at zero"), gated by
 *  the identical `isLowTriggerRate` check `renderReceiptMd` uses so the badge
 *  can never disagree with the report it points at. A low/unknown trigger
 *  rate replaces the effect number with the not-exercised caveat outright —
 *  this is the C1-class honesty invariant: a low-trigger badge must never
 *  show a clean effect number, tinted or not. */
function effectSegment(rate: TriggerRate, netDelta: number): BadgeSegment {
  if (isLowTriggerRate(rate)) {
    return { text: rate.total === 0 ? 'no session data' : 'not exercised', textFill: BADGE_INK };
  }
  if (netDelta > 0) return { text: `+${netDelta} tasks`, textFill: BADGE_SUCCESS };
  if (netDelta < 0) return { text: `${netDelta} tasks`, textFill: BADGE_DANGER };
  return { text: '0 tasks', textFill: BADGE_INK };
}

/** Segment 3, always present regardless of segment 2's low-trigger state —
 *  when segment 2 shows the not-exercised caveat, this segment carries the
 *  concrete explanation for it (`loads 1/12`, or `loads unknown` when no
 *  session data was captured at all). */
function loadsSegmentText(rate: TriggerRate): string {
  return rate.total === 0 ? 'loads unknown' : `loads ${rate.triggered}/${rate.total}`;
}

/** Segment 4 — exact cost overhead, never fabricated. `null` (from
 *  `deriveCostOverhead`, e.g. a zero/missing baseline mean) renders
 *  `cost unknown` rather than a misleading `0% cost`. */
function costSegmentText(costOverhead: number | null): string {
  if (costOverhead === null) return 'cost unknown';
  const pctValue = Math.round(costOverhead * 100);
  const sign = pctValue > 0 ? '+' : '';
  return `${sign}${pctValue}% cost`;
}

/** The three-axis capability badge (design §3, variant C):
 *  `[ jinn ][ <effect|caveat> ][ loads x/n ][ <±cost>% cost ]`. Pure — no
 *  filesystem, no network; every value is read straight from already-derived
 *  inputs (`deriveCostOverhead`, `ReceiptData.triggerRate`), never recomputed
 *  from a raw receipt here. */
export function renderBadgeSvg(opts: BadgeOptions): string {
  const rate: TriggerRate = opts.triggerRate ?? { triggered: 0, total: 0, unknown: 0 };
  const effect = effectSegment(rate, opts.netDelta);
  const loadsText = loadsSegmentText(rate);
  const costText = costSegmentText(opts.costOverhead);

  const segments: BadgeSegment[] = [
    { text: 'jinn', textFill: BADGE_INK },
    effect,
    { text: loadsText, textFill: BADGE_INK },
    { text: costText, textFill: BADGE_INK },
  ];

  const ariaLabel =
    `jinn capability badge for ${opts.skill}, measured ${opts.measuredOn}: ` +
    `${effect.text}, ${loadsText}, ${costText}`;

  return renderSegmentedBadgeSvg(segments, ariaLabel);
}

// ---------------------------------------------------------------------------
// Cohort rank badge (design §3) — ships only alongside the three-axis badge.
// ---------------------------------------------------------------------------

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** `[ jinn · <domain> ][ <rank> of <of> ]` — design §3: "Rank is a
 *  defensible ordinal claim even when magnitudes are noisy." Both segments
 *  stay neutral (ink text on paper) — a rank has no sign to tint against.
 *  `focalSkill` must match the cohort's own focal entry (`validateCohort`
 *  runs first); this is a defensive check against rendering the wrong
 *  cohort's rank badge for a given skill, not a way to select the entry.
 *
 *  IMPORTANT (design §3): this badge must NEVER be the only badge on a
 *  surface — alone, "2nd of 6" hides whether second place means +2 or -5 net
 *  tasks. Any caller assembling a delivery surface (README embed, issue
 *  body, hosted page) MUST also render `renderBadgeSvg`'s three-axis badge
 *  alongside this one, and should call `assertRankBadgeAccompanied` to
 *  enforce that at the call site rather than relying on convention. */
export function renderCohortRankBadgeSvg(cohort: Cohort, focalSkill: string): string {
  validateCohort(cohort);
  const focal = cohort.entries.find((e) => e.focal)!;
  if (focal.skill !== focalSkill) {
    throw new CohortValidationError(
      `cohort '${cohort.domain}' focal entry is '${focal.skill}', not the requested '${focalSkill}'`,
    );
  }
  const { rank, of } = cohortRank(cohort);
  const rankText = `${ordinal(rank)} of ${of}`;
  const segments: BadgeSegment[] = [
    { text: `jinn · ${cohort.domain}`, textFill: BADGE_INK },
    { text: rankText, textFill: BADGE_INK },
  ];
  const ariaLabel = `jinn cohort rank badge for ${focalSkill} in ${cohort.domain}: ${rankText}`;
  return renderSegmentedBadgeSvg(segments, ariaLabel);
}

/** Design §3's "never alone" rule as an enforceable guard rather than a
 *  convention: call this before emitting `renderCohortRankBadgeSvg`'s output
 *  anywhere (a README embed snippet, an issue body, a hosted page), passing
 *  whether the three-axis badge (`renderBadgeSvg`) is ALSO being rendered on
 *  that same surface. Throws when it is not — a bare rank badge hides
 *  whether "2nd of 6" means +2 net tasks or -5. */
export function assertRankBadgeAccompanied(hasMainBadge: boolean): void {
  if (!hasMainBadge) {
    throw new Error(
      'renderCohortRankBadgeSvg output may never be emitted without the three-axis badge ' +
      '(renderBadgeSvg) alongside it, per design §3 — a bare rank hides what the rank magnitude means.',
    );
  }
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
