/**
 * jinn.skill.v1 tests (issue #1394): publish-side dual-carriage, extractSkill
 * both-shape recognition, and the publish -> corpus-record round trip.
 */
import { describe, it, expect } from 'vitest';
import type { SignedEnvelope } from '../../../src/types/envelope.js';
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  type SkillArtifactV1,
} from '../../../src/types/skill-artifact.js';
import { capture, type CapturedTask } from '../src/capture.js';
import {
  EPISODE_ARTIFACT_TYPE,
  publish,
  TRACE_ENVELOPE_ARTIFACT_TYPE,
  toTraceEnvelope,
  type HarnessPublishDeps,
} from '../src/publish.js';
import { createMemoryLedger } from '../src/ledger.js';
import type { CorpusRecord } from '../src/consume.js';
import { extractSkill } from '../src/skill.js';

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SAFE = '0x1111111111111111111111111111111111111111' as const;

function skillArtifact(overrides: Partial<SkillArtifactV1> = {}): SkillArtifactV1 {
  return {
    schemaVersion: 'jinn.skill.v1',
    skill: {
      name: 'write-tests',
      description: 'Write tests before code',
      skillMd: '# write-tests\n\nAlways write a failing test first.',
    },
    files: [
      {
        path: 'reference/EXAMPLES.md',
        contentBase64: Buffer.from('# examples\n').toString('base64'),
        sha256: '20a7e6cb8d9f96040367dee3fbe4b2855420faf904e2e5822304ea7897c5b5a2',
      },
    ],
    provenance: {
      kind: 'distilled',
      sourceEnvelopeCids: ['bafySrc1'],
      operator: { safeAddress: TEST_SAFE },
      solverType: 'skill-distiller.v0',
    },
    ...overrides,
  };
}

function capturedTask(): CapturedTask {
  const nano = '1751587200000000000';
  return {
    session: { sessionId: 'sess-skill-1', capturedAt: '2026-07-04T00:00:00.000Z' },
    task: { summary: 'Distill a skill from traces', distributionTags: ['skills', 'tdd'] },
    environment: {
      harness: { name: 'test-harness', version: '0.0.1' },
      model: 'none',
      tools: [],
    },
    steps: [
      {
        spanId: 's1',
        parentSpanId: null,
        name: 'distill',
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
        attributes: { note: 'hello' },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
    cost: { durationMs: 0 },
    provenance: 'contributed',
  };
}

function mockPublishDeps(): {
  deps: HarnessPublishDeps;
  published: Array<{ artifactType: string; payload: unknown }>;
  envelopes: SignedEnvelope[];
} {
  const published: Array<{ artifactType: string; payload: unknown }> = [];
  const envelopes: SignedEnvelope[] = [];
  const deps: HarnessPublishDeps = {
    participant: { safeAddress: TEST_SAFE, agentEoa: TEST_ADDRESS },
    signer: { address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY },
    clientGitSha: 'test-sha',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: createMemoryLedger(),
    publishArtifact: async (input) => {
      published.push(input);
      return { cid: `bafy-artifact-${published.length}` };
    },
    publishEnvelope: async (envelope) => {
      envelopes.push(envelope);
      return { cid: `bafy-envelope-${envelopes.length}`, sha256: 'b'.repeat(64) };
    },
    anchorEnvelope: async () => ({
      txHash: `0x${'cd'.repeat(32)}` as `0x${string}`,
      blockNumber: 7,
    }),
  };
  return { deps, published, envelopes };
}

describe('publish() with opts.skill (dual-carriage)', () => {
  it('publishes the episode AND the skill artifact on the same wrapper envelope', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const pending = await capture(capturedTask());
    const result = await publish(pending, deps, { skill: skillArtifact() });
    if (result.vetoed) throw new Error('unexpected veto');

    expect(published.map((p) => p.artifactType)).toEqual([
      EPISODE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);
    expect(SkillArtifactV1Schema.parse(published[1]!.payload).skill.name).toBe('write-tests');

    expect(envelopes).toHaveLength(1);
    const artifacts = envelopes[0]!.artifacts;
    expect(artifacts.map((a) => a.artifactType)).toEqual([
      EPISODE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);
    const skillEntry = artifacts[1]!;
    // Standard access/pricing fields on the enclosing Artifact entry (AC1).
    expect(skillEntry.access.endpoint).toBe('http://127.0.0.1:7331');
    expect(skillEntry.access.priceUsdc).toBe('0');
    expect(skillEntry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(skillEntry.sources?.[0]?.cid).toBe('bafy-artifact-2');
    // metadata.tags mirror the episode's distribution tags.
    expect(skillEntry.metadata?.tags).toEqual(['skills', 'tdd']);
  });

  it('rejects an invalid skill payload before anything is uploaded', async () => {
    const { deps, published } = mockPublishDeps();
    const pending = await capture(capturedTask());
    const bad = { ...skillArtifact(), schemaVersion: 'nope' } as unknown as SkillArtifactV1;
    await expect(publish(pending, deps, { skill: bad })).rejects.toThrow();
    expect(published).toHaveLength(0);
  });

  it('publish without opts.skill is byte-identical to today: one artifact', async () => {
    const { deps, envelopes } = mockPublishDeps();
    const pending = await capture(capturedTask());
    const result = await publish(pending, deps);
    if (result.vetoed) throw new Error('unexpected veto');
    expect(envelopes[0]!.artifacts.map((a) => a.artifactType)).toEqual([
      EPISODE_ARTIFACT_TYPE,
    ]);
  });

  it('veto with a skill still publishes nothing', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const pending = await capture(capturedTask());
    const result = await publish(pending, deps, { veto: true, skill: skillArtifact() });
    expect(result.vetoed).toBe(true);
    expect(published).toHaveLength(0);
    expect(envelopes).toHaveLength(0);
  });
});

/** Reconstruct the CorpusRecord `corpus get` would return for a publish. */
function toRecord(
  envelope: SignedEnvelope,
  published: Array<{ artifactType: string; payload: unknown }>,
  ref: string,
): CorpusRecord {
  return {
    ref,
    envelope,
    provenance: {
      operator: { agentId: '7', safeAddress: TEST_SAFE },
      evidenceTier: 'self-signed',
      publishedAt: 1,
    },
    artifacts: envelope.artifacts.map((a) => {
      const p = published.find((x) => x.artifactType === a.artifactType);
      if (!p) throw new Error(`no published payload for ${a.artifactType}`);
      const content = Buffer.from(JSON.stringify(p.payload), 'utf-8');
      return {
        sha256: a.sha256,
        artifactType: a.artifactType,
        content,
        source: 'origin' as const,
        sizeBytes: content.length,
      };
    }),
  };
}

/** The seeded shape exactly as seed-import/execute.ts publishes it today. */
function legacySeededTask(): CapturedTask {
  const nano = '1751587200000000000';
  return {
    session: { sessionId: 'seed:acme/skills/write-tests', capturedAt: '2026-07-04T00:00:00.000Z' },
    task: { summary: 'Seed import: acme/skills/write-tests', distributionTags: ['seed-import', 'skills', 'write-tests'] },
    environment: { harness: { name: 'jinn-layer-seed-import', version: '0.1.0' }, model: 'none', tools: [] },
    steps: [
      {
        spanId: 'seed-1',
        parentSpanId: null,
        name: 'seed:skill-md',
        startTimeUnixNano: nano,
        endTimeUnixNano: nano,
        attributes: {
          'skill.md': '# write-tests\n\nAlways write a failing test first.',
          'seed.attribution': {
            skill: 'acme/skills/write-tests',
            source: 'https://github.com/acme/skills',
            licence: 'MIT',
          },
        },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'user-accepted' },
    cost: { durationMs: 0 },
    provenance: 'imported',
  };
}

describe('extractSkill()', () => {
  it('round-trips a published jinn.skill.v1 artifact (publish -> record -> extract)', async () => {
    const input = skillArtifact();
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(capturedTask()), deps, { skill: input });
    if (result.vetoed) throw new Error('unexpected veto');

    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    const extracted = extractSkill(record);
    expect(extracted).not.toBeNull();
    expect(extracted!.shape).toBe('jinn.skill.v1');
    expect(extracted!.skill).toEqual(input);
  });

  it('recognises the canonical seeded episode and synthesises equivalent provenance', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(legacySeededTask()), deps); // no opts.skill
    if (result.vetoed) throw new Error('unexpected veto');

    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    const extracted = extractSkill(record);
    expect(extracted).not.toBeNull();
    expect(extracted!.shape).toBe('seeded-episode');
    expect(extracted!.skill.skill.name).toBe('write-tests');
    expect(extracted!.skill.skill.skillMd).toContain('failing test first');
    expect(extracted!.skill.files).toEqual([]);
    expect(extracted!.skill.provenance).toMatchObject({
      kind: 'imported',
      // [] for seed imports (the documented convention) — the carrying
      // record's own ref is already record.ref.
      sourceEnvelopeCids: [],
      operator: { safeAddress: TEST_SAFE },
      seed: {
        skill: 'acme/skills/write-tests',
        source: 'https://github.com/acme/skills',
        licence: 'MIT',
      },
    });
  });

  it('retains frozen read compatibility for the legacy seeded trace shape', async () => {
    const pending = await capture(legacySeededTask());
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(pending, deps);
    if (result.vetoed) throw new Error('unexpected veto');

    const canonical = toRecord(envelopes[0]!, published, result.envelopeRef);
    const legacyPayload = toTraceEnvelope(pending);
    const legacyContent = Buffer.from(JSON.stringify(legacyPayload), 'utf-8');
    const record: CorpusRecord = {
      ...canonical,
      artifacts: [{
        sha256: 'a'.repeat(64),
        artifactType: TRACE_ENVELOPE_ARTIFACT_TYPE,
        content: legacyContent,
        source: 'origin',
        sizeBytes: legacyContent.length,
      }],
    };

    const extracted = extractSkill(record);
    expect(extracted?.shape).toBe('seeded-trace');
    expect(extracted?.skill.skill.name).toBe('write-tests');
  });

  it('prefers the jinn.skill.v1 artifact when both shapes are present', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(legacySeededTask()), deps, {
      skill: skillArtifact(),
    });
    if (result.vetoed) throw new Error('unexpected veto');
    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    expect(extractSkill(record)!.shape).toBe('jinn.skill.v1');
  });

  it('round-trips a jinn.skill.v1 artifact carrying skillKind cross-instance (enum widened downstream)', async () => {
    const input = skillArtifact({
      provenance: {
        kind: 'distilled',
        sourceEnvelopeCids: ['bafySrc1', 'bafySrc2'],
        operator: { safeAddress: TEST_SAFE },
        solverType: 'skill-distiller.v0',
        skillKind: 'cross-instance',
      },
    });
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(capturedTask()), deps, { skill: input });
    if (result.vetoed) throw new Error('unexpected veto');
    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    const extracted = extractSkill(record);
    expect(extracted!.shape).toBe('jinn.skill.v1');
    expect(extracted!.skill.provenance.skillKind).toBe('cross-instance');
  });

  it('returns null for a record with no skill in either shape', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(capturedTask()), deps);
    if (result.vetoed) throw new Error('unexpected veto');
    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    expect(extractSkill(record)).toBeNull();
  });

  it('surfaces supersede lineage on the extracted provenance (#1462)', async () => {
    const input = skillArtifact({
      provenance: {
        kind: 'distilled',
        sourceEnvelopeCids: ['bafySrc1'],
        operator: { safeAddress: TEST_SAFE },
        solverType: 'skill-distiller.v0',
        supersedes: 'bafyPrev',
        deprecates: true,
      },
    });
    const { deps, published, envelopes } = mockPublishDeps();
    const result = await publish(await capture(capturedTask()), deps, { skill: input });
    if (result.vetoed) throw new Error('unexpected veto');
    const record = toRecord(envelopes[0]!, published, result.envelopeRef);
    const extracted = extractSkill(record);
    expect(extracted!.skill.provenance.supersedes).toBe('bafyPrev');
    expect(extracted!.skill.provenance.deprecates).toBe(true);
  });
});
