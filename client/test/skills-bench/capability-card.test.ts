import { describe, expect, it } from 'vitest';

import { renderCapabilityCardSvg } from '../../src/skills-bench/capability-card.js';
import { buildCapabilityReport, type BuildCapabilityReportOptions, type Cohort } from '../../src/skills-bench/capability-report.js';
import { attemptKey, type BenchOutcome } from '../../src/skills-bench/attempts.js';
import type { ReceiptProfile } from '../../src/skills-bench/receipt.js';
import type { SkillPin } from '../../src/skills-bench/skill-pin.js';
import type { SkillTaskSetV1, SkillTaskV1, TaskRequirement } from '../../src/skills-bench/task-set.js';

// ---------------------------------------------------------------------------
// Fixtures — modeled on capability-report.test.ts's own fixtures (synthetic
// ids/shas only).
// ---------------------------------------------------------------------------

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
  tasks: [task('t1'), task('t2'), task('t3'), task('t4'), task('t5'), task('t6'),
    task('t7'), task('t8'), task('t9'), task('t10'), task('t11'), task('t12')],
  sha256: 'deadbeef'.repeat(8),
  screeningSummary: {
    screenedAt: '2026-08-01T00:00:00.000Z',
    model: 'claude-haiku-4-5-20251001',
    repeats: 2,
    passThreshold: 1,
    kept: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12'],
    droppedNoHeadroom: ['t13'],
    droppedUngradeable: [],
  },
};

function o(id: string, arm: string, repeat: number, passed: boolean | null): BenchOutcome {
  return { instanceId: id, arm, repeat, passed, unscorable: passed === null, costUsd: 0.12 };
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

// A well-triggered run: 12 paired tasks, 9/12 treatment triggers, net +2.
const highTriggerOutcomes: BenchOutcome[] = [
  o('t1', 'baseline', 0, false), o('t1', 'tdd', 0, true),
  o('t2', 'baseline', 0, false), o('t2', 'tdd', 0, true),
  o('t3', 'baseline', 0, true), o('t3', 'tdd', 0, false),
  o('t4', 'baseline', 0, true), o('t4', 'tdd', 0, true),
  o('t5', 'baseline', 0, false), o('t5', 'tdd', 0, false),
  o('t6', 'baseline', 0, true), o('t6', 'tdd', 0, true),
  o('t7', 'baseline', 0, false), o('t7', 'tdd', 0, true),
  o('t8', 'baseline', 0, false), o('t8', 'tdd', 0, true),
  o('t9', 'baseline', 0, true), o('t9', 'tdd', 0, true),
  o('t10', 'baseline', 0, false), o('t10', 'tdd', 0, false),
  o('t11', 'baseline', 0, true), o('t11', 'tdd', 0, true),
  o('t12', 'baseline', 0, false), o('t12', 'tdd', 0, true),
];

const highTriggerByKey = new Map<string, boolean | null>([
  [attemptKey({ instanceId: 't1', arm: 'tdd', repeat: 0 }), true],
  [attemptKey({ instanceId: 't2', arm: 'tdd', repeat: 0 }), true],
  [attemptKey({ instanceId: 't3', arm: 'tdd', repeat: 0 }), true],
  [attemptKey({ instanceId: 't4', arm: 'tdd', repeat: 0 }), true],
  [attemptKey({ instanceId: 't5', arm: 'tdd', repeat: 0 }), false],
  [attemptKey({ instanceId: 't6', arm: 'tdd', repeat: 0 }), true],
  [attemptKey({ instanceId: 't7', arm: 'tdd', repeat: 0 }), true],
  [attemptKey({ instanceId: 't8', arm: 'tdd', repeat: 0 }), true],
  [attemptKey({ instanceId: 't9', arm: 'tdd', repeat: 0 }), false],
  [attemptKey({ instanceId: 't10', arm: 'tdd', repeat: 0 }), false],
  [attemptKey({ instanceId: 't11', arm: 'tdd', repeat: 0 }), true],
  [attemptKey({ instanceId: 't12', arm: 'tdd', repeat: 0 }), true],
]);

function baseOptions(): BuildCapabilityReportOptions {
  return {
    skill: 'tdd',
    outcomes: highTriggerOutcomes,
    taskSet,
    baselineArm: 'baseline',
    treatmentArm: 'tdd',
    profile,
    pin,
    triggerByKey: highTriggerByKey,
    links: {
      dataPaths: ['data/attempts.jsonl', 'data/bench-manifest.json', 'data/set.json'],
      rerunCommand: 'yarn tsx scripts/skills-bench/run-bench.ts --task-set ../bench/task-sets/tdd --model claude-haiku-4-5-20251001 --out <fresh-out-dir>',
    },
  };
}

function highTriggerReport() {
  return buildCapabilityReport(baseOptions());
}

/** A run whose skill barely loaded (1/12 triggers) — the honesty-gating
 *  fixture. Same paired outcomes as the high-trigger fixture (so a net delta
 *  still exists), but only one treatment attempt is marked triggered. */
function lowTriggerReport() {
  const triggerByKey = new Map<string, boolean | null>(
    highTriggerOutcomes
      .filter((oc) => oc.arm === 'tdd')
      .map((oc, i) => [attemptKey({ instanceId: oc.instanceId, arm: 'tdd', repeat: 0 }), i === 0]),
  );
  return buildCapabilityReport({ ...baseOptions(), triggerByKey });
}

/** A run with no session-JSONL data captured at all — total === 0. */
function noSessionDataReport() {
  return buildCapabilityReport({ ...baseOptions(), triggerByKey: new Map() });
}

function withCohort(): Cohort {
  return {
    domain: 'python-testing',
    entries: [
      { skill: 'other-skill', skillSha: 'a'.repeat(64), triggered: 10, total: 12, netTasks: 4, costRatio: 1.05, focal: false },
      { skill: 'tdd', skillSha: pin.sha256, triggered: 9, total: 12, netTasks: 2, costRatio: 1.17, focal: true },
      { skill: 'third-skill', skillSha: 'd'.repeat(64), triggered: 6, total: 12, netTasks: -1, costRatio: 0.95, focal: false },
    ],
  };
}

// ---------------------------------------------------------------------------
// Hand-rolled XML well-formedness + no-external-refs scanners — same
// approach as capability-report.test.ts, no XML/DOM library dependency.
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

function assertNoExternalRefs(svg: string): void {
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

const APPROVED_CARD_HEXES = ['#ffffff', '#33415c', '#1b2430', '#527a70', '#934c4c'];

function assertOnlyApprovedHexes(svg: string): void {
  const found = svg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  for (const hex of found) {
    expect(APPROVED_CARD_HEXES).toContain(hex.toLowerCase());
  }
}

function viewBoxDims(svg: string): { width: number; height: number } {
  const match = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  expect(match).not.toBeNull();
  return { width: Number(match![1]), height: Number(match![2]) };
}

describe('renderCapabilityCardSvg', () => {
  it('is well-formed, self-contained, and has a viewBox matching its declared width/height', () => {
    const svg = renderCapabilityCardSvg(highTriggerReport());
    assertWellFormedXmlTags(svg);
    assertNoExternalRefs(svg);
    const { width, height } = viewBoxDims(svg);
    expect(svg).toContain(`width="${width}"`);
    expect(svg).toContain(`height="${height}"`);
    expect(width).toBeGreaterThanOrEqual(720);
    expect(width).toBeLessThanOrEqual(860);
    expect(height).toBeGreaterThan(0);
  });

  it('never uses emoji, gradients, letter grades, or pass/fail wording', () => {
    assertNoBannedContent(renderCapabilityCardSvg(highTriggerReport()));
  });

  it('uses only the five approved hexes', () => {
    assertOnlyApprovedHexes(renderCapabilityCardSvg(highTriggerReport()));
  });

  // ---------------------------------------------------------------------------
  // Section 1 — identity.
  // ---------------------------------------------------------------------------

  it('renders skill@sha, "evaluated by jinn", and the date on the face', () => {
    const svg = renderCapabilityCardSvg(highTriggerReport());
    expect(svg).toContain('tdd@bbbbbbbb'); // pin.commit short form, not skillSha256
    expect(svg).toContain('evaluated by jinn');
    expect(svg).toContain('2026-08-01');
  });

  // ---------------------------------------------------------------------------
  // Section 2 — what was evaluated.
  // ---------------------------------------------------------------------------

  it('renders task count, domain, agent, and model', () => {
    const svg = renderCapabilityCardSvg(highTriggerReport());
    expect(svg).toContain('12 tasks');
    expect(svg).toContain('python-testing');
    expect(svg).toContain('claude-code');
    expect(svg).toContain('claude-haiku-4-5-20251001');
  });

  it('states the discrimination provenance truthfully (screened set)', () => {
    const svg = renderCapabilityCardSvg(highTriggerReport());
    expect(svg).toContain('screened baseline-only');
  });

  it('never claims screening when the task set was never screened', () => {
    const unscreened: SkillTaskSetV1 = { ...taskSet, screeningSummary: undefined };
    const report = buildCapabilityReport({ ...baseOptions(), taskSet: unscreened });
    const svg = renderCapabilityCardSvg(report);
    expect(svg).not.toContain('screened baseline-only');
    expect(svg).toContain('has not been through');
  });

  // ---------------------------------------------------------------------------
  // Section 3 — three metrics, normal (high-trigger) case.
  // ---------------------------------------------------------------------------

  it('renders all three metrics with a clean effect number when the trigger rate is normal', () => {
    const report = highTriggerReport();
    const svg = renderCapabilityCardSvg(report);
    const delta = report.receipt.treatment.passed - report.receipt.baseline.passed;
    expect(svg).toContain(`${report.receipt.baseline.passed} → ${report.receipt.treatment.passed} of ${report.receipt.n}`);
    expect(svg).toContain(`${report.receipt.triggerRate!.triggered} of ${report.receipt.triggerRate!.total}`);
    if (delta > 0) expect(svg).toContain('fill="#527a70"');
    if (delta < 0) expect(svg).toContain('fill="#934c4c"');
    expect(svg).not.toContain('not exercised');
    expect(svg).not.toContain('unknown');
  });

  // ---------------------------------------------------------------------------
  // Honesty gating — mandatory on the card, per the task brief: a low
  // trigger rate must replace the clean effect number, never merely
  // decorate it.
  // ---------------------------------------------------------------------------

  it('renders the not-exercised framing and omits a clean effect number when the trigger rate is low', () => {
    const report = lowTriggerReport();
    const svg = renderCapabilityCardSvg(report);
    const cleanEffect = `${report.receipt.baseline.passed} → ${report.receipt.treatment.passed} of ${report.receipt.n}`;
    expect(svg).toContain('not exercised');
    expect(svg).not.toContain(cleanEffect);
    expect(svg).not.toContain('fill="#527a70"');
    expect(svg).not.toContain('fill="#934c4c"');
  });

  it('renders "no session data" and loaded "unknown" when total triggers is 0', () => {
    const report = noSessionDataReport();
    const svg = renderCapabilityCardSvg(report);
    expect(svg).toContain('no session data');
    expect(svg).toContain('unknown');
  });

  it('renders the loaded metric as "unknown" specifically (not a bare 0 of 0) when total is 0', () => {
    const svg = renderCapabilityCardSvg(noSessionDataReport());
    expect(svg).not.toContain('0 of 0');
  });

  it('renders "unknown" for cost when deriveCostOverhead is null (zero baseline mean)', () => {
    const zeroCostOutcomes = highTriggerOutcomes.map((oc) => ({ ...oc, costUsd: 0 }));
    const report = buildCapabilityReport({ ...baseOptions(), outcomes: zeroCostOutcomes });
    const svg = renderCapabilityCardSvg(report);
    expect(svg).toContain('unknown');
    expect(svg).not.toMatch(/\+0% cost|0%/); // never a fabricated 0%
  });

  // ---------------------------------------------------------------------------
  // Section 4 — cohort line, present/absent.
  // ---------------------------------------------------------------------------

  it('renders a cohort line with rank when a cohort is supplied', () => {
    const report = buildCapabilityReport({ ...baseOptions(), cohort: withCohort() });
    const svg = renderCapabilityCardSvg(report);
    expect(svg).toContain('2nd of 3');
    expect(svg).toContain('python-testing');
  });

  it('omits the cohort line entirely when no cohort is supplied', () => {
    const report = highTriggerReport();
    expect(report.cohort).toBeUndefined();
    const svg = renderCapabilityCardSvg(report);
    expect(svg).not.toMatch(/rank/i);
    expect(svg).not.toMatch(/\bof \d+\b.*\bin\b/i);
  });

  // ---------------------------------------------------------------------------
  // Section 5 — footer.
  // ---------------------------------------------------------------------------

  it('renders the honesty line with n and a text link to the full report', () => {
    const report = highTriggerReport();
    const svg = renderCapabilityCardSvg(report);
    expect(svg).toContain(`n=${report.receipt.n}, intervals overlap — direction, not proof`);
    expect(svg).toContain('report.md');
    expect(svg).not.toContain('<a ');
    expect(svg).not.toContain('href=');
  });

  it('threads report.links.reportUrl into the footer when a caller has resolved one', () => {
    const report = buildCapabilityReport({
      ...baseOptions(),
      links: {
        ...baseOptions().links,
        reportUrl: 'https://reports.example/reports/tdd@b2222222/report.md',
      },
    });
    const svg = renderCapabilityCardSvg(report);
    expect(svg).toContain('https://reports.example/reports/tdd@b2222222/report.md');
    expect(svg).not.toContain('full report: reports/tdd@');
  });

  // ---------------------------------------------------------------------------
  // XML escaping.
  // ---------------------------------------------------------------------------

  it('XML-escapes a skill name containing &, <, >, and "', () => {
    const report = buildCapabilityReport({ ...baseOptions(), skill: '<tdd & "co">' });
    // buildCapabilityReport doesn't rewrite fields.skill from pin.name, so
    // exercise the escaping through a pin whose name carries the same chars.
    const dangerousPin: SkillPin = { ...pin, name: '<tdd & "co">' };
    const dangerousReport = buildCapabilityReport({ ...baseOptions(), pin: dangerousPin });
    const svg = renderCapabilityCardSvg(dangerousReport);
    assertWellFormedXmlTags(svg);
    expect(svg).toContain('&lt;tdd &amp; &quot;co&quot;&gt;');
    expect(report.skill).toBe('<tdd & "co">'); // sanity: options threaded through
  });

  it('does not clip content — the declared height covers every rendered element', () => {
    const report = buildCapabilityReport({ ...baseOptions(), cohort: withCohort() });
    const svg = renderCapabilityCardSvg(report);
    const { height } = viewBoxDims(svg);
    const yCoords = [...svg.matchAll(/[ "]y="(-?\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));
    const y2Coords = [...svg.matchAll(/y2="(-?\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));
    for (const yValue of [...yCoords, ...y2Coords]) {
      expect(yValue).toBeLessThanOrEqual(height);
      expect(yValue).toBeGreaterThanOrEqual(0);
    }
  });
});
