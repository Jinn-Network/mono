/**
 * The `Distiller` seam (issue #1488) — one interface, two backends.
 *
 * `LocalDistiller` runs the merged distillation engine (capture → gate →
 * cluster → distill) in-process over the operator's OWN local captures, sinking
 * to a private local skill install (SKILL.md, no chain anchor). `NetworkDistiller`
 * is the rung-3 seam: stubbed / fail-closed for the MVP until #1395 wires the
 * bonded-network source + anchored-corpus sink.
 *
 * These tests cover the local backend end-to-end (real capture + gate + cluster
 * + distill + a real on-disk SKILL.md sink; only the LLM port is stubbed, the
 * same Tier-0 shape as pipeline.test.ts) and assert the network backend's guard.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLocalDistiller,
  createNetworkDistiller,
  createLocalSkillSink,
  NetworkDistillerNotWiredError,
  type SkillSink,
} from '../src/distiller.js';
import { parseSkillMarkdown, type SkillPackage } from '../src/skill-package.js';
import type { CapturedTask } from '../src/capture.js';
import type { DistillCluster, DistillLLMOutput } from '../src/distill.js';

const NOW = () => new Date('2026-07-09T09:00:00.000Z');

/** A valid, structurally-conformant distilled skill (five sections + anti-trigger). */
const VALID_OUT: DistillLLMOutput = {
  name: 'orm-fanout-dedup',
  description: 'Use when a join fans out duplicate rows. Not for: single-table reads.',
  body: [
    '## When to use', 'A queryset returns duplicate rows after a join or prefetch.',
    '## Strategy', 'Collapse the duplicates at the ORM layer, near the join that produced them.',
    '## Steps', '1. Identify the fan-out join. 2. Apply .distinct() after it.',
    '## Pitfalls', 'An order_by on a joined column can re-expand the collapsed rows.',
    '## Verify', 'Assert the row count equals the expected unique count.',
  ].join('\n\n'),
};

/** An evaluator-verified, contributed own-capture — pattern-eligible. */
function fixtureCapture(over: Partial<CapturedTask> = {}): CapturedTask {
  return {
    session: { sessionId: 'own-session-orm-dedup', capturedAt: '2026-07-09T08:00:00.000Z' },
    task: { summary: 'fix duplicate rows after a join in the report query', distributionTags: ['coding'] },
    environment: { harness: { name: 'claude-code', version: '1.0.0' }, model: 'claude-opus-4-8', tools: [] },
    steps: [
      {
        spanId: 'patch',
        parentSpanId: null,
        name: 'tool:apply_patch',
        startTimeUnixNano: '1720000000000000000',
        endTimeUnixNano: '1720000000000000000',
        attributes: { patch: 'diff --git a/report.py b/report.py\n+ return qs.distinct()  # dedup after join\n' },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'evaluator-verified' },
    cost: { durationMs: 1000 },
    provenance: 'contributed',
    ...over,
  };
}

/** In-memory sink capturing the packages the engine would install. */
function memorySink(): { sink: SkillSink; installed: SkillPackage[] } {
  const installed: SkillPackage[] = [];
  const sink: SkillSink = async (pkg) => {
    installed.push(pkg);
    return { envelopeRef: `local:${pkg.name}`, anchorTx: null };
  };
  return { sink, installed };
}

describe('LocalDistiller', () => {
  it('distills an operator-owned capture into a skill via the local sink', async () => {
    const { sink, installed } = memorySink();
    const distiller = createLocalDistiller({
      distill: async (_c: DistillCluster) => VALID_OUT,
      sink,
      distribution: 'coding',
      distillModel: 'claude-opus-4-8',
      now: NOW,
    });

    const result = await distiller.distill([fixtureCapture()]);

    // One pattern cluster → one published skill, provenance-linked + prompt-hashed.
    expect(result.clusterCount).toBe(1);
    expect(result.distilled.published).toHaveLength(1);
    expect(installed).toHaveLength(1);
    const skill = installed[0]!;
    expect(skill.jinn.skillKind).toBe('strategic-pattern');
    expect(skill.jinn.provenance.length).toBeGreaterThan(0);
    expect(skill.jinn.distillPromptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(skill.jinn.distribution).toBe('coding');
    expect(skill.jinn.distillModel).toBe('claude-opus-4-8');
    // Sink returned a local ref, never an anchor (private local install).
    expect(result.distilled.published[0]!.envelopeRef).toBe('local:orm-fanout-dedup');
  });

  it('end-to-end: writes a parseable SKILL.md to disk via the on-disk local sink', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-local-distill-'));
    const distiller = createLocalDistiller({
      distill: async (_c: DistillCluster) => VALID_OUT,
      sink: createLocalSkillSink(outDir),
      now: NOW,
    });

    const result = await distiller.distill([fixtureCapture()]);
    expect(result.distilled.published).toHaveLength(1);

    const md = readFileSync(join(outDir, 'orm-fanout-dedup', 'SKILL.md'), 'utf-8');
    const parsed = parseSkillMarkdown(md);
    expect(parsed.name).toBe('orm-fanout-dedup');
    expect(parsed.body).toContain('## Strategy');
    expect(parsed.jinn.skillKind).toBe('strategic-pattern');
  });

  it('distills a user-accepted own-capture into an experimental local skill', async () => {
    const { sink, installed } = memorySink();
    const distiller = createLocalDistiller({ distill: async () => VALID_OUT, sink, now: NOW });
    const result = await distiller.distill([
      fixtureCapture({ outcome: { status: 'completed', verifiabilityTier: 'user-accepted' } }),
    ]);

    expect(result.clusterCount).toBe(1);
    expect(result.distilled.published).toHaveLength(1);
    expect(installed).toHaveLength(1);
    expect(installed[0]!.jinn.verifiabilityTier).toBe('user-accepted');
    expect(installed[0]!.jinn.status).toBe('experimental');
    expect(installed[0]!.jinn.evidenceTier).toBe('single-example');
    expect(installed[0]!.jinn.sourceTools).toEqual(['claude-code']);
    expect(installed[0]!.jinn.targetTools).toEqual(['current']);
  });

  it('preserves the engine fail-closed secret gate behind the interface', async () => {
    const { sink, installed } = memorySink();
    const distiller = createLocalDistiller({
      distill: async () => ({
        name: 'leaky-skill',
        description: 'Use when configuring the client. Not for: unrelated tasks.',
        body: '## When to use\nSet AWS_SECRET=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n',
      }),
      sink,
      now: NOW,
    });
    const result = await distiller.distill([fixtureCapture()]);
    expect(installed).toHaveLength(0);
    expect(result.distilled.rejected.length).toBeGreaterThan(0);
    expect(result.distilled.rejected[0]!.reason).toMatch(/secret/);
  });
});

describe('NetworkDistiller (rung-3 seam)', () => {
  it('fails closed — not wired for the MVP (#1395)', async () => {
    const distiller = createNetworkDistiller();
    await expect(distiller.distill([fixtureCapture()])).rejects.toBeInstanceOf(NetworkDistillerNotWiredError);
    await expect(distiller.distill([])).rejects.toThrow(/not wired/i);
  });
});
