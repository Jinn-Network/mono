// operator/scripts/release/release-readiness.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ScenarioVerdict } from './scenario-types.js';

export type ReadinessRecommendation = 'SHIP' | 'DEFER' | 'BLOCK';

export interface Gap {
  id: string;
  source: string;                       // e.g. "C1" or "canon:PRINCIPLES.md"
  classification: 'BLOCKING' | 'DEFERRABLE' | 'ALREADY-MET';
  status: 'OPEN' | 'CLOSED' | 'FILED' | 'ESCALATED' | 'EVIDENCE-LINKED';
  notes: string;
  ghIssue?: string;                     // e.g. "#322"
  milestone?: string;                   // e.g. "v0.1.8"
}

export interface HandoffDocInput {
  candidateVersion: string;
  branchSha: string;
  lastReleasedSha: string;
  mode: 'human-invoked' | 'autonomous';
  runId: string;
  recommendation: ReadinessRecommendation;
  recommendationReasoning: string;
  diffSummary: {
    prsInWindow: number;
    locAdded: number;
    locRemoved: number;
    surfacesTouched: string[];
  };
  gaps: Gap[];
  releasePrepVerdicts: ScenarioVerdict[];
  tier3Verdict: ScenarioVerdict | null;
  tier3Evidence: {
    scenario: string;
    hermesModel: string;
    verdictCode: number;
    deliveryTxHash: string;
    verdictTxHash: string;
    costUsd: number;
  } | null;
  walkThrough: string[];
  openQuestions: string[];
  independentEvidence?: string;
}

// Render a scenario verdict as a release-evidence marker value: `passed` or
// `failed:<failClass>`. Shared by the per-scenario lines of the marker block.
function verdictMarker(verdict: ScenarioVerdict): string {
  return verdict.verdict === 'pass' ? 'passed' : `failed:${verdict.failClass}`;
}

export async function writeHandoffDoc(outPath: string, input: HandoffDocInput): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  push(`# Release-readiness handoff — ${input.candidateVersion}`);
  push(`Generated: ${new Date().toISOString()}`);
  push(`Branch SHA: ${input.branchSha}`);
  push(`Mode: ${input.mode}`);
  push(`Audited against last released: ${input.lastReleasedSha}`);
  push(`Run-id: ${input.runId}`);
  push();
  push(`## Recommendation: ${input.recommendation}`);
  push();
  push(input.recommendationReasoning);
  push();
  push(`## Diff under audit`);
  push(`- PRs in window: ${input.diffSummary.prsInWindow}`);
  push(`- LOC: +${input.diffSummary.locAdded} / -${input.diffSummary.locRemoved}`);
  push(`- Surfaces touched: ${input.diffSummary.surfacesTouched.join(', ')}`);
  push();
  push(`## Gap log`);
  push();
  const gapSection = (heading: string, classification: Gap['classification'], renderGap: (g: Gap) => string) => {
    const matched = input.gaps.filter((g) => g.classification === classification);
    push(`### ${heading} (${matched.length})`);
    for (const g of matched) {
      push(renderGap(g));
    }
    push();
  };
  gapSection('Blocking', 'BLOCKING', (g) => `- **${g.id}** [${g.source}] ${g.status}: ${g.notes}`);
  gapSection('Deferrable', 'DEFERRABLE', (g) => {
    const tag = g.ghIssue ? ` (${g.ghIssue}${g.milestone ? `, milestone ${g.milestone}` : ''})` : '';
    return `- **${g.id}** [${g.source}]${tag}: ${g.notes}`;
  });
  gapSection('Already met', 'ALREADY-MET', (g) => `- **${g.id}** [${g.source}]: ${g.notes}`);
  push(`## release-prep evidence`);
  for (const v of input.releasePrepVerdicts) {
    push(`- ${v.scenarioId}: ${v.verdict}${v.failClass ? ` (${v.failClass})` : ''} (${v.wallClockMs}ms)`);
  }
  push();
  if (input.tier3Verdict && input.tier3Evidence) {
    push(`## Tier 3 evidence (load-bearing)`);
    push(`- Scenario: ${input.tier3Evidence.scenario}`);
    push(`- Hermes model: ${input.tier3Evidence.hermesModel}`);
    push(`- Verdict: ${input.tier3Verdict.verdict} (verdictCode=${input.tier3Evidence.verdictCode})`);
    push(`- Tx: deliver ${input.tier3Evidence.deliveryTxHash}, verdict ${input.tier3Evidence.verdictTxHash}`);
    push(`- Cost: $${input.tier3Evidence.costUsd.toFixed(2)}`);
    push(`- Wall-clock: ${input.tier3Verdict.wallClockMs}ms`);
    push();
  } else {
    push(`## Tier 3 evidence`);
    push(`SKIPPED (mode=${input.mode}; Tier 3 only runs in human-invoked mode with explicit consent).`);
    push();
  }
  push(`## Walk-through script for human pass`);
  for (const item of input.walkThrough) {
    push(`- [ ] ${item}`);
  }
  push();
  push(`## Open questions for human`);
  for (const q of input.openQuestions) {
    push(`- ${q}`);
  }
  push();
  if (input.independentEvidence) {
    push(`## Independent evidence`);
    push(input.independentEvidence);
    push();
  }
  push(`## Marker block (final)`);
  push(`<!-- jinn-release-evidence:v1`);
  push(`release-tag=${input.candidateVersion}`);
  push(`release-commit=${input.branchSha}`);
  for (const v of input.releasePrepVerdicts) {
    const key = v.scenarioId.toLowerCase().replace(/\./g, '-').replace(/^t/, 'tier-');
    push(`${key}=${verdictMarker(v)}`);
  }
  if (input.tier3Verdict) {
    push(`tier-3-t3-1=${verdictMarker(input.tier3Verdict)}`);
  } else {
    push(`tier-3-t3-1=skipped:${input.mode === 'autonomous' ? 'autonomous-mode' : 'human-skipped'}`);
  }
  push(`release-readiness-recommendation=${input.recommendation}`);
  push(`release-readiness-handoff=docs/release/${input.candidateVersion}/handoff.md`);
  push(`release-readiness-run=${input.runId}`);
  push(`-->`);

  await fs.writeFile(outPath, lines.join('\n') + '\n');
}

export interface AuditTrailEntry {
  timestamp: string;
  candidateVersion: string;
  mode: 'human-invoked' | 'autonomous';
  recommendation: ReadinessRecommendation;
  handoffPath: string;
}

export async function appendAuditTrailEntry(trailPath: string, entry: AuditTrailEntry): Promise<void> {
  await fs.mkdir(path.dirname(trailPath), { recursive: true });
  const line = `${entry.timestamp} | ${entry.candidateVersion} | ${entry.mode} | recommendation=${entry.recommendation} | handoff=${entry.handoffPath}\n`;
  try {
    await fs.access(trailPath);
    await fs.appendFile(trailPath, line);
  } catch {
    const header = '# release-readiness audit trail\n\nOne line per release-readiness run. Format: `timestamp | version | mode | recommendation=<X> | handoff=<path>`.\n\n';
    await fs.writeFile(trailPath, header + line);
  }
}
