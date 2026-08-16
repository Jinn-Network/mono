import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { CapturesStore } from '../../src/store/captures.js';
import { publishCaptureEnvelope, type CapturePublishDeps } from '../../src/captures/publish.js';
import { buildScrubPipeline } from '../../src/trajectory/scrub/build.js';
import { ScrubPipeline } from '../../src/trajectory/scrub/pipeline.js';

const SAFE = `0x${'1'.repeat(40)}` as const;
const AGENT = `0x${'2'.repeat(40)}` as const;
const GH = 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012';

describe('publishCaptureEnvelope in-process scrub', () => {
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
      durationMs: 1000,
      redactedSpanCount: 0,
      repoRemoteUrl: 'git@example.com:repo.git',
      repoCommitHash: 'a'.repeat(40),
    });
    // A raw capture span carrying a secret in a content attribute. Captures are
    // stored raw at ingest (the OTLP receiver does not scrub); the seller-side
    // in-process pipeline must scrub it before the capture is published.
    captures.appendSpan({
      sessionId: 'sess-1',
      spanId: 'b'.repeat(16),
      traceId: 'c'.repeat(32),
      parentSpanId: null,
      name: 'tool',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'tool', 'tool.output': `leaked ${GH}` },
      redactedKeys: [],
    });
  });

  afterEach(() => store.close());

  function depsWith(extra: Partial<CapturePublishDeps>): CapturePublishDeps {
    return {
      captures,
      participant: { safeAddress: SAFE, agentEoa: AGENT },
      signer: { address: AGENT },
      clientGitSha: 'abc1234',
      defaultArtifactEndpoint: 'https://operator.example/artifacts',
      publishArtifact: async ({ artifactType }) => ({
        cid: `bafy${artifactType.replace(/[^a-z0-9]/gi, '')}`,
        sha256: 'd'.repeat(64),
        endpoint: 'https://operator.example/artifacts',
        priceUsdc: '0',
      }),
      publishEnvelope: async () => ({ cid: 'bafyenvelope', sha256: 'e'.repeat(64) }),
      anchorEnvelope: async () => ({ txHash: `0x${'e'.repeat(64)}`, blockNumber: 1 }),
      signEnvelope: async () => ({
        algo: 'secp256k1',
        signer: AGENT,
        hash: `0x${'f'.repeat(64)}`,
        sig: `0x${'0'.repeat(130)}`,
      }),
      now: () => new Date('2026-05-08T00:00:02.000Z'),
      ...extra,
    };
  }

  it('scrubs secrets from capture spans in-process before publishing', async () => {
    const publishedArtifacts: Array<{ artifactType: string; payload: unknown }> = [];
    await publishCaptureEnvelope(
      'sess-1',
      depsWith({
        scrubPipeline: buildScrubPipeline(),
        publishArtifact: async ({ artifactType, payload }) => {
          publishedArtifacts.push({ artifactType, payload });
          return {
            cid: `bafy${artifactType.replace(/[^a-z0-9]/gi, '')}`,
            sha256: 'd'.repeat(64),
            endpoint: 'https://operator.example/artifacts',
            priceUsdc: '0',
          };
        },
      }),
    );

    const trajectory = publishedArtifacts.find(
      (a) => a.artifactType === 'jinn.capture-trajectory.v1',
    );
    expect(trajectory).toBeDefined();
    // the published trajectory must not leak the secret anywhere
    expect(JSON.stringify(trajectory!.payload)).not.toContain(GH);
    const payload = trajectory!.payload as {
      redactionManifest: { totalRedactions: number; spans: Array<{ redactedKeys: string[] }> };
    };
    expect(payload.redactionManifest.totalRedactions).toBeGreaterThanOrEqual(1);
    expect(payload.redactionManifest.spans.some((s) => s.redactedKeys.includes('tool.output'))).toBe(
      true,
    );
  });

  it('scrubs by default when no pipeline is injected (absent → safe floor)', async () => {
    // The publish path is symmetric with the engine: a missing wire defaults to
    // buildScrubPipeline() (the non-ML safety floor), so a capture never leaks
    // raw just because no pipeline was passed.
    const publishedArtifacts: Array<{ artifactType: string; payload: unknown }> = [];
    await publishCaptureEnvelope(
      'sess-1',
      depsWith({
        publishArtifact: async ({ artifactType, payload }) => {
          publishedArtifacts.push({ artifactType, payload });
          return {
            cid: `bafy${artifactType.replace(/[^a-z0-9]/gi, '')}`,
            sha256: 'd'.repeat(64),
            endpoint: 'https://operator.example/artifacts',
            priceUsdc: '0',
          };
        },
      }),
    );
    const trajectory = publishedArtifacts.find(
      (a) => a.artifactType === 'jinn.capture-trajectory.v1',
    );
    expect(JSON.stringify(trajectory!.payload)).not.toContain(GH);
  });

  it('leaves the secret in place only with an explicit no-op pipeline (opt-out)', async () => {
    // The sole way to publish raw is to opt out *explicitly* by injecting an
    // empty (identity) pipeline — there is no operator config to disable scrub,
    // so absence is safe and only an explicit no-op pipeline is raw.
    const publishedArtifacts: Array<{ artifactType: string; payload: unknown }> = [];
    await publishCaptureEnvelope(
      'sess-1',
      depsWith({
        scrubPipeline: new ScrubPipeline([]),
        publishArtifact: async ({ artifactType, payload }) => {
          publishedArtifacts.push({ artifactType, payload });
          return {
            cid: `bafy${artifactType.replace(/[^a-z0-9]/gi, '')}`,
            sha256: 'd'.repeat(64),
            endpoint: 'https://operator.example/artifacts',
            priceUsdc: '0',
          };
        },
      }),
    );
    const trajectory = publishedArtifacts.find(
      (a) => a.artifactType === 'jinn.capture-trajectory.v1',
    );
    expect(JSON.stringify(trajectory!.payload)).toContain(GH);
  });
});

// Regression corpus (A1): each secret type below is planted in a `content`-class
// span attribute (`tool.output`) and the published capture trajectory must not
// leak it. Captures carry only content-class keys (synthetic-span-builder.ts), so
// the structural drop tier never bites — value-scrubbing is the entire defense.
// This locks in the recall the full owned pipeline (key-policy → plain-patterns
// → gitleaks/secretlint + entropy/shape → reject-classes) provides, so a future
// change can't silently regress it. Each row notes which stage is the load-bearing catch.
describe('publishCaptureEnvelope secret regression corpus', () => {
  const CORPUS: Array<{ name: string; secret: string; matchOn?: string; via: string }> = [
    // plain-patterns / gitleaks catch AKIA…; entropy alone misses it
    // (AKIA… is ≈3.68 bits/char, below the 4.0 floor).
    { name: 'AWS access key id', secret: 'AKIAIOSFODNN7EXAMPLE', via: 'plain-patterns / gitleaks (AWS_KEY)' },
    // A generic (non-provider-shaped) bearer/secret token: a random 31-char
    // base64url string. No specific provider rule matches it, so it exercises
    // the entropy fallback directly (the path the prior review flagged). Kept
    // provider-agnostic on purpose so it does not trip secret-scanning on a
    // real provider format.
    { name: 'generic high-entropy bearer token', secret: 'aZ4kQ9wX7vR2sT8yU1nB6mC4dF0gH5j', via: 'entropy fallback (high-entropy)' },
    {
      name: 'JWT',
      secret:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      via: 'secretlint / gitleaks (JWT)',
    },
    {
      // The whole connection string is redacted; assert the password substring is
      // what's gone (the part that must never leak).
      name: 'DB connection-string password',
      secret: 'connect with postgres://user:S3cr3tPw@host:5432/mydb please',
      matchOn: 'S3cr3tPw',
      via: 'url-credentials',
    },
    {
      // Entropy fallback redacts the PEM body line; markers may survive.
      // Catastrophic 64-hex private keys are A4 reject-publish (separate path).
      name: 'PEM private key body',
      secret:
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP\n-----END RSA PRIVATE KEY-----',
      matchOn: 'MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP',
      via: 'secretlint entropy (PEM body)',
    },
  ];

  let store: Store;
  let captures: CapturesStore;
  afterEach(() => store.close());

  function seed(secret: string): void {
    store = new Store(':memory:');
    captures = new CapturesStore(store);
    captures.savePending({
      sessionId: 'corpus-1',
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
      sessionId: 'corpus-1',
      spanId: 'b'.repeat(16),
      traceId: 'c'.repeat(32),
      parentSpanId: null,
      name: 'tool',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { 'jinn.span.kind': 'tool', 'tool.output': secret },
      redactedKeys: [],
    });
  }

  function deps(captured: Array<{ artifactType: string; payload: unknown }>): CapturePublishDeps {
    return {
      captures,
      participant: { safeAddress: SAFE, agentEoa: AGENT },
      signer: { address: AGENT },
      clientGitSha: 'abc1234',
      defaultArtifactEndpoint: 'https://operator.example/artifacts',
      scrubPipeline: buildScrubPipeline(),
      publishArtifact: async ({ artifactType, payload }) => {
        captured.push({ artifactType, payload });
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
  }

  for (const { name, secret, matchOn, via } of CORPUS) {
    it(`removes ${name} from the published trajectory (via ${via})`, async () => {
      seed(secret);
      const captured: Array<{ artifactType: string; payload: unknown }> = [];
      await publishCaptureEnvelope('corpus-1', deps(captured));
      const trajectory = captured.find((a) => a.artifactType === 'jinn.capture-trajectory.v1');
      expect(trajectory).toBeDefined();
      const serialized = JSON.stringify(trajectory!.payload);
      expect(serialized).not.toContain(matchOn ?? secret);
    });
  }
});
