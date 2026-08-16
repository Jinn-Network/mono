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

  it('writeHandoffDoc produces a structured markdown file', async () => {
    const input: HandoffDocInput = {
      candidateVersion: 'v0.1.7',
      branchSha: 'abc123def4567890abc123def4567890abc123de',
      lastReleasedSha: '579541cd7fefe305289a51b0ac5da19587e00ad2',
      mode: 'human-invoked',
      runId: '2026-05-26T11-30-00-a4f3',
      recommendation: 'SHIP',
      recommendationReasoning: 'All blocking gaps closed; Tier 3 passed.',
      diffSummary: { prsInWindow: 14, locAdded: 2847, locRemoved: 442, surfacesTouched: ['bootstrap', 'dashboard'] },
      gaps: [
        { id: 'GAP-1', source: 'C1', classification: 'BLOCKING', status: 'CLOSED', notes: 'PR #321 merged' },
        { id: 'GAP-2', source: 'canon:SPEC.md', classification: 'DEFERRABLE', status: 'FILED', ghIssue: '#322', milestone: 'v0.1.8' },
      ],
      releasePrepVerdicts: [
        { scenarioId: 'T1.1', verdict: 'pass', wallClockMs: 87234, evidencePath: '', failClass: null, failNotes: null },
      ],
      tier3Verdict: { scenarioId: 'T3.1', verdict: 'pass', wallClockMs: 278000, evidencePath: '', failClass: null, failNotes: null },
      tier3Evidence: {
        scenario: 'op-a solves sympy__sympy-27510, op-b evaluates',
        hermesModel: 'deepseek/deepseek-v4-flash',
        verdictCode: 1,
        deliveryTxHash: '0xa1b2',
        verdictTxHash: '0xc3d4',
        costUsd: 0.07,
      },
      walkThrough: ['Fresh operator bootstrap completes panel-driven', 'Network view solve-rate hero renders'],
      openQuestions: ['Q1: spec drift in unused section — acceptable?'],
    };

    const outPath = path.join(tmpRoot, 'docs', 'release', 'v0.1.7', 'handoff.md');
    await writeHandoffDoc(outPath, input);
    const content = await fs.readFile(outPath, 'utf-8');
    expect(content).toContain('# Release-readiness handoff — v0.1.7');
    expect(content).toContain('## Recommendation: SHIP');
    expect(content).toContain('GAP-1');
    expect(content).toContain('verdictCode=1');
    expect(content).toContain('release-readiness-recommendation=SHIP');
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
