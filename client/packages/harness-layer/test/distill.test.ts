import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  distillClusters,
  lexicalContaminationScan,
  type DistillCluster,
  type DistillDeps,
  type DistillLLMOutput,
} from '../src/distill.js';
import { JINN_SKILL_DISTILL_PROMPT_V1, JINN_SKILL_DISTILL_PROMPT_V1_SHA256 } from '../src/distill-prompt.js';
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
    expect(pkg.jinn.provenance).toEqual(['bafyEv1', 'bafyEv2']);
    expect(pkg.jinn.distilledFrom).toBe(2);
    // round-trips as a conformant skill package
    expect(() => parseSkillMarkdown(buildSkillMarkdown(pkg))).not.toThrow();
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
