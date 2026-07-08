import { describe, it, expect } from 'vitest';
import {
  buildSkillMarkdown,
  parseSkillMarkdown,
  assertConformantName,
  SKILL_ARTIFACT_TYPE,
  type SkillPackage,
} from '../src/skill-package.js';

const pkg: SkillPackage = {
  name: 'django-queryset-dedup-debugging',
  description: 'Use when a Django ORM queryset returns duplicate rows after a join or prefetch.',
  license: null,
  jinn: {
    schema: 'jinn.skill.v1',
    distribution: 'coding',
    verifiabilityTier: 'evaluator-verified',
    distilledFrom: 3,
    provenance: ['bafy-ref-1', 'bafy-ref-2', 'bafy-ref-3'],
    distillPromptSha256: 'a'.repeat(64),
  },
  body: '# Django queryset dedup\n\nUse `.distinct()` after the join.\n',
};

describe('jinn.skill.v1 package builder (skill-package.ts)', () => {
  it('round-trips through markdown (EXPORT mode embeds metadata.jinn)', () => {
    const md = buildSkillMarkdown(pkg);
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('name: django-queryset-dedup-debugging');
    expect(md).toContain('jinn:');
    expect(parseSkillMarkdown(md)).toEqual(pkg);
  });

  it('embedProvenance: false renders name/description only (canonical-form skillMd, anti-drift)', () => {
    const md = buildSkillMarkdown(pkg, { embedProvenance: false });
    expect(md).toContain('name: django-queryset-dedup-debugging');
    expect(md).not.toContain('metadata:');
    expect(md).not.toContain('jinn:');
    expect(md).toContain('# Django queryset dedup');
    // and is NOT parseable as a full exported package (no provenance block)
    expect(() => parseSkillMarkdown(md)).toThrow();
  });

  it('exposes the artifact type constant (re-exported from the canonical types module)', () => {
    expect(SKILL_ARTIFACT_TYPE).toBe('jinn.skill.v1');
  });

  it('rejects a non-conformant skill name', () => {
    expect(() => assertConformantName('Django_Queryset')).toThrow();
    expect(() => assertConformantName('django-queryset-dedup-debugging')).not.toThrow();
  });

  it('rejects markdown missing required frontmatter', () => {
    expect(() => parseSkillMarkdown('# no frontmatter')).toThrow();
  });

  it('rejects a frontmatter with a malformed jinn block', () => {
    const bad = ['---', 'name: x', 'description: y', 'metadata:', '  jinn:', '    schema: wrong', '---', 'body'].join('\n');
    expect(() => parseSkillMarkdown(bad)).toThrow();
  });

  it('accepts the optional skillKind on the meta block', () => {
    const withKind: SkillPackage = { ...pkg, jinn: { ...pkg.jinn, skillKind: 'failure-lesson' } };
    expect(parseSkillMarkdown(buildSkillMarkdown(withKind)).jinn.skillKind).toBe('failure-lesson');
  });

  it('accepts the additive cross-instance skillKind on the meta block', () => {
    const withKind: SkillPackage = { ...pkg, jinn: { ...pkg.jinn, skillKind: 'cross-instance' } };
    expect(parseSkillMarkdown(buildSkillMarkdown(withKind)).jinn.skillKind).toBe('cross-instance');
  });
});
