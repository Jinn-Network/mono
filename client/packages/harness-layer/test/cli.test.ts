import { describe, it, expect, vi } from 'vitest';
import type { HarnessLayer, CorpusSearchHit, CorpusRecord } from '../src/consume.js';
import { runJinnLayerCli } from '../src/cli.js';

function fakeHit(overrides: Partial<CorpusSearchHit> = {}): CorpusSearchHit {
  return {
    title: 'prediction.v1 / solution',
    ref: 'bafyPred',
    solverType: 'prediction.v1',
    role: 'solution',
    artifactTypes: ['output.prediction.v1'],
    evidenceTier: 'self-signed',
    generatedAt: 1745978400,
    publishedAt: 1745978400,
    operator: { agentId: '7', safeAddress: '0x' + 'a'.repeat(40) },
    task: { cid: 'bafyTask', requestId: '0x' + 'b'.repeat(64) },
    ...overrides,
  };
}

function fakeLayer(opts: { hits?: CorpusSearchHit[]; record?: CorpusRecord }): HarnessLayer {
  return {
    config: {
      discoveryUrl: 'https://indexer.test',
      ipfsGatewayUrl: 'https://gateway.test',
      dbPath: ':memory:',
    },
    corpus: {
      search: vi.fn().mockResolvedValue(opts.hits ?? []),
      get: vi.fn().mockResolvedValue(opts.record),
    },
  };
}

function capture(): { writer: { write: (s: string) => boolean }; out: () => string } {
  let buf = '';
  return {
    writer: { write: (s: string) => { buf += s; return true; } },
    out: () => buf,
  };
}

describe('jinn-layer CLI', () => {
  it('corpus search prints titles, refs, and provenance fields', async () => {
    const { writer, out } = capture();
    const layer = fakeLayer({ hits: [fakeHit()] });
    const code = await runJinnLayerCli(['corpus', 'search', 'prediction'], { layer, writer });
    expect(code).toBe(0);
    expect(layer.corpus.search).toHaveBeenCalledWith('prediction', { limit: 20 });
    const text = out();
    expect(text).toContain('prediction.v1 / solution');
    expect(text).toContain('bafyPred');
    expect(text).toContain('self-signed');
    expect(text).toContain('agentId=7');
    expect(text).toContain('bafyTask');
    // generatedAt is unix seconds here — rendered as an ISO date.
    expect(text).toContain('2025-04-30T02:00:00.000Z');
    // publishedAt is backing-dependent (block number on the HTTP indexer) —
    // rendered raw, never as a date.
    expect(text).toContain('published      1745978400');
  });

  it('renders millisecond generatedAt values as sane ISO dates', async () => {
    const { writer, out } = capture();
    const layer = fakeLayer({ hits: [fakeHit({ generatedAt: 1745978400000 })] });
    await runJinnLayerCli(['corpus', 'search', 'prediction'], { layer, writer });
    expect(out()).toContain('2025-04-30T02:00:00.000Z');
    expect(out()).not.toContain('+05');
  });

  it('corpus get prints the record and artifact summary', async () => {
    const { writer, out } = capture();
    const content = Buffer.from('artifact body', 'utf-8');
    const record: CorpusRecord = {
      ref: 'bafyPred',
      envelope: { solverType: 'prediction.v1', role: 'solution' } as CorpusRecord['envelope'],
      provenance: {
        operator: { agentId: '7', safeAddress: '0x' + 'a'.repeat(40) },
        evidenceTier: 'self-signed',
        publishedAt: 1745978400,
      },
      artifacts: [{
        sha256: 'c'.repeat(64),
        artifactType: 'output.prediction.v1',
        content,
        source: 'origin',
        sizeBytes: content.length,
      }],
    };
    const layer = fakeLayer({ record });
    const code = await runJinnLayerCli(['corpus', 'get', 'bafyPred'], { layer, writer });
    expect(code).toBe(0);
    expect(layer.corpus.get).toHaveBeenCalledWith('bafyPred');
    const text = out();
    expect(text).toContain('bafyPred');
    expect(text).toContain('output.prediction.v1');
    expect(text).toContain('artifact body');
  });

  it('unknown verbs exit non-zero with usage', async () => {
    const { writer, out } = capture();
    const layer = fakeLayer({});
    const code = await runJinnLayerCli(['bogus'], { layer, writer });
    expect(code).not.toBe(0);
    expect(out()).toContain('Usage');
  });
});
