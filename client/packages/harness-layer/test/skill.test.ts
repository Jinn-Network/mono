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
  publish,
  TRACE_ENVELOPE_ARTIFACT_TYPE,
  type HarnessPublishDeps,
} from '../src/publish.js';
import { createMemoryLedger } from '../src/ledger.js';

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SAFE = '0x1111111111111111111111111111111111111111' as const;

export function skillArtifact(overrides: Partial<SkillArtifactV1> = {}): SkillArtifactV1 {
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

export function capturedTask(): CapturedTask {
  const nano = '1751587200000000000';
  return {
    session: { sessionId: 'sess-skill-1', capturedAt: '2026-07-04T00:00:00.000Z' },
    task: { summary: 'Distil a skill from traces', distributionTags: ['skills', 'tdd'] },
    environment: {
      harness: { name: 'test-harness', version: '0.0.1' },
      model: 'none',
      tools: [],
    },
    steps: [
      {
        spanId: 's1',
        parentSpanId: null,
        name: 'distil',
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

export function mockPublishDeps(): {
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
  it('publishes the trace AND the skill artifact on the same wrapper envelope', async () => {
    const { deps, published, envelopes } = mockPublishDeps();
    const pending = await capture(capturedTask());
    const result = await publish(pending, deps, { skill: skillArtifact() });
    if (result.vetoed) throw new Error('unexpected veto');

    expect(published.map((p) => p.artifactType)).toEqual([
      TRACE_ENVELOPE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);
    expect(SkillArtifactV1Schema.parse(published[1]!.payload).skill.name).toBe('write-tests');

    expect(envelopes).toHaveLength(1);
    const artifacts = envelopes[0]!.artifacts;
    expect(artifacts.map((a) => a.artifactType)).toEqual([
      TRACE_ENVELOPE_ARTIFACT_TYPE,
      SKILL_ARTIFACT_TYPE,
    ]);
    const skillEntry = artifacts[1]!;
    // Standard access/pricing fields on the enclosing Artifact entry (AC1).
    expect(skillEntry.access.endpoint).toBe('http://127.0.0.1:7331');
    expect(skillEntry.access.priceUsdc).toBe('0');
    expect(skillEntry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(skillEntry.sources?.[0]?.cid).toBe('bafy-artifact-2');
    // metadata.tags mirror the trace's distribution tags.
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
      TRACE_ENVELOPE_ARTIFACT_TYPE,
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
