import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attemptKey, type BenchOutcome } from '../../src/skills-bench/attempts.js';
import {
  buildCapabilityReport, buildEmbedSnippet, deriveVerdictLine, renderBadgeSvg, renderCapabilityReportMd,
  type BuildCapabilityReportOptions,
} from '../../src/skills-bench/capability-report.js';
import type { ReceiptProfile } from '../../src/skills-bench/receipt.js';
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

describe('renderCapabilityReportMd', () => {
  it('renders the receipt block, per-task table (with the unknown-trigger row), task-set identity, and reproduce section', () => {
    const md = renderCapabilityReportMd(buildCapabilityReport(baseOptions()));
    expect(md).toContain('# tdd — capability report');
    expect(md).toContain('skill:      tdd'); // reused renderReceiptMd block
    expect(md).toContain('| task | baseline | with skill | triggered |');
    expect(md).toContain('| t1 | not resolved | resolved | yes |');
    expect(md).toContain('| t2 | resolved | not resolved | unknown |');
    expect(md).toContain('| t3 | resolved | ungradeable | unknown |');
    expect(md).toContain('domain:     python-testing');
    expect(md).toContain('screening:  kept 3, dropped (no headroom) 1, dropped (ungradeable) 0');
    expect(md).toContain(`sha256:     ${taskSet.sha256}`);
    expect(md).toContain('rerun: yarn tsx scripts/skills-bench/run-bench.ts');
    expect(md).toContain('data:  data/attempts.jsonl, data/bench-manifest.json, data/set.json');
  });

  it('renders a plain placeholder, never a broken table, when there are no per-task rows', () => {
    const emptySet: SkillTaskSetV1 = { ...taskSet, tasks: [] };
    const report = buildCapabilityReport({ ...baseOptions(), taskSet: emptySet, outcomes: [] });
    const md = renderCapabilityReportMd(report);
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

describe('renderBadgeSvg', () => {
  it('is well-formed (balanced, single-root tags), contains the skill name, and has no external refs', () => {
    const svg = renderBadgeSvg({ skill: 'tdd', verdictLine: 'net +2/12 paired tasks vs. baseline', measuredOn: '2026-08-01' });
    assertWellFormedXmlTags(svg);
    expect(svg).toContain('tdd');
    expect(svg).toContain('2026-08-01');
    // No image/font/import references off-document — only the standard SVG
    // xmlns namespace URI (a declaration, never a network fetch) is allowed.
    expect(svg).not.toMatch(/<image/);
    expect(svg).not.toMatch(/xlink:href/);
    expect(svg).not.toMatch(/@import/);
    expect(svg).not.toMatch(/url\(\s*['"]?https?:/);
    expect(svg).not.toMatch(/<link/);
  });

  it('never color-codes a pass/fail judgment — no red/green fill, no pass/fail wording', () => {
    const svg = renderBadgeSvg({ skill: 'tdd', verdictLine: 'net +2/12 paired tasks vs. baseline', measuredOn: '2026-08-01' });
    expect(svg).not.toMatch(/\bred\b|\bgreen\b|#[0-9a-f]{0,2}f{2}[0-9a-f]{0,2}00|\bpass\b|\bfail\b/i);
  });

  it('escapes XML-special characters in the skill name and verdict line', () => {
    const svg = renderBadgeSvg({ skill: '<tdd & "co">', verdictLine: 'net +2/12', measuredOn: '2026-08-01' });
    assertWellFormedXmlTags(svg);
    expect(svg).toContain('&lt;tdd &amp; &quot;co&quot;&gt;');
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
