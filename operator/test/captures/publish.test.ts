import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { CapturesStore } from '../../src/store/captures.js';
import {
  buildUnsignedCaptureEnvelope,
  publishCaptureEnvelope,
  sha256Hex,
  type CapturePublishDeps,
} from '../../src/captures/publish.js';
import { canonicalJson } from '../../src/util/canonical-json.js';
import { EMPTY_BUNDLE_SHA256 } from '../../src/trajectory/schema.js';

const SAFE = `0x${'1'.repeat(40)}` as const;
const AGENT = `0x${'2'.repeat(40)}` as const;

describe('publishCaptureEnvelope', () => {
  let store: Store;
  let captures: CapturesStore;

  beforeEach(() => {
    store = new Store(':memory:');
    captures = new CapturesStore(store);
    captures.savePending({
      sessionId: 'sess-1',
      capturedAt: '2026-05-08T00:00:00.000Z',
      originatingTool: { name: 'claude-code', version: '1.0.0' },
      capturePath: 'A',
      status: 'pending',
      spanCount: 1,
      durationMs: 1_500,
      redactedSpanCount: 1,
      repoRemoteUrl: 'git@example.com:repo.git',
      repoCommitHash: 'a'.repeat(40),
    });
    captures.appendSpan({
      sessionId: 'sess-1',
      spanId: 'b'.repeat(16),
      traceId: 'c'.repeat(32),
      parentSpanId: null,
      name: 'llm-call',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.session.id': 'sess-1', prompt: '[REDACTED]' },
      redactedKeys: ['prompt'],
    });
  });

  afterEach(() => {
    store.close();
  });

  it('builds a schema-valid unsigned capture envelope with session provenance', () => {
    const capture = captures.getBySession('sess-1')!;
    const unsigned = buildUnsignedCaptureEnvelope({
      capture,
      now: new Date('2026-05-08T00:00:02.000Z'),
      participant: { safeAddress: SAFE, agentEoa: AGENT },
      signerAddress: AGENT,
      clientGitSha: 'abc1234',
      artifacts: [],
      harnessBundleSha: EMPTY_BUNDLE_SHA256,
    });

    expect(unsigned.role).toBe('capture');
    expect(unsigned.task).toBeUndefined();
    expect(unsigned.trajectory).toBeNull();
    expect(unsigned.sessionProvenance?.repo?.commitHash).toBe('a'.repeat(40));
    expect(unsigned.executor.codeDigest).toBe(`sha256:${EMPTY_BUNDLE_SHA256}`);
  });

  it('pins trajectory and harness bundle, signs the envelope, and anchors envelope metadata', async () => {
    const publishedArtifacts: Array<{ artifactType: string; payload: unknown }> = [];
    const publishedEnvelopes: unknown[] = [];
    const deps: CapturePublishDeps = {
      captures,
      participant: { safeAddress: SAFE, agentEoa: AGENT },
      signer: { address: AGENT },
      clientGitSha: 'abc1234',
      defaultArtifactEndpoint: 'https://operator.example/artifacts',
      publishArtifact: async ({ artifactType, payload }) => {
        publishedArtifacts.push({ artifactType, payload });
        const sha256 = sha256Hex(canonicalJson(payload));
        return {
          cid: `bafy${artifactType.replace(/[^a-z0-9]/gi, '')}`,
          sha256,
          endpoint: `https://operator.example/artifacts/${sha256}`,
          priceUsdc: '0',
        };
      },
      publishEnvelope: async (envelope) => {
        publishedEnvelopes.push(envelope);
        return {
          cid: 'bafyenvelope',
          sha256: sha256Hex(canonicalJson(envelope)),
        };
      },
      anchorEnvelope: async (input) => ({
        txHash: `0x${'e'.repeat(64)}`,
        blockNumber: input.metadataKey === 'capture:bafyenvelope' ? 123 : 0,
      }),
      signEnvelope: async () => ({
        algo: 'secp256k1',
        signer: AGENT,
        hash: `0x${'f'.repeat(64)}`,
        sig: `0x${'0'.repeat(130)}`,
      }),
      resolveHarnessBundle: () => ({
        manifest: {
          schemaVersion: 'harness-bundle.v1',
          bundleSha256: '9'.repeat(64),
          capturePath: 'A',
          tool: { name: 'claude-code', version: '1.0.0' },
          files: [{ path: 'CLAUDE.md', sha256: '8'.repeat(64), bytes: 12 }],
        },
      }),
      now: () => new Date('2026-05-08T00:00:02.000Z'),
    };

    const result = await publishCaptureEnvelope('sess-1', deps);

    expect(result.envelopeCid).toBe('bafyenvelope');
    expect(result.anchor).toEqual({ txHash: `0x${'e'.repeat(64)}`, blockNumber: 123 });
    expect(result.envelope.role).toBe('capture');
    expect(result.envelope.trajectory).toBeNull();
    expect(result.envelope.executor.codeDigest).toBe(`sha256:${'9'.repeat(64)}`);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts[0]).toMatchObject({
      artifactType: 'jinn.capture-trajectory.v1',
      sha256: result.trajectory.sha256,
      sources: [{
        kind: 'ipfs',
        cid: result.trajectory.cid,
        sha256: result.trajectory.sha256,
        encoding: 'jinn.artifact.donation.v1',
      }],
    });
    expect(result.artifacts[1].artifactType).toBe('harness-bundle.v1');
    expect(publishedArtifacts.map((a) => a.artifactType)).toEqual(['jinn.capture-trajectory.v1', 'harness-bundle.v1']);
    expect(publishedArtifacts[0].payload).toMatchObject({ schemaVersion: 'jinn.capture-trajectory.v1' });
    expect(publishedArtifacts[0].payload).not.toHaveProperty('signature');
    expect(publishedEnvelopes).toHaveLength(1);
  });

  it('rejects missing and non-pending captures before publishing side effects', async () => {
    captures.markSkipped('sess-1', { skippedAt: '2026-05-08T00:00:01.000Z' });
    await expect(publishCaptureEnvelope('sess-1', {
      captures,
      participant: { safeAddress: SAFE, agentEoa: AGENT },
      signer: { address: AGENT },
      clientGitSha: 'abc1234',
      publishArtifact: async () => { throw new Error('should not publish'); },
      publishEnvelope: async () => { throw new Error('should not publish'); },
      anchorEnvelope: async () => ({}),
      signEnvelope: async () => ({
        algo: 'secp256k1',
        signer: AGENT,
        hash: `0x${'f'.repeat(64)}`,
        sig: `0x${'0'.repeat(130)}`,
      }),
    })).rejects.toThrow('not pending');
  });
});
