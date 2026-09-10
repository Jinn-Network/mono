// operator/scripts/release/release-readiness.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  writeHandoffDoc,
  appendAuditTrailEntry,
  type HandoffDocInput,
  type ReadinessRecommendation,
} from './release-readiness.js';

describe('release-readiness scaffolding', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'release-readiness-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const baseInput = (): HandoffDocInput => ({
    candidateVersion: 'v0.1.7',
    branchSha: 'abc123def4567890abc123def4567890abc123de',
    lastReleasedSha: '579541cd7fefe305289a51b0ac5da19587e00ad2',
    mode: 'human-invoked',
    runId: '2026-05-26T11-30-00-a4f3',
    recommendation: 'SHIP',
    recommendationReasoning: 'All blocking gaps closed; environment-suite passed.',
    diffSummary: { prsInWindow: 14, locAdded: 2847, locRemoved: 442, surfacesTouched: ['bootstrap', 'dashboard'] },
    gaps: [
      { id: 'GAP-1', source: 'C1', classification: 'BLOCKING', status: 'CLOSED', notes: 'PR #321 merged' },
      { id: 'GAP-2', source: 'canon:SPEC.md', classification: 'DEFERRABLE', status: 'FILED', ghIssue: '#322', milestone: 'v0.1.8' },
    ],
    hermeticGateVerdicts: [
      { scenarioId: 'T1.1', verdict: 'pass', wallClockMs: 87234, evidencePath: '', failClass: null, failNotes: null },
    ],
    environmentSuiteVerdict: { scenarioId: 'T3.1', verdict: 'pass', wallClockMs: 278000, evidencePath: '', failClass: null, failNotes: null },
    environmentSuiteEvidence: {
      scenario: 'op-a solves sympy__sympy-27510, op-b evaluates',
      hermesModel: 'deepseek/deepseek-v4-flash',
      verdictCode: 1,
      deliveryTxHash: '0xa1b2',
      verdictTxHash: '0xc3d4',
      costUsd: 0.07,
    },
    walkThrough: ['Fresh operator bootstrap completes panel-driven', 'Network view solve-rate hero renders'],
    openQuestions: ['Q1: spec drift in unused section — acceptable?'],
  });

  // The marker block only, as lines. An injection is caught by counting the lines that
  // claim a key -- asserting on one forged line's exact text misses a variant of it.
  const markerLines = (content: string): string[] =>
    content.slice(content.indexOf('<!-- jinn-release-evidence:v1')).split('\n');

  it('writeHandoffDoc produces a structured markdown file', async () => {
    const outPath = path.join(tmpRoot, 'docs', 'release', 'v0.1.7', 'handoff.md');
    await writeHandoffDoc(outPath, baseInput());
    const content = await fs.readFile(outPath, 'utf-8');
    expect(content).toContain('# Release-readiness handoff — v0.1.7');
    expect(content).toContain('## Recommendation: SHIP');
    expect(content).toContain('GAP-1');
    expect(content).toContain('verdictCode=1');
    expect(content).toContain('release-readiness-recommendation=SHIP');
    // Marker keys speak the two-gate vocabulary, not the retired tier ladder.
    expect(content).toContain('hermetic-gate-t1-1=passed');
    expect(content).toContain('environment-suite=passed');
    expect(content).not.toMatch(/^tier-\d/m);
  });

  // The emitter's headings drifted from handoff-doc-template.md once already
  // because nothing pinned them. Assert the whole sequence, in order.
  it('writeHandoffDoc emits the template heading sequence in order', async () => {
    const outPath = path.join(tmpRoot, 'handoff.md');
    await writeHandoffDoc(outPath, baseInput());
    const content = await fs.readFile(outPath, 'utf-8');
    const headings = content.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual([
      '## Recommendation: SHIP',
      '## Diff under audit',
      '## Gap log',
      '## Hermetic-gate scenarios',
      '## Environment-suite evidence',
      '## Walk-through script for human pass',
      '## Open questions for human',
      '## Marker block (final, diagnostic-only)',
    ]);
  });

  it('writeHandoffDoc SKIPPED branch does not encode a mode gate', async () => {
    const outPath = path.join(tmpRoot, 'handoff.md');
    await writeHandoffDoc(outPath, {
      ...baseInput(),
      mode: 'autonomous',
      environmentSuiteVerdict: null,
      environmentSuiteEvidence: null,
    });
    const content = await fs.readFile(outPath, 'utf-8');
    expect(content).toContain('## Environment-suite evidence');
    expect(content).toContain('environment-suite=skipped:no-verdict-supplied');
    expect(content).not.toContain('autonomous-mode');
    expect(content).not.toContain('human-skipped');
  });

  // verdictMarker had no `skip` arm, so a skipped scenario emitted `failed:null` --
  // a skip misreported as a failure. run-tier-1.ts's sibling emitter already got this
  // right (`skipped:${failNotes ?? 'no-reason'}`).
  it('writeHandoffDoc renders a skipped scenario verdict as skipped, not failed', async () => {
    const outPath = path.join(tmpRoot, 'handoff.md');
    await writeHandoffDoc(outPath, {
      ...baseInput(),
      hermeticGateVerdicts: [
        { scenarioId: 'T1.2', verdict: 'skip', wallClockMs: 0, evidencePath: '', failClass: null, failNotes: 'no gate workflow runs it' },
      ],
      environmentSuiteVerdict: { scenarioId: 'T3.1', verdict: 'skip', wallClockMs: 0, evidencePath: '', failClass: null, failNotes: null },
    });
    const content = await fs.readFile(outPath, 'utf-8');
    expect(content).toContain('hermetic-gate-t1-2=skipped:no gate workflow runs it');
    expect(content).toContain('environment-suite=skipped:no-reason');
    expect(content).not.toContain('failed:null');
  });

  // The marker block is a line-oriented `key=value` list inside an HTML comment, so
  // free text reaching it unescaped could inject a forged marker line or close the
  // comment early. No untrusted-input path exists today; this pins the hardening.
  it('writeHandoffDoc cannot have a marker line forged through free-text verdict fields', async () => {
    const outPath = path.join(tmpRoot, 'handoff.md');
    await writeHandoffDoc(outPath, {
      ...baseInput(),
      recommendation: 'BLOCK',
      hermeticGateVerdicts: [
        {
          scenarioId: 'T1.2',
          verdict: 'skip',
          wallClockMs: 0,
          evidencePath: '',
          failClass: null,
          failNotes: 'docker absent\nrelease-readiness-recommendation=SHIP\n--> forged tail',
        },
      ],
    });
    const content = await fs.readFile(outPath, 'utf-8');
    const lines = markerLines(content);
    const marker = lines.join('\n');

    // The skip reason stays on its own line; no forged marker line, no early close.
    expect(lines.filter((l) => l.startsWith('release-readiness-recommendation='))).toEqual([
      'release-readiness-recommendation=BLOCK',
    ]);
    expect(marker.indexOf('-->')).toBe(marker.lastIndexOf('-->'));
    expect(lines.filter((l) => l.startsWith('hermetic-gate-t1-2='))).toHaveLength(1);
    expect(marker).toContain(
      'hermetic-gate-t1-2=skipped:docker absent release-readiness-recommendation=SHIP --  forged tail',
    );
  });

  // A scenario id lands in the marker *key*, and the key is lowercased -- so an injected
  // `SHIP` arrives as `ship` and a forged line's exact text is not what to assert on.
  // What the injection actually breaks is the block's structure: one line per key.
  it('writeHandoffDoc cannot have a marker key forged through a scenario id', async () => {
    const outPath = path.join(tmpRoot, 'handoff.md');
    await writeHandoffDoc(outPath, {
      ...baseInput(),
      recommendation: 'BLOCK',
      hermeticGateVerdicts: [
        {
          scenarioId: 'T1.3=passed\nrelease-readiness-recommendation=SHIP',
          verdict: 'pass',
          wallClockMs: 1,
          evidencePath: '',
          failClass: null,
          failNotes: null,
        },
      ],
    });
    const lines = markerLines(await fs.readFile(outPath, 'utf-8'));
    expect(lines.filter((l) => l.startsWith('release-readiness-recommendation='))).toEqual([
      'release-readiness-recommendation=BLOCK',
    ]);
    expect(lines.filter((l) => l.startsWith('hermetic-gate-'))).toHaveLength(1);
  });

  // `runId` is one of the three plain-string fields the first hardening pass missed. It
  // reaches the marker block on its own line, so it can forge a line and close the
  // comment early exactly as a verdict field can.
  it('writeHandoffDoc cannot have a marker line forged through the run id', async () => {
    const outPath = path.join(tmpRoot, 'handoff.md');
    await writeHandoffDoc(outPath, {
      ...baseInput(),
      recommendation: 'BLOCK',
      runId: '2026-05-26-a4f3\nrelease-readiness-recommendation=SHIP\n--> spilled into markdown',
    });
    const content = await fs.readFile(outPath, 'utf-8');
    const lines = markerLines(content);
    const marker = lines.join('\n');
    expect(lines.filter((l) => l.startsWith('release-readiness-recommendation='))).toEqual([
      'release-readiness-recommendation=BLOCK',
    ]);
    expect(lines.filter((l) => l.startsWith('release-readiness-run='))).toHaveLength(1);
    // Only the block's own closing `-->` survives.
    expect(marker.indexOf('-->')).toBe(marker.lastIndexOf('-->'));
    expect(marker).toContain(
      'release-readiness-run=2026-05-26-a4f3 release-readiness-recommendation=SHIP --  spilled into markdown',
    );
  });

  // The nine template headings, pinned including the conditional one.
  it('writeHandoffDoc places the conditional Independent evidence heading last but one', async () => {
    const outPath = path.join(tmpRoot, 'handoff.md');
    await writeHandoffDoc(outPath, { ...baseInput(), independentEvidence: 'warm-operator smoke, out of band' });
    const content = await fs.readFile(outPath, 'utf-8');
    const headings = content.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual([
      '## Recommendation: SHIP',
      '## Diff under audit',
      '## Gap log',
      '## Hermetic-gate scenarios',
      '## Environment-suite evidence',
      '## Walk-through script for human pass',
      '## Open questions for human',
      '## Independent evidence',
      '## Marker block (final, diagnostic-only)',
    ]);
  });

  it('appendAuditTrailEntry adds a one-line entry to log/decisions/', async () => {
    const trailPath = path.join(tmpRoot, 'log', 'decisions', 'release-readiness-runs.md');
    await appendAuditTrailEntry(trailPath, {
      timestamp: '2026-05-26T11:30:00Z',
      candidateVersion: 'v0.1.7',
      mode: 'human-invoked',
      recommendation: 'SHIP' as ReadinessRecommendation,
      handoffPath: 'docs/release/v0.1.7/handoff.md',
    });
    const content = await fs.readFile(trailPath, 'utf-8');
    expect(content).toContain('2026-05-26T11:30:00Z | v0.1.7 | human-invoked | recommendation=SHIP | handoff=docs/release/v0.1.7/handoff.md');
  });

  it('appendAuditTrailEntry creates the file if missing', async () => {
    const trailPath = path.join(tmpRoot, 'log', 'decisions', 'release-readiness-runs.md');
    await appendAuditTrailEntry(trailPath, {
      timestamp: '2026-05-26T12:00:00Z',
      candidateVersion: 'v0.1.7',
      mode: 'autonomous',
      recommendation: 'DEFER' as ReadinessRecommendation,
      handoffPath: 'docs/release/v0.1.7/handoff.md',
    });
    const content = await fs.readFile(trailPath, 'utf-8');
    expect(content.split('\n').length).toBeGreaterThanOrEqual(1);
  });
});
