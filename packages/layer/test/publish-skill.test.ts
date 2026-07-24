import { describe, it, expect } from 'vitest';
import { publishSkill, toSkillArtifactV1, type SkillPublishDeps } from '../src/publish-skill.js';
import type { SkillPackage } from '../src/skill-package.js';
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  type SkillArtifactV1,
} from '@jinn-network/core';

const pkg: SkillPackage = {
  name: 'example-skill',
  description: 'Use when X.',
  license: null,
  jinn: {
    schema: 'jinn.skill.v1',
    distribution: 'coding',
    verifiabilityTier: 'evaluator-verified',
    distilledFrom: 1,
    provenance: ['bafy-src'],
    distillPromptSha256: 'b'.repeat(64),
    skillKind: 'strategic-pattern',
  },
  body: '# Example\n\nDo X.\n',
};

function fakeDeps(): SkillPublishDeps & {
  artifactUploads: Array<{ artifactType: string; payload: unknown }>;
  envelopes: unknown[];
  anchors: Array<{ metadataKey: string }>;
} {
  const artifactUploads: Array<{ artifactType: string; payload: unknown }> = [];
  const envelopes: unknown[] = [];
  const anchors: Array<{ metadataKey: string }> = [];
  return {
    artifactUploads,
    envelopes,
    anchors,
    participant: {
      safeAddress: `0x${'1'.repeat(40)}` as `0x${string}`,
      agentEoa: `0x${'2'.repeat(40)}` as `0x${string}`,
    },
    signer: { address: `0x${'2'.repeat(40)}` as `0x${string}`, privateKey: `0x${'a'.repeat(64)}` as `0x${string}` },
    clientGitSha: 'deadbeef',
    publishArtifact: async (i) => {
      artifactUploads.push(i);
      return { cid: 'cid-artifact', sha256: 'a'.repeat(64), endpoint: 'https://ipfs.example/artifact' };
    },
    publishEnvelope: async (e) => {
      envelopes.push(e);
      return { cid: 'cid-envelope' };
    },
    anchorEnvelope: async (i) => {
      anchors.push({ metadataKey: i.metadataKey });
      return { txHash: `0x${'e'.repeat(64)}` as `0x${string}` };
    },
  };
}

describe('toSkillArtifactV1 (SkillPackage → canonical #1394 artifact)', () => {
  it('maps onto SkillArtifactV1 with kind=distilled and the DR-2026-07-06 fields', () => {
    const art = toSkillArtifactV1(pkg, `0x${'1'.repeat(40)}`);
    expect(() => SkillArtifactV1Schema.parse(art)).not.toThrow();
    expect(art.provenance.kind).toBe('distilled');
    expect(art.provenance.sourceEnvelopeCids).toEqual(['bafy-src']);
    expect(art.provenance.operator.safeAddress).toBe(`0x${'1'.repeat(40)}`);
    expect(art.provenance.solverType).toBe('distilled-skill');
    expect(art.provenance.skillKind).toBe('strategic-pattern');
    expect(art.provenance.distillPromptSha256).toBe('b'.repeat(64));
    expect(art.provenance.distribution).toBe('coding');
    expect(art.provenance.verifiabilityTier).toBe('evaluator-verified');
  });

  it('maps the v0.5 auditability fields (distillModel + token estimates) and a contrastive skillKind', () => {
    const auditPkg: SkillPackage = {
      ...pkg,
      jinn: {
        ...pkg.jinn,
        skillKind: 'contrastive',
        distillModel: 'claude-opus-4-8',
        evidenceTokens: 1200,
        skillTokens: 90,
      },
    };
    const art = toSkillArtifactV1(auditPkg, `0x${'1'.repeat(40)}`);
    expect(() => SkillArtifactV1Schema.parse(art)).not.toThrow();
    expect(art.provenance.skillKind).toBe('contrastive');
    expect(art.provenance.distillModel).toBe('claude-opus-4-8');
    expect(art.provenance.evidenceTokens).toBe(1200);
    expect(art.provenance.skillTokens).toBe(90);
  });

  it('anti-drift: the stored skillMd carries name/description but NOT the metadata.jinn block', () => {
    const art = toSkillArtifactV1(pkg, `0x${'1'.repeat(40)}`);
    expect(art.skill.skillMd).toContain('name: example-skill');
    expect(art.skill.skillMd).toContain('description: Use when X.');
    expect(art.skill.skillMd).not.toContain('metadata:');
    expect(art.skill.skillMd).not.toContain('jinn:');
    expect(art.skill.skillMd).toContain('# Example');
  });

  // --- supersede lineage (issue #1462) ---

  it('omits supersedes/deprecates when no lifecycle is passed', () => {
    const art = toSkillArtifactV1(pkg, `0x${'1'.repeat(40)}`);
    expect(art.provenance.supersedes).toBeUndefined();
    expect(art.provenance.deprecates).toBeUndefined();
  });

  it('carries supersedes + deprecates when a lifecycle is passed', () => {
    const art = toSkillArtifactV1(pkg, `0x${'1'.repeat(40)}`, {
      supersedes: 'bafyPrev',
      deprecates: true,
    });
    expect(() => SkillArtifactV1Schema.parse(art)).not.toThrow();
    expect(art.provenance.supersedes).toBe('bafyPrev');
    expect(art.provenance.deprecates).toBe(true);
  });
});

describe('publishSkill', () => {
  it('publishes a canonical SkillArtifactV1 payload, discriminated by solverType, anchored under skill:', async () => {
    const deps = fakeDeps();
    const res = await publishSkill(pkg, deps);

    expect(res.envelopeRef).toBe('cid-envelope');
    expect(res.anchorTx).toBe(`0x${'e'.repeat(64)}`);

    // the artifact payload is the canonical, schema-valid SkillArtifactV1
    const skillUpload = deps.artifactUploads.find((c) => c.artifactType === SKILL_ARTIFACT_TYPE);
    expect(skillUpload).toBeTruthy();
    const payload = skillUpload!.payload as SkillArtifactV1;
    expect(() => SkillArtifactV1Schema.parse(payload)).not.toThrow();
    expect(payload.skill.name).toBe('example-skill');
    expect(payload.provenance.kind).toBe('distilled');

    // the wrapper envelope discriminates as distilled-skill, role capture
    const env = deps.envelopes[0] as { solverType: string; role: string; artifacts: Array<{ artifactType: string }> };
    expect(env.solverType).toBe('distilled-skill');
    expect(env.role).toBe('capture');
    expect(env.artifacts[0]!.artifactType).toBe(SKILL_ARTIFACT_TYPE);

    // anchored under a skill-scoped key (not capture:) — producer wiring is #1439
    expect(deps.anchors[0]!.metadataKey.startsWith('skill:')).toBe(true);
  });

  it('fails loud when the artifact blob has no endpoint and no default is set', async () => {
    const deps = fakeDeps();
    deps.publishArtifact = async () => ({ cid: 'cid-artifact', sha256: 'a'.repeat(64) }); // no endpoint
    await expect(publishSkill(pkg, deps)).rejects.toThrow(/no access endpoint/);
  });

  it('fails loud when no privateKey and no signEnvelope dep is provided', async () => {
    const deps = fakeDeps();
    deps.signer = { address: `0x${'2'.repeat(40)}` as `0x${string}` }; // no key
    await expect(publishSkill(pkg, deps)).rejects.toThrow(/privateKey or a signEnvelope/);
  });

  it('threads a lifecycle onto the uploaded skill-artifact provenance (#1462)', async () => {
    const deps = fakeDeps();
    await publishSkill(pkg, deps, { supersedes: 'bafyPrev' });

    const skillUpload = deps.artifactUploads.find((c) => c.artifactType === SKILL_ARTIFACT_TYPE);
    const payload = skillUpload!.payload as SkillArtifactV1;
    expect(payload.provenance.supersedes).toBe('bafyPrev');
    expect(payload.provenance.deprecates).toBeUndefined();
  });
});
