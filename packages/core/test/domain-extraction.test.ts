import { describe, expect, it, vi } from 'vitest';
import {
  buildScrubPipeline,
  buildSeedScrubPipeline,
} from '../src/scrub/index.js';
import {
  JinnTrajectoryV1Schema,
  TranscriptEventSchema,
  CodexSessionParser,
} from '../src/trajectory/index.js';
import {
  createHttpCorpusDiscovery,
  fetchManifest,
  queryCaptureMeta,
  type EnvelopeRef,
} from '../src/corpus-read/index.js';

describe('core scrub domain (#1836)', () => {
  it('preserves the trace and seed scrub compositions', () => {
    const core = [
      'key-policy',
      'plain-patterns',
      'url-credentials',
      'reject-classes',
      'checksummed-instruments',
      'ip-address',
      'gitleaks',
      'secretlint',
    ];
    expect(buildScrubPipeline().components.map((component) => component.name)).toEqual([
      'key-policy',
      'openredaction',
      ...core.slice(1),
    ]);
    expect(buildSeedScrubPipeline().components.map((component) => component.name)).toEqual(core);
  });
});

describe('core trajectory domain (#1836)', () => {
  it('owns the trajectory schema and transcript parsers', () => {
    expect(JinnTrajectoryV1Schema.safeParse({
      schemaVersion: 'jinn.trajectory.v1',
      runId: 'run-1',
      parentEnvelopeCid: null,
      spans: [],
      redactionManifest: { spans: [], totalRedactions: 0 },
      signature: {
        algo: 'secp256k1',
        signer: `0x${'22'.repeat(20)}`,
        hash: `0x${'ef'.repeat(32)}`,
        sig: `0x${'12'.repeat(65)}`,
      },
    }).success).toBe(true);

    const parser = new CodexSessionParser();
    const [event] = parser.parseChunk({
      sessionId: 'session-1',
      chunk: `${JSON.stringify({
        role: 'user',
        ts: '2026-05-07T00:00:00.000Z',
        content: 'hello',
      })}\n`,
    });
    expect(TranscriptEventSchema.parse(event)).toMatchObject({
      kind: 'user-message',
      content: 'hello',
    });
  });
});

describe('core corpus-read boundaries (#1836)', () => {
  const ref: EnvelopeRef = {
    manifestCid: 'bafy-manifest',
    manifestHash: '0xabc',
    operator: { agentId: '7', safeAddress: '' },
    evidenceTier: 'self-signed',
    publishedAt: 123,
  };

  it('fetches and parses manifests through explicit IPFS and schema ports', async () => {
    const fetchFromIpfs = vi.fn(async () => ({ solverType: 'prediction.v1' }));
    const preview = await fetchManifest(
      ref,
      'https://gateway.example',
      {
        fetchFromIpfs,
        parseEnvelope(input) {
          const value = input as { solverType?: unknown };
          if (typeof value.solverType !== 'string') throw new Error('bad envelope');
          return {
            solverType: value.solverType,
            role: 'solution',
            generatedAt: 1,
            participant: { safeAddress: '' },
            artifacts: [],
          };
        },
      },
    );

    expect(fetchFromIpfs).toHaveBeenCalledWith('https://gateway.example', 'bafy-manifest');
    expect(preview).toEqual({
      ref,
      envelope: {
        solverType: 'prediction.v1',
        role: 'solution',
        generatedAt: 1,
        participant: { safeAddress: '' },
        artifacts: [],
      },
    });
  });

  it('owns the HTTP envelope-discovery client', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/ready')) return new Response('', { status: 200 });
      return Response.json({
        data: {
          envelopes: {
            items: [{
              agentId: '7',
              manifestCid: ref.manifestCid,
              manifestHash: ref.manifestHash,
              evidenceTier: ref.evidenceTier,
              publishedAtBlock: '123',
            }],
          },
        },
      });
    }) as unknown as typeof fetch;

    const discovery = createHttpCorpusDiscovery({
      url: 'https://indexer.example/graphql',
      fetchImpl,
      retryDelaysMs: [],
    });

    await expect(discovery.queryEnvelopes({ limit: 5 })).resolves.toEqual([ref]);
  });

  it('owns capture-meta search and degrades to an empty page', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json([{
        manifestCid: 'bafy-hit',
        taskSummary: 'Fix parser',
        tags: ['repo:mono'],
        provenance: 'capture',
        verifiabilityTier: 'local',
      }]))
      .mockRejectedValueOnce(new Error('offline')) as unknown as typeof fetch;

    await expect(queryCaptureMeta({
      url: 'https://indexer.example/capture-meta',
      query: 'parser',
      limit: 3,
      fetchImpl,
    })).resolves.toHaveLength(1);
    await expect(queryCaptureMeta({
      url: 'https://indexer.example/capture-meta',
      query: 'parser',
      limit: 3,
      fetchImpl,
    })).resolves.toEqual([]);
  });
});
