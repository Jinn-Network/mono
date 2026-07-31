import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attemptKey, type BenchOutcome } from '../../src/skills-bench/attempts.js';
import {
  assertRankBadgeAccompanied, buildCapabilityReport, buildEmbedSnippet, buildReportFields, buildTaskSetIdentity,
  cohortRank, deriveConcordant, deriveCostOverhead, deriveVerdictLine, renderBadgeSvg, renderCapabilityReportMd,
  renderCohortRankBadgeSvg, renderPerTaskTableMd, validateCohort, CohortValidationError,
  type BuildCapabilityReportOptions, type Cohort, type CohortEntry, type ReportNarrative,
} from '../../src/skills-bench/capability-report.js';
import type { ReceiptData, ReceiptProfile } from '../../src/skills-bench/receipt.js';
import type { SkillPin } from '../../src/skills-bench/skill-pin.js';
import type { SkillTaskSetV1, SkillTaskV1, TaskRequirement } from '../../src/skills-bench/task-set.js';

function requirement(): TaskRequirement {
  return {
    background: 'The widget module has a bug.',
    requirement: 'Fix the widget size calculation.',
    fileOps: 'Edit src/widget.py only.',
    acceptance: 'test_widget_size.py must pass.',
  };
}

function task(id: string, over: Partial<SkillTaskV1> = {}): SkillTaskV1 {
  return {
    id,
    repo: 'org/widget-repo',
    commit: 'a'.repeat(40),
    image: 'jinn/widget-task:0001',
    requirement: requirement(),
    verifierFiles: ['verifiers/test_widget_size.py'],
    referencePatchFile: 'patches/fix.patch',
    gradeability: { status: 'pass', checkedAt: '2026-08-01T00:00:00.000Z', referenceMs: 10, emptyMs: 5, gradeLogDigest: 'd' },
    ...over,
  };
}

const taskSet: SkillTaskSetV1 = {
  version: 'skill-task-set.v1',
  skill: 'tdd',
  domain: 'python-testing',
  tasks: [task('t1'), task('t2'), task('t3')],
  sha256: 'deadbeef'.repeat(8),
  screeningSummary: {
    screenedAt: '2026-08-01T00:00:00.000Z',
    model: 'claude-haiku-4-5-20251001',
    repeats: 2,
    passThreshold: 1,
    kept: ['t1', 't2', 't3'],
    droppedNoHeadroom: ['t4'],
    droppedUngradeable: [],
  },
};

function o(id: string, arm: string, repeat: number, passed: boolean | null): BenchOutcome {
  return { instanceId: id, arm, repeat, passed, unscorable: passed === null, costUsd: 0.1 };
}

const profile: ReceiptProfile = {
  model: 'claude-haiku-4-5-20251001',
  agent: 'claude-code',
  slateSha256: taskSet.sha256,
  slateHalf: 'feedback',
  measuredOn: '2026-08-01',
};

const pin: SkillPin = {
  name: 'tdd',
  source: 'https://github.com/org/skills-repo',
  commit: 'b'.repeat(40),
  skillPath: 'skills/tdd',
  sha256: 'c'.repeat(64),
  license: 'MIT',
  repoLicense: 'MIT License',
  fetchedAt: '2026-08-01T00:00:00.000Z',
};

// t1: baseline failed, treatment resolved (improved), treatment triggered.
// t2: baseline resolved, treatment failed (regressed), triggered UNKNOWN
//     (no entry in triggerByKey — must never be read as "not triggered").
// t3: baseline resolved, treatment ungradeable — triggered must read as
//     unknown regardless of a (bogus, deliberately wrong) map entry, since an
//     ungradeable attempt was never a candidate for the trigger question.
const outcomes: BenchOutcome[] = [
  o('t1', 'baseline', 0, false), o('t1', 'tdd', 0, true),
  o('t2', 'baseline', 0, true), o('t2', 'tdd', 0, false),
  o('t3', 'baseline', 0, true), o('t3', 'tdd', 0, null),
];

const triggerByKey = new Map<string, boolean | null>([
  [attemptKey({ instanceId: 't1', arm: 'tdd', repeat: 0 }), true],
  [attemptKey({ instanceId: 't3', arm: 'tdd', repeat: 0 }), true], // bogus — t3 is ungradeable
]);

function baseOptions(): BuildCapabilityReportOptions {
  return {
    skill: 'tdd',
    outcomes,
    taskSet,
    baselineArm: 'baseline',
    treatmentArm: 'tdd',
    profile,
    pin,
    triggerByKey,
    links: { dataPaths: ['data/attempts.jsonl', 'data/bench-manifest.json', 'data/set.json'], rerunCommand: 'yarn tsx scripts/skills-bench/run-bench.ts --task-set ../bench/task-sets/tdd --model claude-haiku-4-5-20251001 --out <fresh-out-dir>' },
  };
}

describe('buildCapabilityReport', () => {
  it('builds one per-task row per task actually run, in task-set order', () => {
    const report = buildCapabilityReport(baseOptions());
    expect(report.perTask.map((r) => r.taskId)).toEqual(['t1', 't2', 't3']);
  });

  it('renders known trigger status when the map has an entry for a graded attempt', () => {
    const report = buildCapabilityReport(baseOptions());
    const t1 = report.perTask.find((r) => r.taskId === 't1')!;
    expect(t1.baseline).toEqual([{ repeat: 0, passed: false }]);
    expect(t1.treatment).toEqual([{ repeat: 0, passed: true, triggered: true }]);
  });

  it('renders triggered: null (unknown) for a graded attempt absent from the trigger map — never "false"', () => {
    const report = buildCapabilityReport(baseOptions());
    const t2 = report.perTask.find((r) => r.taskId === 't2')!;
    expect(t2.treatment).toEqual([{ repeat: 0, passed: false, triggered: null }]);
  });

  it('forces triggered: null for an ungradeable attempt even if the map has a (bogus) entry for it', () => {
    const report = buildCapabilityReport(baseOptions());
    const t3 = report.perTask.find((r) => r.taskId === 't3')!;
    expect(t3.treatment).toEqual([{ repeat: 0, passed: null, triggered: null }]);
  });

  // ---------------------------------------------------------------------------
  // I8: an eligible task with no logged outcome (e.g. every solve failed
  // before producing a gradeable patch — solveFailures, never appended to
  // attempts.jsonl) must still appear as a row, per buildPerTaskRows's own
  // doc comment. A screened-OUT task (not eligible for this run at all) must
  // NOT appear — it's already accounted for by taskSetIdentity.screening.
  // ---------------------------------------------------------------------------

  it('includes an eligible task with zero logged outcomes as a row, never silently dropped (I8)', () => {
    const withUnrun: SkillTaskSetV1 = {
      ...taskSet,
      tasks: [...taskSet.tasks, task('t4')],
      screeningSummary: { ...taskSet.screeningSummary!, kept: ['t1', 't2', 't3', 't4'], droppedNoHeadroom: [] },
    };
    const report = buildCapabilityReport({ ...baseOptions(), taskSet: withUnrun });
    const t4 = report.perTask.find((r) => r.taskId === 't4');
    expect(t4).toBeDefined();
    expect(t4!.baseline).toEqual([]);
    expect(t4!.treatment).toEqual([]);
  });

  it('excludes a screened-out (ineligible) task from the per-task table entirely (I8)', () => {
    const withScreenedOut: SkillTaskSetV1 = {
      ...taskSet,
      tasks: [...taskSet.tasks, task('t4')], // present in the set, but screened out below
    };
    // taskSet's own screeningSummary already lists 't4' in droppedNoHeadroom and NOT in kept.
    const report = buildCapabilityReport({ ...baseOptions(), taskSet: withScreenedOut });
    expect(report.perTask.some((r) => r.taskId === 't4')).toBe(false);
  });

  it('includes every task when the set has never been screened, whether or not it has outcomes', () => {
    const unscreenedWithUnrun: SkillTaskSetV1 = {
      ...taskSet,
      tasks: [...taskSet.tasks, task('t4')],
      screeningSummary: undefined,
    };
    const report = buildCapabilityReport({ ...baseOptions(), taskSet: unscreenedWithUnrun });
    expect(report.perTask.map((r) => r.taskId)).toEqual(['t1', 't2', 't3', 't4']);
  });

  // ---------------------------------------------------------------------------
  // I8 round 2 (final-review regression fix): eligibility must be RUN-scoped
  // (the manifest's own eligibleTaskIds), never re-derived from the task
  // set's authoring-time screening.kept alone — that field doesn't know
  // whether THIS run passed --include-screened-out, so a screened-out task
  // an --include-screened-out run actually measured must still get a row
  // when its real outcomes exist, and a screened-out, never-run task must
  // stay excluded when the manifest says so.
  // ---------------------------------------------------------------------------

  it('includes a screened-out task WITH real outcomes when the manifest eligibleTaskIds includes it (--include-screened-out run)', () => {
    const withScreenedOutTask: SkillTaskSetV1 = {
      ...taskSet,
      tasks: [...taskSet.tasks, task('t4')], // t4 is in droppedNoHeadroom per taskSet's screeningSummary
    };
    const outcomesWithT4 = [...outcomes, o('t4', 'baseline', 0, true), o('t4', 'tdd', 0, false)];
    const report = buildCapabilityReport({
      ...baseOptions(),
      taskSet: withScreenedOutTask,
      outcomes: outcomesWithT4,
      // this run's own manifest recorded t4 as eligible — an
      // --include-screened-out run measured it despite screening.kept never
      // having listed it.
      eligibleTaskIds: ['t1', 't2', 't3', 't4'],
    });
    const t4 = report.perTask.find((r) => r.taskId === 't4');
    expect(t4).toBeDefined();
    expect(t4!.baseline).toEqual([{ repeat: 0, passed: true }]);
    expect(t4!.treatment).toEqual([{ repeat: 0, passed: false, triggered: null }]);
  });

  it('excludes a screened-out task with no outcomes when the manifest eligibleTaskIds excludes it (normal screened run)', () => {
    const withScreenedOutTask: SkillTaskSetV1 = {
      ...taskSet,
      tasks: [...taskSet.tasks, task('t4')], // present in the set, screened out, never run
    };
    const report = buildCapabilityReport({
      ...baseOptions(),
      taskSet: withScreenedOutTask,
      eligibleTaskIds: ['t1', 't2', 't3'], // this run's manifest — t4 correctly excluded
    });
    expect(report.perTask.some((r) => r.taskId === 't4')).toBe(false);
  });

  it('prefers the manifest eligibleTaskIds over screeningSummary.kept even when they disagree', () => {
    // screeningSummary.kept says t1/t2/t3 only; the manifest (this run) says
    // t1/t2 only — the manifest must win.
    const report = buildCapabilityReport({ ...baseOptions(), eligibleTaskIds: ['t1', 't2'] });
    expect(report.perTask.map((r) => r.taskId)).toEqual(['t1', 't2']);
  });

  it('composes the task-set identity from gradeability/screening summaries', () => {
    const report = buildCapabilityReport(baseOptions());
    expect(report.taskSetIdentity).toEqual({
      sha256: taskSet.sha256,
      domain: 'python-testing',
      taskCount: 3,
      gradeability: { passing: 3, total: 3 },
      screening: { kept: 3, droppedNoHeadroom: 1, droppedUngradeable: 0 },
    });
  });

  it('omits the screening field entirely when the set was never screened', () => {
    const unscreened: SkillTaskSetV1 = { ...taskSet, screeningSummary: undefined };
    const report = buildCapabilityReport({ ...baseOptions(), taskSet: unscreened });
    expect(report.taskSetIdentity.screening).toBeUndefined();
  });

  it('computes an aggregate trigger rate over graded (passed !== null) treatment attempts only', () => {
    const report = buildCapabilityReport(baseOptions());
    // t1 known-triggered, t2 known-attempt-but-unknown-trigger (absent from
    // the map), t3 excluded entirely (ungradeable, passed === null).
    // summarizeTriggerRate's `total` counts only KNOWN (non-null) results —
    // matching receipt.ts's own convention (see receipt.test.ts).
    expect(report.receipt.triggerRate).toEqual({ triggered: 1, total: 1, unknown: 1 });
  });

  it('passes the links block through unchanged', () => {
    const report = buildCapabilityReport(baseOptions());
    expect(report.links.dataPaths).toEqual(['data/attempts.jsonl', 'data/bench-manifest.json', 'data/set.json']);
    expect(report.links.rerunCommand).toContain('run-bench.ts');
  });
});

// ---------------------------------------------------------------------------
// renderCapabilityReportMd — narrative-only report (design §6 of
// docs/superpowers/specs/2026-07-31-capability-report-artifact-design.md).
// The base fixture (`baseOptions`, via `buildCapabilityReport`) is itself a
// null effect (net 0/2 paired tasks) with a HIGH trigger rate (1/1 known) —
// it already exercises the "given its chance" null sub-case. The other
// three sub-cases (effect found + high trigger, effect found + low trigger,
// null + low trigger) get their own small fixtures below.
// ---------------------------------------------------------------------------

function pairedTaskSet(ids: string[]): SkillTaskSetV1 {
  return {
    ...taskSet,
    tasks: ids.map((id) => task(id)),
    screeningSummary: { ...taskSet.screeningSummary!, kept: ids, droppedNoHeadroom: [] },
  };
}

function allTriggered(ids: string[], value: boolean | null): Map<string, boolean | null> {
  return new Map(ids.map((id) => [attemptKey({ instanceId: id, arm: 'tdd', repeat: 0 }), value]));
}

/** Effect found, high trigger rate: ta/tb improved, tc concordant-pass, td
 *  concordant-fail — net +2 across 4 paired tasks, all 4 attempts triggered. */
function effectHighTriggerReport(over: Partial<BuildCapabilityReportOptions> = {}) {
  const ids = ['ta', 'tb', 'tc', 'td'];
  const outcomes: BenchOutcome[] = [
    o('ta', 'baseline', 0, false), o('ta', 'tdd', 0, true),
    o('tb', 'baseline', 0, false), o('tb', 'tdd', 0, true),
    o('tc', 'baseline', 0, true), o('tc', 'tdd', 0, true),
    o('td', 'baseline', 0, false), o('td', 'tdd', 0, false),
  ];
  return buildCapabilityReport({
    ...baseOptions(), taskSet: pairedTaskSet(ids), outcomes, triggerByKey: allTriggered(ids, true), ...over,
  });
}

/** Effect found (net +1), but a low (0%) trigger rate — the delta cannot be
 *  attributed to the skill. */
function effectLowTriggerReport(over: Partial<BuildCapabilityReportOptions> = {}) {
  const ids = ['ta', 'tb'];
  const outcomes: BenchOutcome[] = [
    o('ta', 'baseline', 0, false), o('ta', 'tdd', 0, true),
    o('tb', 'baseline', 0, true), o('tb', 'tdd', 0, true),
  ];
  return buildCapabilityReport({
    ...baseOptions(), taskSet: pairedTaskSet(ids), outcomes, triggerByKey: allTriggered(ids, false), ...over,
  });
}

/** Null effect (net 0), low (0%) trigger rate — the discoverability case. */
function nullLowTriggerReport(over: Partial<BuildCapabilityReportOptions> = {}) {
  const ids = ['ta', 'tb'];
  const outcomes: BenchOutcome[] = [
    o('ta', 'baseline', 0, false), o('ta', 'tdd', 0, true),
    o('tb', 'baseline', 0, true), o('tb', 'tdd', 0, false),
  ];
  return buildCapabilityReport({
    ...baseOptions(), taskSet: pairedTaskSet(ids), outcomes, triggerByKey: allTriggered(ids, false), ...over,
  });
}

/** Nothing graded at all — every treatment attempt ungradeable, so
 *  `triggerRate.total` is 0 (never fabricated as a rate). */
function noSessionDataReport(over: Partial<BuildCapabilityReportOptions> = {}) {
  const ids = ['ta'];
  const outcomes: BenchOutcome[] = [o('ta', 'baseline', 0, true), o('ta', 'tdd', 0, null)];
  return buildCapabilityReport({
    ...baseOptions(), taskSet: pairedTaskSet(ids), outcomes, triggerByKey: new Map(), ...over,
  });
}

function focalCohort(over: Partial<Cohort> = {}): Cohort {
  return {
    domain: 'python-testing',
    entries: [
      cohortEntry({ skill: 'tdd', focal: true, netTasks: 2 }),
      cohortEntry({ skill: 'other-skill', netTasks: 1 }),
    ],
    ...over,
  };
}

describe('renderCapabilityReportMd', () => {
  // -------------------------------------------------------------------------
  // Section order — design §6's eleven sections, in order, for the effect
  // case (with a cohort and a full narrative supplied so every optional
  // section is present).
  // -------------------------------------------------------------------------

  it('renders all eleven sections in design §6 order for the effect case', () => {
    const narrative: ReportNarrative = {
      pattern: { text: 'Tasks with multi-file diffs seem to trigger the skill more often.', evidence: 'assistant#12: Skill(tdd) invoked after viewing 3 files' },
      changes: ['Broaden the trigger description', 'Add a worked example for multi-file edits'],
    };
    const report = { ...effectHighTriggerReport(), cohort: focalCohort(), narrative };
    const md = renderCapabilityReportMd(report);

    const markers = [
      '# tdd —',
      'independent capability measurement',
      '## Cohort',
      '## Result',
      '## Where it did not load',
      '## Pattern worth testing',
      '## What we would change',
      '## Scope',
      '## Reproduce',
      '## Re-evaluation',
      'Evaluated by [Jinn](https://jinn.network).',
    ];
    const indices = markers.map((m) => md.indexOf(m));
    for (const idx of indices) expect(idx).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < indices.length; i++) expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
  });

  // -------------------------------------------------------------------------
  // Title
  // -------------------------------------------------------------------------

  it('leads the title with the effect, not a diagnosis, when a real net effect was measured', () => {
    const md = renderCapabilityReportMd(effectHighTriggerReport());
    expect(md).toContain('# tdd — net +2 tasks with skill loaded');
  });

  it('leads the title with cohort position when a cohort is supplied', () => {
    const md = renderCapabilityReportMd({ ...effectHighTriggerReport(), cohort: focalCohort() });
    expect(md.split('\n')[0]).toContain('1st of 2 in python-testing');
  });

  // -------------------------------------------------------------------------
  // Null variant (§6.1) — the primary case. Title leads with the diagnosis,
  // never the zero; base rate is cited; discoverability framing when
  // trigger is low; "given its chance" framing when trigger is high.
  // -------------------------------------------------------------------------

  describe('null variant (§6.1)', () => {
    it('leads the title with the diagnosis, not the zero, citing the measured trigger rate', () => {
      const md = renderCapabilityReportMd(nullLowTriggerReport());
      expect(md).toContain('# tdd — measured, no effect found (trigger rate 0/2)');
      expect(md).not.toMatch(/# tdd — net 0/);
    });

    it('cites the base rate so a null reads as the normal result, not a verdict', () => {
      const md = renderCapabilityReportMd(nullLowTriggerReport());
      expect(md).toContain('SWE-Skills-Bench, 39 of 49');
      expect(md).toContain('arXiv 2603.15401');
    });

    it('frames a low trigger rate as a discoverability result, not a quality result, in those words', () => {
      const md = renderCapabilityReportMd(nullLowTriggerReport());
      expect(md).toMatch(/discoverability result, not a quality result/);
    });

    it('says the skill was given its chance, unsoftened, when trigger rate is high and effect is null', () => {
      // baseOptions() itself is net 0 with a 1/1 (100%) trigger rate.
      const md = renderCapabilityReportMd(buildCapabilityReport(baseOptions()));
      expect(md).toContain('# tdd — measured, no effect found (trigger rate 1/1)');
      expect(md).toMatch(/given its chance here and did not change results/);
    });

    it('never fabricates a trigger reading when no session data was captured at all', () => {
      const md = renderCapabilityReportMd(noSessionDataReport());
      expect(md).toContain('# tdd — measured, no effect found (no session data)');
      expect(md).toContain('No session data was captured to measure whether `tdd` loaded');
    });
  });

  // -------------------------------------------------------------------------
  // Result in words (§4) — paired outcome stated plainly, concordant counts
  // from deriveConcordant, intervals shown.
  // -------------------------------------------------------------------------

  it('states the paired outcome in plain words using the concordant split, with intervals shown', () => {
    const md = renderCapabilityReportMd(effectHighTriggerReport());
    expect(md).toMatch(/solved 2 task\(s\) the baseline missed and missed 0 the baseline solved/);
    expect(md).toMatch(/agreed on 1 pass and 1 fail/);
    expect(md).toMatch(/95% Wilson \d+%-\d+%/);
  });

  // -------------------------------------------------------------------------
  // Where it did not load (§5) — the trigger-rate diagnosis, gated on the
  // measured rate only.
  // -------------------------------------------------------------------------

  it('reads the low trigger rate as not-attributable when an effect was measured but rarely triggered', () => {
    const md = renderCapabilityReportMd(effectLowTriggerReport());
    expect(md).toMatch(/too low a trigger rate to attribute the measured net \+1-task difference/);
  });

  it('reads a high trigger rate as supporting the measured effect', () => {
    const md = renderCapabilityReportMd(effectHighTriggerReport());
    expect(md).toMatch(/trigger rate is high enough that the measured effect can plausibly be attributed/);
  });

  // -------------------------------------------------------------------------
  // Cohort table (§3) — omitted without a cohort; installs column only with
  // provenance.
  // -------------------------------------------------------------------------

  it('omits the cohort section entirely when no cohort was supplied', () => {
    const md = renderCapabilityReportMd(effectHighTriggerReport());
    expect(md).not.toContain('## Cohort');
  });

  it('renders one row per cohort entry, bolding the focal skill, when a cohort is supplied', () => {
    const md = renderCapabilityReportMd({ ...effectHighTriggerReport(), cohort: focalCohort() });
    expect(md).toContain('## Cohort');
    expect(md).toContain('| **tdd** |');
    expect(md).toContain('| other-skill |');
  });

  it('omits the installs column when no cohort entry carries provenance', () => {
    const md = renderCapabilityReportMd({ ...effectHighTriggerReport(), cohort: focalCohort() });
    const cohortSection = md.slice(md.indexOf('## Cohort'), md.indexOf('## Result'));
    expect(cohortSection).not.toContain('installs');
  });

  it('renders the installs column, with source and date, only for entries carrying provenance', () => {
    const cohort: Cohort = {
      domain: 'python-testing',
      entries: [
        cohortEntry({ skill: 'tdd', focal: true, netTasks: 2, installs: { count: 1200, source: 'npm', asOf: '2026-07-01' } }),
        cohortEntry({ skill: 'other-skill', netTasks: 1 }),
      ],
    };
    const md = renderCapabilityReportMd({ ...effectHighTriggerReport(), cohort });
    const cohortSection = md.slice(md.indexOf('## Cohort'), md.indexOf('## Result'));
    expect(cohortSection).toContain('| skill | installs | loaded on | net tasks | cost vs baseline |');
    expect(cohortSection).toContain('1200 (npm, 2026-07-01)');
    expect(cohortSection).toContain('| other-skill | — |');
  });

  // -------------------------------------------------------------------------
  // Pattern worth testing (§6) / What we would change (§7) — caller-supplied
  // only, never invented; pattern always labelled hypothesis.
  // -------------------------------------------------------------------------

  it('omits pattern and changes sections entirely when no narrative was supplied', () => {
    const md = renderCapabilityReportMd(effectHighTriggerReport());
    expect(md).not.toContain('## Pattern worth testing');
    expect(md).not.toContain('## What we would change');
  });

  it('labels a supplied pattern as hypothesis, not finding, with its evidence', () => {
    const narrative: ReportNarrative = {
      pattern: { text: 'Multi-file tasks seem to trigger the skill more often.', evidence: 'assistant#12: Skill(tdd) invoked' },
    };
    const md = renderCapabilityReportMd({ ...effectHighTriggerReport(), narrative });
    expect(md).toContain('## Pattern worth testing');
    expect(md).toContain('**Hypothesis, not finding:** Multi-file tasks seem to trigger the skill more often.');
    expect(md).toContain('> assistant#12: Skill(tdd) invoked');
  });

  it('renders at most three suggested changes, even when more are supplied', () => {
    const narrative: ReportNarrative = { changes: ['edit one', 'edit two', 'edit three', 'edit four'] };
    const md = renderCapabilityReportMd({ ...effectHighTriggerReport(), narrative });
    expect(md).toContain('- edit one');
    expect(md).toContain('- edit two');
    expect(md).toContain('- edit three');
    expect(md).not.toContain('edit four');
  });

  // -------------------------------------------------------------------------
  // Scope (§8), Reproduce (§9), Re-evaluation (§10), Footer (§11)
  // -------------------------------------------------------------------------

  it('states scope — one model, one agent, n tasks, one domain — and what it does not tell you', () => {
    const md = renderCapabilityReportMd(effectHighTriggerReport());
    expect(md).toContain('one agent configuration — claude-code running claude-haiku-4-5-20251001');
    expect(md).toContain('4 tasks in the python-testing domain');
    expect(md).toMatch(/does not tell you how `tdd` performs on other domains/);
  });

  it('links the rerun command, the per-task table, and the raw data, inviting substitution', () => {
    const md = renderCapabilityReportMd(effectHighTriggerReport());
    expect(md).toContain('Rerun: `yarn tsx scripts/skills-bench/run-bench.ts');
    expect(md).toContain('Per-task outcomes: `data/per-task.md`');
    expect(md).toContain('Raw data: data/attempts.jsonl, data/bench-manifest.json, data/set.json');
    expect(md).toMatch(/Substitute your own task set/);
  });

  it('offers re-evaluation on freshly drawn tasks not used to derive this diagnosis', () => {
    const md = renderCapabilityReportMd(effectHighTriggerReport());
    expect(md).toMatch(/we will re-measure it — on freshly drawn tasks not used to derive this diagnosis/);
  });

  it('ends with exactly the footer line and nothing further — no closing neutrality claim', () => {
    const md = renderCapabilityReportMd(effectHighTriggerReport());
    const trimmed = md.trimEnd();
    expect(trimmed.endsWith('Evaluated by [Jinn](https://jinn.network).')).toBe(true);
    expect(md).not.toMatch(/we don'?t (publish|sell)/i);
    expect(md).not.toMatch(/we are neutral|no bias/i);
  });

  // -------------------------------------------------------------------------
  // Claim discipline (design §7) — enforced across every scenario.
  // -------------------------------------------------------------------------

  it('never uses significance language, in any scenario', () => {
    for (const report of [
      effectHighTriggerReport(), effectLowTriggerReport(), nullLowTriggerReport(),
      noSessionDataReport(), buildCapabilityReport(baseOptions()),
    ]) {
      expect(renderCapabilityReportMd(report)).not.toMatch(/significan/i);
    }
  });

  it('no longer contains the full receipt figure block (renderReceiptMd\'s fenced ascii block)', () => {
    const md = renderCapabilityReportMd(buildCapabilityReport(baseOptions()));
    expect(md).not.toContain('skill:      tdd');
    expect(md).not.toMatch(/```\nskill:/);
  });

  it('does not embed the per-task table in the report body', () => {
    const md = renderCapabilityReportMd(buildCapabilityReport(baseOptions()));
    expect(md).not.toContain('| task | baseline | with skill | triggered |');
    expect(md).not.toContain('| t1 | not resolved | resolved | yes |');
  });
});

describe('renderPerTaskTableMd', () => {
  it('renders the per-task outcome table as its own markdown document, separate from the report body', () => {
    const report = buildCapabilityReport(baseOptions());
    const md = renderPerTaskTableMd(report);
    expect(md).toContain('# tdd — per-task outcomes');
    expect(md).toContain('| task | baseline | with skill | triggered |');
    expect(md).toContain('| t1 | not resolved | resolved | yes |');
    expect(md).toContain('| t2 | resolved | not resolved | unknown |');
    expect(md).toContain('| t3 | resolved | ungradeable | unknown |');
  });

  it('renders a plain placeholder, never a broken table, when there are no per-task rows', () => {
    const emptySet: SkillTaskSetV1 = { ...taskSet, tasks: [] };
    const report = buildCapabilityReport({ ...baseOptions(), taskSet: emptySet, outcomes: [] });
    const md = renderPerTaskTableMd(report);
    expect(md).toContain('_No per-task outcomes recorded._');
  });
});

describe('deriveVerdictLine', () => {
  it('renders a plain net-delta line with no pass/fail judgment language', () => {
    const report = buildCapabilityReport(baseOptions());
    const line = deriveVerdictLine(report.receipt);
    expect(line).toMatch(/^net [+-]?\d+\/\d+ paired tasks vs\. baseline$/);
    expect(line).not.toMatch(/pass|fail/i);
  });
});

// ---------------------------------------------------------------------------
// Badge SVG — well-formedness checked with a small hand-rolled tag-balance
// scanner rather than an external XML/DOM library, so this test carries no
// dependency beyond what capability-report.ts itself needs.
// ---------------------------------------------------------------------------

function assertWellFormedXmlTags(xml: string): void {
  expect(xml.trimStart().startsWith('<svg')).toBe(true);
  expect(xml.trimEnd().endsWith('</svg>')).toBe(true);
  const tagRe = /<\/?[^!?][^>]*>/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml))) {
    const tag = match[0];
    const selfClosing = /\/>$/.test(tag);
    const closing = tag.startsWith('</');
    const nameMatch = tag.match(/^<\/?\s*([A-Za-z][A-Za-z0-9:_-]*)/);
    if (!nameMatch) throw new Error(`unparseable tag: ${tag}`);
    const name = nameMatch[1]!;
    if (closing) {
      const top = stack.pop();
      if (top !== name) throw new Error(`mismatched closing tag </${name}> (expected </${top ?? '<empty>'}>)`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  expect(stack).toEqual([]);
}

// ---------------------------------------------------------------------------
// Shared badge-hygiene assertions (design §3 + repo-wide non-negotiables):
// no network-fetching refs, no emoji, no gradients, no letter grades, no
// pass/fail wording. Applied to both the three-axis badge and the cohort
// rank badge.
// ---------------------------------------------------------------------------

function assertNoExternalRefs(svg: string): void {
  // Only the standard SVG xmlns namespace URI (a declaration, never a
  // network fetch) and same-document "#id" refs are allowed.
  expect(svg).not.toMatch(/<image/);
  expect(svg).not.toMatch(/xlink:href/);
  expect(svg).not.toMatch(/@import/);
  expect(svg).not.toMatch(/url\(\s*['"]?https?:/);
  expect(svg).not.toMatch(/<link/);
}

function assertNoBannedContent(svg: string): void {
  expect(svg).not.toMatch(/\bpass\b|\bfail\b/i);
  expect(svg).not.toMatch(/\bgrade\b/i);
  expect(svg).not.toMatch(/gradient/i);
  // eslint-disable-next-line no-misleading-character-class -- emoji ranges, intentional
  expect(svg).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
}

const APPROVED_BADGE_HEXES = ['#ffffff', '#33415c', '#1b2430', '#527a70', '#934c4c'];

function assertOnlyApprovedHexes(svg: string): void {
  const found = svg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  for (const hex of found) {
    expect(APPROVED_BADGE_HEXES).toContain(hex.toLowerCase());
  }
}

describe('renderBadgeSvg', () => {
  function badge(over: Partial<Parameters<typeof renderBadgeSvg>[0]> = {}) {
    return renderBadgeSvg({
      skill: 'tdd', measuredOn: '2026-08-01', netDelta: 2,
      triggerRate: { triggered: 9, total: 12, unknown: 0 }, costOverhead: 0.17,
      ...over,
    });
  }

  it('is well-formed, has no external refs, and contains all four segments', () => {
    const svg = badge();
    assertWellFormedXmlTags(svg);
    assertNoExternalRefs(svg);
    expect(svg).toContain('jinn');
    expect(svg).toContain('+2 tasks');
    expect(svg).toContain('loads 9/12');
    expect(svg).toContain('+17% cost');
  });

  it('never uses emoji, gradients, letter grades, or pass/fail wording', () => {
    assertNoBannedContent(badge());
  });

  it('uses only the five approved hexes', () => {
    assertOnlyApprovedHexes(badge());
  });

  it('mentions every segment in the aria-label', () => {
    const svg = badge();
    const label = svg.match(/aria-label="([^"]*)"/)?.[1] ?? '';
    expect(label).toContain('tdd');
    expect(label).toContain('+2 tasks');
    expect(label).toContain('loads 9/12');
    expect(label).toContain('+17% cost');
  });

  it('escapes XML-special characters in the skill name', () => {
    const svg = badge({ skill: '<tdd & "co">' });
    assertWellFormedXmlTags(svg);
    expect(svg).toContain('&lt;tdd &amp; &quot;co&quot;&gt;');
  });

  // ---------------------------------------------------------------------------
  // Segment 2 tinting — success/danger/neutral by sign, approved hexes only.
  // ---------------------------------------------------------------------------

  it('tints the effect segment success (vow-green) when the net delta is positive', () => {
    const svg = badge({ netDelta: 2 });
    expect(svg).toContain('fill="#527a70"');
    expect(svg).not.toContain('fill="#934c4c"');
  });

  it('tints the effect segment danger (break-red) when the net delta is negative', () => {
    const svg = badge({ netDelta: -3 });
    expect(svg).toContain('-3 tasks');
    expect(svg).toContain('fill="#934c4c"');
    expect(svg).not.toContain('fill="#527a70"');
  });

  it('tints the effect segment neutral (ink) when the net delta is zero', () => {
    const svg = badge({ netDelta: 0 });
    expect(svg).toContain('0 tasks');
    expect(svg).not.toContain('fill="#527a70"');
    expect(svg).not.toContain('fill="#934c4c"');
  });

  // ---------------------------------------------------------------------------
  // C1-class honesty invariant, carried forward into the segmented shape: a
  // low-trigger badge must NEVER show a clean effect number — segment 2
  // renders the not-exercised caveat instead, and segment 3 (loads) carries
  // the concrete explanation.
  // ---------------------------------------------------------------------------

  it('renders the not-exercised caveat instead of the effect number when trigger rate is low', () => {
    const svg = badge({ netDelta: 2, triggerRate: { triggered: 1, total: 12, unknown: 0 } }); // ~8%
    expect(svg).toContain('not exercised');
    expect(svg).toContain('loads 1/12');
    expect(svg).not.toContain('+2 tasks');
    expect(svg).not.toContain('fill="#527a70"');
    expect(svg).not.toContain('fill="#934c4c"');
  });

  it('renders "no session data" for the effect segment and "loads unknown" for the loads segment when total is 0', () => {
    const svg = badge({ netDelta: 2, triggerRate: { triggered: 0, total: 0, unknown: 4 } });
    expect(svg).toContain('no session data');
    expect(svg).toContain('loads unknown');
    expect(svg).not.toContain('+2 tasks');
  });

  it('treats a missing triggerRate the same as "no session data" — never a bare effect number', () => {
    const svg = badge({ netDelta: 2, triggerRate: undefined });
    expect(svg).toContain('no session data');
    expect(svg).toContain('loads unknown');
    expect(svg).not.toContain('+2 tasks');
  });

  it('renders the bare effect number unchanged when the trigger rate is normal (high)', () => {
    const svg = badge({ netDelta: 2, triggerRate: { triggered: 9, total: 12, unknown: 0 } }); // 75%
    expect(svg).toContain('+2 tasks');
    expect(svg).toContain('loads 9/12');
    expect(svg).not.toContain('not exercised');
    expect(svg).not.toContain('no session data');
  });

  // ---------------------------------------------------------------------------
  // Cost segment — exact, never fabricated.
  // ---------------------------------------------------------------------------

  it('renders a positive cost overhead as "+N% cost"', () => {
    expect(badge({ costOverhead: 0.17 })).toContain('+17% cost');
  });

  it('renders a negative cost overhead as "-N% cost"', () => {
    expect(badge({ costOverhead: -0.04 })).toContain('-4% cost');
  });

  it('renders "cost unknown" rather than a fabricated 0% when costOverhead is null', () => {
    const svg = badge({ costOverhead: null });
    expect(svg).toContain('cost unknown');
    expect(svg).not.toContain('0% cost');
  });
});

// ---------------------------------------------------------------------------
// Cohort rank badge
// ---------------------------------------------------------------------------

function rankCohort(over: Partial<Cohort> = {}): Cohort {
  return {
    domain: 'python-testing',
    entries: [
      cohortEntry({ skill: 'a', netTasks: 5 }),
      cohortEntry({ skill: 'tdd', netTasks: 3, focal: true }),
      cohortEntry({ skill: 'c', netTasks: 1 }),
      cohortEntry({ skill: 'd', netTasks: 0 }),
      cohortEntry({ skill: 'e', netTasks: -1 }),
      cohortEntry({ skill: 'f', netTasks: -4 }),
    ],
    ...over,
  };
}

describe('renderCohortRankBadgeSvg', () => {
  it('renders `[ jinn · <domain> ][ <rank> of <of> ]`, well-formed and with no external refs', () => {
    const svg = renderCohortRankBadgeSvg(rankCohort(), 'tdd');
    assertWellFormedXmlTags(svg);
    assertNoExternalRefs(svg);
    assertNoBannedContent(svg);
    assertOnlyApprovedHexes(svg);
    expect(svg).toContain('jinn · python-testing');
    expect(svg).toContain('2nd of 6');
  });

  it('mentions the skill, domain, and rank in the aria-label', () => {
    const svg = renderCohortRankBadgeSvg(rankCohort(), 'tdd');
    const label = svg.match(/aria-label="([^"]*)"/)?.[1] ?? '';
    expect(label).toContain('tdd');
    expect(label).toContain('python-testing');
    expect(label).toContain('2nd of 6');
  });

  it.each([
    [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'],
    [11, '11th'], [12, '12th'], [13, '13th'],
    [21, '21st'], [22, '22nd'], [23, '23rd'], [24, '24th'],
    [101, '101st'], [111, '111th'],
  ])('renders the correct ordinal suffix for rank %i (%s)', (rank, expected) => {
    // Build a cohort whose focal entry lands at exactly `rank` by giving
    // (rank - 1) distinct entries a strictly higher netTasks.
    const entries: CohortEntry[] = [];
    for (let i = 0; i < rank - 1; i++) entries.push(cohortEntry({ skill: `above-${i}`, netTasks: 1000 - i }));
    entries.push(cohortEntry({ skill: 'focal-skill', netTasks: 0, focal: true }));
    const svg = renderCohortRankBadgeSvg({ domain: 'd', entries }, 'focal-skill');
    expect(svg).toContain(`${expected} of ${rank}`);
  });

  it('throws when focalSkill does not match the cohort\'s own focal entry', () => {
    expect(() => renderCohortRankBadgeSvg(rankCohort(), 'not-the-focal-skill')).toThrow(CohortValidationError);
  });

  it('throws (via validateCohort) on a cohort with no focal entry', () => {
    const cohort: Cohort = { domain: 'd', entries: [cohortEntry({ skill: 'a' }), cohortEntry({ skill: 'b' })] };
    expect(() => renderCohortRankBadgeSvg(cohort, 'a')).toThrow(CohortValidationError);
  });
});

describe('assertRankBadgeAccompanied', () => {
  it('does not throw when the main badge is also being rendered', () => {
    expect(() => assertRankBadgeAccompanied(true)).not.toThrow();
  });

  it('throws when the rank badge would be the only badge on the surface (design §3)', () => {
    expect(() => assertRankBadgeAccompanied(false)).toThrow(/never be emitted without the three-axis badge/i);
  });
});

// ---------------------------------------------------------------------------
// Embed snippet
// ---------------------------------------------------------------------------

describe('buildEmbedSnippet', () => {
  it('contains the badge image link, the report URL, and the jinn.* metadata keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'embed-'));
    const reportFilePath = join(dir, 'report.md');
    await writeFile(reportFilePath, 'report contents\n');

    const snippet = await buildEmbedSnippet({
      skill: 'tdd',
      reportUrl: 'https://github.com/Jinn-Network/skills-eval/blob/main/reports/tdd@abc123/report.md',
      badgeUrl: 'https://github.com/Jinn-Network/skills-eval/blob/main/reports/tdd@abc123/badge.svg',
      measuredOn: '2026-08-01',
      reportFilePath,
    });

    expect(snippet).toContain('https://github.com/Jinn-Network/skills-eval/blob/main/reports/tdd@abc123/report.md');
    expect(snippet).toContain('https://github.com/Jinn-Network/skills-eval/blob/main/reports/tdd@abc123/badge.svg');
    expect(snippet).toContain('jinn.receipt:');
    expect(snippet).toContain('jinn.receipt-sha256:');
    expect(snippet).toContain('jinn.measured-on: "2026-08-01"');
    expect(snippet).not.toContain('jinn.forked-from');
  });
});

// ---------------------------------------------------------------------------
// buildReportFields — field-contract composition (design §2)
// ---------------------------------------------------------------------------

describe('buildReportFields', () => {
  it('composes every field from its named source (pin, profile, taskSetIdentity, receipt)', () => {
    const report = buildCapabilityReport(baseOptions());
    const fields = buildReportFields({
      pin, profile, taskSetIdentity: buildTaskSetIdentity(taskSet), receipt: report.receipt,
    });
    expect(fields.skill).toBe('tdd');
    expect(fields.skillSha256).toBe(pin.sha256);
    expect(fields.skillSource).toBe(`${pin.source}@${pin.commit}`);
    expect(fields.license).toBe('MIT');
    expect(fields.repoLicense).toBe('MIT License');
    expect(fields.model).toBe(profile.model);
    expect(fields.agent).toBe(profile.agent);
    expect(fields.measuredOn).toBe('2026-08-01');
    expect(fields.taskSetSha256).toBe(taskSet.sha256);
    expect(fields.sourceKind).toBe('slate'); // profile.identityKind absent -> default
    expect(fields.domain).toBe('python-testing');
    expect(fields.taskCount).toBe(3);
    expect(fields.gradeability).toEqual({ passing: 3, total: 3 });
    expect(fields.screening).toEqual({ kept: 3, droppedNoHeadroom: 1, droppedUngradeable: 0 });
    expect(fields.n).toBe(report.receipt.n);
    expect(fields.excluded).toBe(report.receipt.excluded);
    expect(fields.baseline).toEqual(report.receipt.baseline);
    expect(fields.treatment).toEqual(report.receipt.treatment);
    expect(fields.improved).toBe(report.receipt.paired.improved);
    expect(fields.regressed).toBe(report.receipt.paired.regressed);
    expect(fields.meanCostUsd).toEqual(report.receipt.meanCostUsd);
    expect(fields.triggerRate).toEqual(report.receipt.triggerRate);
  });

  it('reads sourceKind from profile.identityKind when present, defaults to "slate" otherwise', () => {
    const report = buildCapabilityReport(baseOptions());
    const withKind = buildReportFields({
      pin, profile: { ...profile, identityKind: 'task-set' },
      taskSetIdentity: buildTaskSetIdentity(taskSet), receipt: report.receipt,
    });
    expect(withKind.sourceKind).toBe('task-set');
  });

  it('omits the screening field when the task set was never screened', () => {
    const report = buildCapabilityReport(baseOptions());
    const unscreenedIdentity = buildTaskSetIdentity({ ...taskSet, screeningSummary: undefined });
    const fields = buildReportFields({ pin, profile, taskSetIdentity: unscreenedIdentity, receipt: report.receipt });
    expect(fields.screening).toBeUndefined();
  });

  it('states discrimination provenance truthfully when screeningSummary is present — claims screening', () => {
    const report = buildCapabilityReport(baseOptions());
    expect(report.fields.discriminationProvenance).toMatch(/screened baseline-only/);
    expect(report.fields.discriminationProvenance).toContain('kept 3');
    expect(report.fields.discriminationProvenance).toMatch(/fails? .*unaided/);
  });

  it('never claims screening in discrimination provenance when screeningSummary is absent', () => {
    const unscreened: SkillTaskSetV1 = { ...taskSet, screeningSummary: undefined };
    const report = buildCapabilityReport({ ...baseOptions(), taskSet: unscreened });
    expect(report.fields.discriminationProvenance).not.toMatch(/screened baseline-only/);
    expect(report.fields.discriminationProvenance).toMatch(/has not been through/);
  });
});

describe('buildCapabilityReport — fields and cohort passthrough', () => {
  it('attaches a fully composed fields block, threading the new pin input through', () => {
    const report = buildCapabilityReport(baseOptions());
    expect(report.fields.skill).toBe('tdd');
    expect(report.fields.skillSha256).toBe(pin.sha256);
    expect(report.fields.skillSource).toBe(`${pin.source}@${pin.commit}`);
  });

  it('omits cohort when none was supplied (cohort assembly stays deferred)', () => {
    const report = buildCapabilityReport(baseOptions());
    expect(report.cohort).toBeUndefined();
  });

  it('passes a supplied cohort through unchanged — buildCapabilityReport never computes one', () => {
    const cohort: Cohort = {
      domain: 'python-testing',
      entries: [
        { skill: 'tdd', skillSha: pin.sha256, triggered: 8, total: 12, netTasks: 2, costRatio: 1.1, focal: true },
      ],
    };
    const report = buildCapabilityReport({ ...baseOptions(), cohort });
    expect(report.cohort).toEqual(cohort);
  });
});

// ---------------------------------------------------------------------------
// Derived-never-stored helpers
// ---------------------------------------------------------------------------

describe('deriveConcordant', () => {
  it('reads bothPassed/bothFailed straight from PairedComparison — no concordant pairs in the base fixture', () => {
    // t1 improved, t2 regressed, t3 excluded (ungradeable) — none of the base
    // fixture's tasks are a both-arms-agreed pair.
    const report = buildCapabilityReport(baseOptions());
    expect(deriveConcordant(report.receipt)).toEqual({ bothPassed: 0, bothFailed: 0 });
  });

  it('counts a genuinely concordant pair correctly, both-passed and both-failed', () => {
    const moreOutcomes: BenchOutcome[] = [
      ...outcomes,
      o('t5', 'baseline', 0, true), o('t5', 'tdd', 0, true), // both passed
      o('t6', 'baseline', 0, false), o('t6', 'tdd', 0, false), // both failed
    ];
    const withMore: SkillTaskSetV1 = {
      ...taskSet,
      tasks: [...taskSet.tasks, task('t5'), task('t6')],
      screeningSummary: { ...taskSet.screeningSummary!, kept: ['t1', 't2', 't3', 't5', 't6'], droppedNoHeadroom: [] },
    };
    const report = buildCapabilityReport({ ...baseOptions(), taskSet: withMore, outcomes: moreOutcomes });
    expect(deriveConcordant(report.receipt)).toEqual({ bothPassed: 1, bothFailed: 1 });
  });
});

function fakeReceipt(meanCostUsd: { baseline: number; treatment: number } | undefined): ReceiptData {
  return {
    profile,
    baselineArm: 'baseline',
    treatmentArm: 'tdd',
    n: 0,
    excluded: 0,
    baseline: { passed: 0, scorable: 0, lo: 0, hi: 0 },
    treatment: { passed: 0, scorable: 0, lo: 0, hi: 0 },
    paired: { pairs: 0, improved: 0, regressed: 0, concordantPass: 0, concordantFail: 0, excluded: 0, pValue: 1, verdict: 'within-noise' },
    meanCostUsd: meanCostUsd as unknown as { baseline: number; treatment: number },
  };
}

describe('deriveCostOverhead', () => {
  it('computes treatment/baseline - 1 when baseline is nonzero', () => {
    expect(deriveCostOverhead(fakeReceipt({ baseline: 1, treatment: 1.5 }))).toBeCloseTo(0.5);
  });

  it('returns null, never Infinity, when baseline mean is zero', () => {
    expect(deriveCostOverhead(fakeReceipt({ baseline: 0, treatment: 1.5 }))).toBeNull();
  });

  it('returns null, never a fabricated 0, when meanCostUsd is missing entirely', () => {
    expect(deriveCostOverhead(fakeReceipt(undefined))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cohort data model — validation and rank
// ---------------------------------------------------------------------------

function cohortEntry(over: Partial<CohortEntry> = {}): CohortEntry {
  return { skill: 'tdd', skillSha: 'a'.repeat(64), triggered: 5, total: 10, netTasks: 1, costRatio: 1.0, focal: false, ...over };
}

describe('validateCohort', () => {
  it('accepts a cohort with exactly one focal entry and unique skill names', () => {
    const cohort: Cohort = {
      domain: 'python-testing',
      entries: [cohortEntry({ skill: 'tdd', focal: true }), cohortEntry({ skill: 'other-skill' })],
    };
    expect(() => validateCohort(cohort)).not.toThrow();
  });

  it('rejects an empty cohort', () => {
    expect(() => validateCohort({ domain: 'python-testing', entries: [] })).toThrow(CohortValidationError);
  });

  it('rejects a cohort with no focal entry', () => {
    const cohort: Cohort = {
      domain: 'python-testing',
      entries: [cohortEntry({ skill: 'a' }), cohortEntry({ skill: 'b' })],
    };
    expect(() => validateCohort(cohort)).toThrow(/no focal entry/);
  });

  it('rejects a cohort with more than one focal entry', () => {
    const cohort: Cohort = {
      domain: 'python-testing',
      entries: [cohortEntry({ skill: 'a', focal: true }), cohortEntry({ skill: 'b', focal: true })],
    };
    expect(() => validateCohort(cohort)).toThrow(/2 focal entries/);
  });

  it('rejects a cohort with a duplicated skill name', () => {
    const cohort: Cohort = {
      domain: 'python-testing',
      entries: [cohortEntry({ skill: 'tdd', focal: true }), cohortEntry({ skill: 'tdd' })],
    };
    expect(() => validateCohort(cohort)).toThrow(/duplicate skill/);
  });
});

describe('cohortRank', () => {
  it('ranks the focal entry by netTasks descending', () => {
    const cohort: Cohort = {
      domain: 'python-testing',
      entries: [
        cohortEntry({ skill: 'a', netTasks: 5 }),
        cohortEntry({ skill: 'tdd', netTasks: 3, focal: true }),
        cohortEntry({ skill: 'c', netTasks: 1 }),
      ],
    };
    expect(cohortRank(cohort)).toEqual({ rank: 2, of: 3 });
  });

  it('gives tied entries the shared, better rank — a competition (1-2-2-4) ranking, not a dense one', () => {
    const cohort: Cohort = {
      domain: 'python-testing',
      entries: [
        cohortEntry({ skill: 'a', netTasks: 5 }),
        cohortEntry({ skill: 'tdd', netTasks: 5, focal: true }), // tied for 1st with 'a'
        cohortEntry({ skill: 'c', netTasks: 1 }),
      ],
    };
    expect(cohortRank(cohort)).toEqual({ rank: 1, of: 3 });
  });
});
