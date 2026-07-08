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
import type { DistillCluster, DistillLLMOutput, MetaDistillLLMOutput } from '../src/distill.js';
import type { MetaCluster } from '../src/cluster.js';

const NOW = () => new Date('2026-07-07T00:00:00.000Z');

const META_OUT: MetaDistillLLMOutput = {
  name: 'cross-instance-orm-dedup',
  description: 'Use when a class of ORM queries fans out rows. Not for: single-table reads.',
  body: [
    '## When to use', 'A class of queries returns duplicate rows after a join.',
    '## Strategy', 'Collapse duplicates at the ORM layer across the shared pattern.',
    '## Steps', '1. Spot the fan-out. 2. Dedup at the join.',
    '## Pitfalls', 'An order_by on a joined column can re-expand the rows.',
    '## Verify', 'Assert the row count equals the expected unique count.',
  ].join('\n\n'),
  supports: ['s1', 's2'],
};

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

  it('retains the whole per-instance attempt group end-to-end (#1478)', async () => {
    const seen: DistillCluster[] = [];
    const validOut: DistillLLMOutput = {
      name: 'orm-fanout-dedup',
      description: 'Use when a join fans out rows. Not for: single-table reads.',
      body: [
        '## When to use', 'A queryset returns duplicate rows after a join.',
        '## Strategy', 'Collapse duplicates at the ORM layer near the join.',
        '## Steps', '1. Find the fan-out. 2. Apply .distinct() after it.',
        '## Pitfalls', 'An order_by on a joined column can re-expand the rows.',
        '## Verify', 'Assert the row count equals the expected unique count.',
      ].join('\n\n'),
    };
    // one instance, 3 verified passes + 2 confirmed fails — a real group.
    const groupRefs: AttemptRef[] = [
      ...[1, 2, 3].map((i) => ({ ...ref('acme__lib-7', 'pass'), requestId: `0xpass${i}`, manifestCid: `bafy-p${i}` })),
      ...[1, 2].map((i) => ({ ...ref('acme__lib-7', 'fail'), requestId: `0xfail${i}`, manifestCid: `bafy-f${i}` })),
    ];
    const { d } = deps({
      verdictSource: { list: async () => groupRefs },
      distill: async (c: DistillCluster) => { seen.push(c); return validOut; },
    });
    const res = await runDistillationPipeline(d);
    // all 5 attempts bridged (default groupCap=8 ≥ 5), folded into ONE contrastive cluster.
    expect(res.bridge.bridged).toHaveLength(5);
    expect(res.bridge.deduped).toHaveLength(0);
    expect(res.clusterCount).toBe(1);
    const c = seen.find((x) => x.clusterId === 'contrastive:acme__lib-7')!;
    expect(c.evidenceRefs).toHaveLength(5);
    const input = c.input as { groupSize: number; nPass: number; nFail: number };
    expect(input.groupSize).toBe(5);
    expect(input.nPass).toBe(3);
    expect(input.nFail).toBe(2);
  });

  it('caps a fat group at groupCap end-to-end (an instance with >K attempts yields exactly K) (#1478)', async () => {
    const passRefs: AttemptRef[] = [1, 2, 3, 4, 5].map((i) => ({ ...ref('acme__lib-9', 'pass'), requestId: `0xp${i}`, manifestCid: `bafy-cap-${i}` }));
    const { d } = deps({
      groupCap: 3,
      verdictSource: { list: async () => passRefs },
    });
    const res = await runDistillationPipeline(d);
    expect(res.bridge.bridged).toHaveLength(3);   // exactly K
    expect(res.bridge.deduped).toHaveLength(2);   // the 2 over the cap
  });

  it('flags verdictsTruncated when the fetch returns exactly the limit (silent-partial-group guard, #1478)', async () => {
    // the default fixture list returns exactly 3 rows.
    const { d } = deps({ limit: 3 });
    const res = await runDistillationPipeline(d);
    expect(res.verdictsTruncated).toBe(true);

    const { d: d2 } = deps({ limit: 100 });
    const res2 = await runDistillationPipeline(d2);
    expect(res2.verdictsTruncated).toBe(false);
  });

  it('AC5: leaves metaDistilled undefined and stage-1 unchanged when meta is disabled', async () => {
    const { d } = deps();
    const res = await runDistillationPipeline(d);
    expect(res.metaDistilled).toBeUndefined();
    expect(res.distilled.published).toHaveLength(2); // stage-1 identical to today
  });

  it('runs stage-2 when meta is enabled and a polarity spans ≥2 distinct instances', async () => {
    // two passing instances → two strategic-pattern skills → one meta-cluster.
    const { d, skills } = deps({
      verdictSource: {
        list: async () => [
          ref('flask__flask-1', 'pass'),
          ref('requests__requests-3', 'pass'),
          ref('django__django-99999', 'pass'), // held-out → excluded
        ],
      },
      meta: true,
      metaDistill: async (_c: MetaCluster) => META_OUT,
    });
    const res = await runDistillationPipeline(d);
    expect(res.distilled.published).toHaveLength(2);
    expect(res.metaDistilled).toBeDefined();
    expect(res.metaDistilled!.published).toHaveLength(1);
    const meta = res.metaDistilled!.published[0]!;
    expect(meta.skillKind).toBe('cross-instance');
    // provenance unions BOTH instances' layer-1 evidence refs (distilledFrom > 1).
    expect(meta.pkg.jinn.distilledFrom).toBeGreaterThan(1);
    expect(meta.pkg.jinn.provenance.length).toBe(meta.pkg.jinn.distilledFrom);
    // AC4: the union of source bodies is larger than the one meta body.
    expect(meta.pkg.jinn.evidenceTokens!).toBeGreaterThan(meta.pkg.jinn.skillTokens!);
    // the meta skill was actually published as a package too
    expect(skills.some((s) => s.jinn.skillKind === 'cross-instance')).toBe(true);
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
