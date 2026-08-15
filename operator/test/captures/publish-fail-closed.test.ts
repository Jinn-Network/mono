import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '../../src/store/store.js';
import { CapturesStore } from '../../src/store/captures.js';
import { publishCaptureEnvelope, type CapturePublishDeps } from '../../src/captures/publish.js';
import { buildScrubPipeline } from '../../src/trajectory/scrub/build.js';
import { maybeBuildPiiDetector } from '../../src/trajectory/scrub/pii-build.js';

const SAFE = `0x${'1'.repeat(40)}` as const;
const AGENT = `0x${'2'.repeat(40)}` as const;
const PLAINTEXT = 'this raw capture content must never reach IPFS';

// B1 end-to-end: when ML PII is enabled but the model failed to load, the
// resulting pipeline's ML stage hard-throws on every scrub call. The publish
// path runs the scrub BEFORE any artifact upload, so the throw aborts the
// publish and NOTHING is published — fail closed, no raw leak. The daemon staying
// alive is covered by pii-build.test.ts (construction no longer throws); this
// proves the publish-altitude abort actually fires and does not leak.
describe('publishCaptureEnvelope fails closed when ML PII enabled but model failed to load', () => {
  let store: Store;
  let captures: CapturesStore;

  beforeEach(() => {
    store = new Store(':memory:');
    captures = new CapturesStore(store);
    captures.savePending({
      sessionId: 'fc-1',
      capturedAt: '2026-05-08T00:00:00.000Z',
      originatingTool: { name: 'claude-code', version: '1.0.0' },
      capturePath: 'A',
      status: 'pending',
      spanCount: 1,
      durationMs: 1000,
      redactedSpanCount: 0,
      repoRemoteUrl: 'git@example.com:repo.git',
      repoCommitHash: 'a'.repeat(40),
    });
    captures.appendSpan({
      sessionId: 'fc-1',
      spanId: 'b'.repeat(16),
      traceId: 'c'.repeat(32),
      parentSpanId: null,
      name: 'tool',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'tool', 'tool.output': PLAINTEXT },
      redactedKeys: [],
    });
  });

  afterEach(() => store.close());

  it('aborts the publish and uploads nothing (no raw trajectory)', async () => {
    const piiDetector = await maybeBuildPiiDetector(
      { enabled: true },
      () => {},
      {
        create() {
          return {
            async init() {
              throw new Error('model download failed');
            },
            async detect() {
              return [];
            },
          };
        },
      },
    );
    expect(piiDetector).toBeDefined(); // fail-closed detector, not undefined
    const scrubPipeline = buildScrubPipeline({ piiDetector });

    const publishedArtifacts: Array<{ artifactType: string; payload: unknown }> = [];
    const deps: CapturePublishDeps = {
      captures,
      participant: { safeAddress: SAFE, agentEoa: AGENT },
      signer: { address: AGENT },
      clientGitSha: 'abc1234',
      defaultArtifactEndpoint: 'https://operator.example/artifacts',
      scrubPipeline,
      publishArtifact: async ({ artifactType, payload }) => {
        publishedArtifacts.push({ artifactType, payload });
        return {
          cid: `bafy${artifactType.replace(/[^a-z0-9]/gi, '')}`,
          sha256: 'd'.repeat(64),
          endpoint: 'https://operator.example/artifacts',
          priceUsdc: '0',
        };
      },
      publishEnvelope: async () => ({ cid: 'bafyenvelope', sha256: 'e'.repeat(64) }),
      anchorEnvelope: async () => ({ txHash: `0x${'e'.repeat(64)}`, blockNumber: 1 }),
      signEnvelope: async () => ({
        algo: 'secp256k1',
        signer: AGENT,
        hash: `0x${'f'.repeat(64)}`,
        sig: `0x${'0'.repeat(130)}`,
      }),
      now: () => new Date('2026-05-08T00:00:02.000Z'),
    };

    // publish must reject with the fail-closed error...
    await expect(publishCaptureEnvelope('fc-1', deps)).rejects.toThrow(/failing closed|NOT published/i);
    // ...and crucially must NOT have uploaded any artifact (no raw leak to IPFS).
    expect(publishedArtifacts).toEqual([]);
  });
});
