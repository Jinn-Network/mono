/**
 * Tier-0 dry-run — the whole distillation loop end to end under stubs.
 *
 * Only external I/O is faked (verdict source, evidence fetch, publish/anchor,
 * the LLM). Everything in between is the REAL composition: capture() at the
 * layer-2 scrub altitude → publish() → the gate → clustering → the distiller's
 * output-scrub + contamination scan → publishSkill. This proves ledger →
 * layer-1 → gate → cluster → layer-2 skills composes; swap the stubs for the
 * real adapters + ANTHROPIC_API_KEY and the same call is a Tier-1 run.
 */
import { describe, it, expect } from 'vitest';
import { runDistillationPipeline, type PipelineDeps } from '../src/pipeline.js';
import { createMemoryLedger } from '../src/ledger.js';
import type { AttemptRef, BridgeEvidence } from '../src/bridge.js';
import type { HarnessPublishDeps } from '../src/publish.js';
import type { SkillPackage } from '../src/skill-package.js';
import type { DistillCluster, DistillLLMOutput } from '../src/distill.js';

const NOW = () => new Date('2026-07-07T00:00:00.000Z');

function ref(instanceId: string, polarity: 'pass' | 'fail'): AttemptRef {
  return { requestId: `0x${instanceId}`, chainId: 84532, instanceId, model: 'claude-haiku-4-5-20251001', manifestCid: `bafy-${instanceId}-${polarity}`, polarity };
}

function fakePublishDeps(): { deps: HarnessPublishDeps; envCount: () => number } {
  let n = 0;
  const deps: HarnessPublishDeps = {
    participant: { safeAddress: `0x${'1'.repeat(40)}`, agentEoa: `0x${'2'.repeat(40)}` },
    signer: { address: `0x${'2'.repeat(40)}`, privateKey: `0x${'a'.repeat(64)}` },
    clientGitSha: 'sha',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: createMemoryLedger(),
    publishArtifact: async () => ({ cid: `bafyArt${++n}`, sha256: 'a'.repeat(64) }),
    publishEnvelope: async () => ({ cid: `bafyEnv${++n}`, sha256: 'b'.repeat(64) }),
    anchorEnvelope: async () => ({ txHash: `0x${'e'.repeat(64)}`, blockNumber: 1 }),
  };
  return { deps, envCount: () => n };
}

function deps(over: Partial<PipelineDeps> = {}): { d: PipelineDeps; skills: SkillPackage[] } {
  const skills: SkillPackage[] = [];
  const { deps: publishDeps } = fakePublishDeps();
  const d: PipelineDeps = {
    verdictSource: {
      list: async () => [
        ref('flask__flask-1', 'pass'),
        ref('pytest__pytest-2', 'fail'),
        ref('django__django-99999', 'pass'), // held-out → excluded
      ],
    },
    fetchEvidence: async (r): Promise<BridgeEvidence> => ({
      taskSummary: `fix the bug in ${r.instanceId}`,
      patch: `diff --git a/x.py b/x.py\n+ return qs.distinct()  # for ${r.instanceId}\n`,
    }),
    publishDeps,
    distill: async (c: DistillCluster): Promise<DistillLLMOutput> => ({
      name: `orm-${c.tier}-${c.instanceIds[0]!.replace(/[^a-z0-9]+/g, '-')}`,
      description: 'Use when a queryset returns duplicate rows after a join. Not for: single-table queries.',
      body: [
        '## When to use',
        'A queryset returns duplicate rows after a join or prefetch.',
        '## Strategy',
        'Collapse the duplicates at the ORM layer, near the join that produced them.',
        '## Steps',
        '1. Identify the fan-out join. 2. Apply .distinct() after it.',
        '## Pitfalls',
        'An order_by on a joined column can re-expand the collapsed rows.',
        '## Verify',
        'Assert the row count equals the expected unique count.',
      ].join('\n\n'),
    }),
    publishSkill: async (pkg) => { skills.push(pkg); return { envelopeRef: `skill-${pkg.name}`, anchorTx: null }; },
    slate: { instanceIds: new Set(['django__django-99999']) },
    distribution: 'coding',
    now: NOW,
    ...over,
  };
  return { d, skills };
}

describe('runDistillationPipeline (Tier-0 dry-run)', () => {
  it('bridges both polarities, excludes held-out, and distils a pattern + a lesson skill', async () => {
    const { d, skills } = deps();
    const res = await runDistillationPipeline(d);

    // Bridge: pass + fail bridged; the held-out instance excluded.
    expect(res.bridge.bridged.map((b) => b.polarity).sort()).toEqual(['fail', 'pass']);
    expect(res.bridge.excludedHeldOut.map((e) => e.reason)).toContain('instance_id');

    // Cluster: one pattern (flask pass) + one lesson (pytest fail).
    expect(res.clusterCount).toBe(2);

    // Distil: two skills, one of each kind, each provenance-linked + prompt-hashed.
    expect(res.distilled.published).toHaveLength(2);
    const kinds = skills.map((s) => s.jinn.skillKind).sort();
    expect(kinds).toEqual(['failure-lesson', 'strategic-pattern']);
    for (const s of skills) {
      expect(s.jinn.provenance.length).toBeGreaterThan(0);
      expect(s.jinn.distillPromptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.jinn.distribution).toBe('coding');
    }
  });

  it('drops a distilled skill whose body leaks a secret (fail-closed, end-to-end)', async () => {
    const { d, skills } = deps({
      distill: async (c: DistillCluster) => ({
        name: `orm-${c.instanceIds[0]!.replace(/[^a-z0-9]+/g, '-')}`,
        description: 'Use when configuring the client.',
        body: '# setup\n\nSet the token AWS_SECRET=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n',
      }),
    });
    const res = await runDistillationPipeline(d);
    expect(skills).toHaveLength(0);
    expect(res.distilled.rejected.length).toBeGreaterThan(0);
    expect(res.distilled.rejected[0]!.reason).toMatch(/secret/);
  });
});
