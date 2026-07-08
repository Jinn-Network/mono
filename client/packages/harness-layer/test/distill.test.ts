import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  distillClusters,
  lexicalContaminationScan,
  metaDistill,
  type DistillCluster,
  type DistillDeps,
  type DistillLLMOutput,
  type MetaDistillDeps,
  type MetaDistillLLMOutput,
} from '../src/distill.js';
import { buildMetaClusters, type MetaCluster, type Stage1PublishedSkill } from '../src/cluster.js';
import {
  JINN_SKILL_DISTILL_PROMPT_V1,
  JINN_SKILL_DISTILL_PROMPT_V1_SHA256,
  JINN_SKILL_META_DISTILL_PROMPT_V1,
  JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256,
} from '../src/distill-prompt.js';
import { parseSkillMarkdown, buildSkillMarkdown, type SkillPackage } from '../src/skill-package.js';

describe('jinn-skill-distill-prompt-v1', () => {
  it('publishes the SHA-256 of the exact prompt (auditability, D4)', () => {
    const actual = createHash('sha256').update(JINN_SKILL_DISTILL_PROMPT_V1).digest('hex');
    expect(actual).toBe(JINN_SKILL_DISTILL_PROMPT_V1_SHA256);
  });
  it('covers all three modes (§7 v0.5)', () => {
    expect(JINN_SKILL_DISTILL_PROMPT_V1).toMatch(/strategic-pattern/);
    expect(JINN_SKILL_DISTILL_PROMPT_V1).toMatch(/failure-lesson/);
    expect(JINN_SKILL_DISTILL_PROMPT_V1).toMatch(/contrastive/);
  });
});

describe('jinn-skill-meta-distill-prompt-v1', () => {
  it('publishes the SHA-256 of the exact meta prompt (auditability, D4)', () => {
    const actual = createHash('sha256').update(JINN_SKILL_META_DISTILL_PROMPT_V1).digest('hex');
    expect(actual).toBe(JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256);
  });
  it('is cross-instance mode with a polarity hint and the diagnosis-only rule', () => {
    expect(JINN_SKILL_META_DISTILL_PROMPT_V1).toMatch(/cross-instance/i);
    expect(JINN_SKILL_META_DISTILL_PROMPT_V1).toMatch(/POLARITY/);
    expect(JINN_SKILL_META_DISTILL_PROMPT_V1).toMatch(/two distinct instances|≥\s*2|at least two/i);
    expect(JINN_SKILL_META_DISTILL_PROMPT_V1).toMatch(/supports/);
  });
});

describe('lexicalContaminationScan (§12 axis 3)', () => {
  const slate = { instanceIds: new Set(['django__django-99999']) };
  it('flags a body that names a slate instance id or its repo', () => {
    expect(lexicalContaminationScan('see django__django-99999 for the fix', slate).contaminated).toBe(true);
    expect(lexicalContaminationScan('the django/django orm dedup rule', slate).contaminated).toBe(true);
  });
  it('passes a generic body', () => {
    expect(lexicalContaminationScan('use .distinct() after a join to dedup rows', slate).contaminated).toBe(false);
  });
  it('does NOT false-positive on a common-word repo buried inside a larger word', () => {
    const s = { instanceIds: new Set<string>(), repos: new Set(['go', 'flask']) };
    // "going" / "good" / "flasks" contain the repo letters but are different words.
    expect(lexicalContaminationScan('we are going to refactor for good; avoid extra flasks', s).contaminated).toBe(false);
  });
  it('DOES flag a bare repo named as a standalone word (bare-repo token, word-boundary match)', () => {
    const s = { instanceIds: new Set(['pallets__flask-5000']) };
    const scan = lexicalContaminationScan('reuse the flask blueprint before you refactor', s);
    expect(scan.contaminated).toBe(true);
    expect(scan.hits).toContain('flask');
  });
});

function cluster(over: Partial<DistillCluster> = {}): DistillCluster {
  return { clusterId: 'c1', tier: 'pattern', evidenceRefs: ['bafyEv1', 'bafyEv2'], instanceIds: ['flask__flask-1'], input: {}, ...over };
}

function deps(out: DistillLLMOutput, over: Partial<DistillDeps> = {}): DistillDeps & { published: SkillPackage[] } {
  const published: SkillPackage[] = [];
  return {
    published,
    slate: { instanceIds: new Set(['django__django-99999']) },
    distill: async () => out,
    publishSkill: async (pkg) => { published.push(pkg); return { envelopeRef: `env-${pkg.name}`, anchorTx: null }; },
    now: () => new Date('2026-07-06T00:00:00.000Z'),
    ...over,
  };
}

/** A body that satisfies the v0.5 structural gate (five non-empty sections). */
const CONFORMANT_BODY = [
  '## When to use',
  'A queryset returns duplicate rows after a join or prefetch.',
  '',
  '## Strategy',
  'Collapse the duplicates at the ORM layer, close to the join that produced them.',
  '',
  '## Steps',
  '1. Identify the join or prefetch that fans out rows.',
  '2. Apply .distinct() (or distinct(*fields)) after that join.',
  '',
  '## Pitfalls',
  'An order_by on a joined column can re-expand the rows distinct() collapsed.',
  '',
  '## Verify',
  'Assert the returned row count equals the expected unique count.',
  '',
].join('\n');

describe('distillClusters (three modes, output scrub, contamination scan, structural gate)', () => {
  const cleanOut: DistillLLMOutput = {
    name: 'orm-queryset-dedup',
    description: 'Use when a queryset returns duplicate rows after a join. Not for: single-table queries.',
    body: CONFORMANT_BODY,
  };

  it('a pattern cluster publishes a strategic-pattern skill with prompt hash + provenance', async () => {
    const d = deps(cleanOut);
    const res = await distillClusters([cluster({ tier: 'pattern' })], d);
    expect(res.published).toHaveLength(1);
    const pkg = d.published[0]!;
    expect(pkg.jinn.skillKind).toBe('strategic-pattern');
    expect(pkg.jinn.distillPromptSha256).toBe(JINN_SKILL_DISTILL_PROMPT_V1_SHA256);
    // provenance anchors ALL source traces (audit); distilledFrom counts DISTINCT
    // instances (§6 corroboration) — this cluster is one instance with two traces.
    expect(pkg.jinn.provenance).toEqual(['bafyEv1', 'bafyEv2']);
    expect(pkg.jinn.distilledFrom).toBe(1);
    // round-trips as a conformant skill package
    expect(() => parseSkillMarkdown(buildSkillMarkdown(pkg))).not.toThrow();
  });

  it('a retained group inflates provenance but NOT distilledFrom — one instance is one corroboration unit (§6, #1478)', async () => {
    const d = deps(cleanOut);
    // one instance, a group of 4 retained attempts (2 pass + 2 fail folded contrastive).
    const groupCluster = cluster({
      tier: 'contrastive',
      clusterId: 'contrastive:flask__flask-1',
      instanceIds: ['flask__flask-1'],
      evidenceRefs: ['bafyP1', 'bafyP2', 'bafyF1', 'bafyF2'],
    });
    const res = await distillClusters([groupCluster], d);
    expect(res.published).toHaveLength(1);
    const pkg = d.published[0]!;
    expect(pkg.jinn.provenance).toHaveLength(4);   // audit anchors every source trace
    expect(pkg.jinn.distilledFrom).toBe(1);        // corroboration is ONE distinct instance
  });

  it('carries the built SkillPackage on each published entry (stage-2 join surface)', async () => {
    const d = deps(cleanOut);
    const res = await distillClusters([cluster({ tier: 'pattern' })], d);
    expect(res.published[0]!.pkg).toBeDefined();
    expect(res.published[0]!.pkg.name).toBe('orm-queryset-dedup');
    expect(res.published[0]!.pkg.jinn.skillKind).toBe('strategic-pattern');
    // identical to the object handed to publishSkill
    expect(res.published[0]!.pkg).toEqual(d.published[0]!);
  });

  it('a lesson cluster publishes a failure-lesson skill', async () => {
    const d = deps(cleanOut);
    const res = await distillClusters([cluster({ tier: 'lesson' })], d);
    expect(d.published[0]!.jinn.skillKind).toBe('failure-lesson');
    expect(res.published).toHaveLength(1);
  });

  it('drops (does not publish) a skill whose body carries a secret (fail-closed output scrub)', async () => {
    const leaky: DistillLLMOutput = { ...cleanOut, body: cleanOut.body + '\nAWS_SECRET=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' };
    const d = deps(leaky);
    const res = await distillClusters([cluster()], d);
    expect(res.published).toHaveLength(0);
    expect(d.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/secret/);
  });

  it('drops a skill whose body is contaminated with a slate token', async () => {
    const contaminated: DistillLLMOutput = { ...cleanOut, body: cleanOut.body + '\nsee django__django-99999\n' };
    const d = deps(contaminated);
    const res = await distillClusters([cluster()], d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/contamination/);
  });

  it('rejects (not errors) a distiller output whose name sanitises to empty', async () => {
    const d = deps({ ...cleanOut, name: '!!!' }); // → '' after sanitiseName
    const res = await distillClusters([cluster()], d);
    expect(res.published).toHaveLength(0);
    expect(res.errors).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/non-conformant skill name/);
  });

  it('returns an empty result for no clusters', async () => {
    const res = await distillClusters([], deps(cleanOut));
    expect(res).toEqual({ published: [], rejected: [], errors: [] });
  });

  it('a contrastive cluster publishes a contrastive skill (§7 v0.5)', async () => {
    const d = deps(cleanOut);
    const res = await distillClusters([cluster({ tier: 'contrastive', clusterId: 'contrastive:flask__flask-1' })], d);
    expect(res.published).toHaveLength(1);
    expect(res.published[0]!.skillKind).toBe('contrastive');
    expect(d.published[0]!.jinn.skillKind).toBe('contrastive');
  });

  it('records auditability metadata: distillModel + token estimates (§5 v0.5)', async () => {
    const d = deps(cleanOut, { distillModel: 'claude-opus-4-8' });
    await distillClusters([cluster({ input: { some: 'evidence payload here' } })], d);
    const jinn = d.published[0]!.jinn;
    expect(jinn.distillModel).toBe('claude-opus-4-8');
    expect(jinn.evidenceTokens).toBeGreaterThan(0);
    expect(jinn.skillTokens).toBeGreaterThan(0);
  });

  it('drops a skill missing a required skeleton section (§7 step 6)', async () => {
    const noVerify = CONFORMANT_BODY.replace(/## Verify[\s\S]*$/, '').trimEnd() + '\n';
    const d = deps({ ...cleanOut, body: noVerify });
    const res = await distillClusters([cluster()], d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/skeleton: missing section "## Verify"/);
  });

  it('drops a skill whose description lacks the "Not for:" anti-trigger (§7 step 6)', async () => {
    const d = deps({ ...cleanOut, description: 'Use when a queryset returns duplicate rows.' });
    const res = await distillClusters([cluster()], d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/Not for/);
  });

  it('drops a lesson body that states an imperative counterfactual as fact (verified-counterfactual rule)', async () => {
    const prescriptive = CONFORMANT_BODY.replace(
      'An order_by on a joined column can re-expand the rows distinct() collapsed.',
      'Instead, use select_related() to avoid the fan-out entirely.',
    );
    const d = deps({ ...cleanOut, body: prescriptive });
    const res = await distillClusters([cluster({ tier: 'lesson' })], d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/counterfactual/);
  });

  it('allows the same prescriptive language in a CONTRASTIVE skill (its counterfactual is the verified pass)', async () => {
    const prescriptive = CONFORMANT_BODY.replace(
      'An order_by on a joined column can re-expand the rows distinct() collapsed.',
      'Instead, use select_related() to avoid the fan-out entirely.',
    );
    const d = deps({ ...cleanOut, body: prescriptive });
    const res = await distillClusters([cluster({ tier: 'contrastive' })], d);
    expect(res.published).toHaveLength(1);
  });
});

function stage1(clusterId: string, skillKind: 'failure-lesson' | 'strategic-pattern' | 'contrastive', instanceId: string): Stage1PublishedSkill {
  return {
    clusterId,
    skillKind,
    evidenceRefs: [`ev-${instanceId}`],
    instanceIds: [instanceId],
    pkg: {
      name: `s-${instanceId}`,
      description: `Use when ${instanceId}. Not for: unrelated.`,
      license: null,
      jinn: {
        schema: 'jinn.skill.v1', distribution: 'coding', verifiabilityTier: 'evaluator-verified',
        distilledFrom: 1, provenance: [`ev-${instanceId}`],
      },
      // a full 5-section body so the union of source bodies dwarfs one meta body (AC4)
      body: CONFORMANT_BODY,
    },
  };
}

function metaDeps(out: MetaDistillLLMOutput, over: Partial<MetaDistillDeps> = {}): MetaDistillDeps & { published: SkillPackage[] } {
  const published: SkillPackage[] = [];
  return {
    published,
    slate: { instanceIds: new Set(['django__django-99999']) },
    metaDistill: async () => out,
    publishSkill: async (pkg) => { published.push(pkg); return { envelopeRef: `meta-${pkg.name}`, anchorTx: null }; },
    now: () => new Date('2026-07-08T00:00:00.000Z'),
    ...over,
  } as MetaDistillDeps & { published: SkillPackage[] };
}

const cleanMetaOut: MetaDistillLLMOutput = {
  name: 'cross-instance-dedup-lesson',
  description: 'Use when a class of queries fans out rows across joins. Not for: single-table reads.',
  body: CONFORMANT_BODY,
  supports: ['s1', 's2'],
};

describe('metaDistill (stage-2 cross-instance, §7 issue #1463)', () => {
  const failureBatch = () => buildMetaClusters([
    stage1('lesson:instA', 'failure-lesson', 'instA'),
    stage1('lesson:instB', 'failure-lesson', 'instB'),
  ]);

  it('AC1: publishes a cross-instance skill whose provenance unions the supporting evidence CIDs (distilledFrom > 1)', async () => {
    const d = metaDeps(cleanMetaOut);
    const res = await metaDistill(failureBatch(), d);
    expect(res.published).toHaveLength(1);
    expect(res.published[0]!.skillKind).toBe('cross-instance');
    const jinn = d.published[0]!.jinn;
    expect(jinn.skillKind).toBe('cross-instance');
    expect(jinn.provenance.sort()).toEqual(['ev-instA', 'ev-instB']);
    expect(jinn.distilledFrom).toBe(2);
    expect(jinn.distillPromptSha256).toBe(JINN_SKILL_META_DISTILL_PROMPT_V1_SHA256);
  });

  it('AC2: four briefcase-style failure sources across 4 instances → ≥1 corroborated skill linking ≥2', async () => {
    const four = buildMetaClusters([
      stage1('lesson:bc1', 'failure-lesson', 'bc1'),
      stage1('lesson:bc2', 'failure-lesson', 'bc2'),
      stage1('lesson:bc3', 'failure-lesson', 'bc3'),
      stage1('lesson:bc4', 'failure-lesson', 'bc4'),
    ]);
    const d = metaDeps({ ...cleanMetaOut, supports: ['s1', 's3', 's4'] });
    const res = await metaDistill(four, d);
    expect(res.published).toHaveLength(1);
    expect(d.published[0]!.jinn.provenance.sort()).toEqual(['ev-bc1', 'ev-bc3', 'ev-bc4']);
    expect(d.published[0]!.jinn.provenance.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects when the model corroborates fewer than 2 distinct instances', async () => {
    const d = metaDeps({ ...cleanMetaOut, supports: ['s1'] });
    const res = await metaDistill(failureBatch(), d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/fewer than 2 distinct/i);
  });

  it('rejects (publishes nothing) when 2 distinct instances collapse to <2 union evidence refs', async () => {
    // metaDistill is exported; a direct caller can bypass buildMetaClusters and pass
    // sources across 2 distinct instances whose evidenceRefs share a single ref, so the
    // union provenance is 1 — violating distilledFrom > 1. The publish-boundary guard drops it.
    const cluster: MetaCluster = {
      metaClusterId: 'cross-instance:failure-lesson',
      polarity: 'failure-lesson',
      gateTier: 'lesson',
      sources: [
        { id: 's1', name: 's-instA', description: 'Use when instA. Not for: unrelated.', body: CONFORMANT_BODY, evidenceRefs: ['ev-shared'], instanceIds: ['instA'] },
        { id: 's2', name: 's-instB', description: 'Use when instB. Not for: unrelated.', body: CONFORMANT_BODY, evidenceRefs: ['ev-shared'], instanceIds: ['instB'] },
      ],
    };
    const d = metaDeps(cleanMetaOut);
    const res = await metaDistill([cluster], d);
    expect(res.published).toHaveLength(0);
    expect(d.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/fewer than 2 evidence refs/i);
  });

  it('AC3: a meta skill missing a skeleton section is rejected by the SAME structural gate', async () => {
    const noVerify = CONFORMANT_BODY.replace(/## Verify[\s\S]*$/, '').trimEnd() + '\n';
    const d = metaDeps({ ...cleanMetaOut, body: noVerify });
    const res = await metaDistill(failureBatch(), d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/skeleton: missing section "## Verify"/);
  });

  it('AC3: a meta skill whose body names a slate token is dropped by the SAME contamination scan', async () => {
    const d = metaDeps({ ...cleanMetaOut, body: CONFORMANT_BODY + '\nsee django__django-99999\n' });
    const res = await metaDistill(failureBatch(), d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/contamination/);
  });

  it('AC4: evidenceTokens (union of source bodies) exceeds skillTokens (one meta body)', async () => {
    const d = metaDeps(cleanMetaOut);
    await metaDistill(failureBatch(), d);
    const jinn = d.published[0]!.jinn;
    expect(jinn.evidenceTokens!).toBeGreaterThan(jinn.skillTokens!);
  });

  it('holds the failure-lesson diagnosis-only rule via the shared gate tier', async () => {
    const prescriptive = CONFORMANT_BODY.replace(
      'An order_by on a joined column can re-expand the rows distinct() collapsed.',
      'Instead, use select_related() to avoid the fan-out entirely.',
    );
    const d = metaDeps({ ...cleanMetaOut, body: prescriptive });
    const res = await metaDistill(failureBatch(), d);
    expect(res.published).toHaveLength(0);
    expect(res.rejected[0]!.reason).toMatch(/counterfactual/);
  });
});
