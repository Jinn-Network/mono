import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RETRIEVAL_VISIBLE_TAG } from '@jinn-network/plugin';
import type { HarnessLayer, CorpusSearchHit, CorpusRecord } from '../src/consume.js';
import {
  createBoundedIpfsJsonFetcher,
  runJinnLayerCli,
  type DistillRunCliDeps,
  type DistillCliDeps,
  type DistillProvider,
  type DistillPorts,
} from '../src/cli.js';
import type { CapturedTask } from '../src/capture.js';
import { createMemoryLedger, type LedgerEntry } from '../src/ledger.js';
import {
  TRACE_ENVELOPE_ARTIFACT_TYPE,
  type HarnessPublishDeps,
  type ManifestBatchPublishDeps,
} from '../src/publish.js';
import type { AttemptRef, BridgeEvidence } from '../src/bridge.js';
import type { DistillCluster, DistillLLMOutput, MetaDistillLLMOutput } from '../src/distill.js';
import type { MetaCluster } from '../src/cluster.js';
import { parseSkillMarkdown } from '../src/skill-package.js';
import {
  readDistillDefaults,
  readDistillMode,
  writeDistillDefaults,
  writeDistillMode,
} from '../src/distill-mode.js';
import { DISTILLER_CATALOG } from '../src/distill-llm.js';
import { assertAttemptedClusterIds, attemptRecordFileName } from '../src/eval-prep.js';

/** A distinct temp mode file for a test (env-injected via JINN_LAYER_DISTILL_MODE_PATH). */
function tmpModeFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'jinn-distill-mode-')), 'distill.json');
}

/** A well-formed distiller output the own-captures rung-1 fixtures reuse. */
const VALID_DISTILL: DistillLLMOutput = {
  name: 'orm-fanout-dedup',
  description: 'Use when a join fans out duplicate rows. Not for: single-table reads.',
  body: [
    '## When to use', 'A queryset returns duplicate rows after a join or prefetch.',
    '## Strategy', 'Collapse the duplicates at the ORM layer, near the join that produced them.',
    '## Steps', '1. Identify the fan-out join. 2. Apply .distinct() after it.',
    '## Pitfalls', 'An order_by on a joined column can re-expand the collapsed rows.',
    '## Verify', 'Assert the row count equals the expected unique count.',
  ].join('\n\n'),
};

/** An evaluator-verified own capture that runs on a CHEAP runtime model. */
function ownCapture(over: Partial<CapturedTask> = {}): CapturedTask {
  return {
    session: { sessionId: 'own-orm-dedup', capturedAt: '2026-07-09T08:00:00.000Z' },
    task: { summary: 'fix duplicate rows after a join in the report query', distributionTags: ['coding'] },
    // Runtime model is the CHEAP knob — the distiller model is separate.
    environment: { harness: { name: 'claude-code', version: '1.0.0' }, model: 'claude-haiku-4-5', tools: [] },
    steps: [
      {
        spanId: 'patch',
        parentSpanId: null,
        name: 'tool:apply_patch',
        startTimeUnixNano: '1720000000000000000',
        endTimeUnixNano: '1720000000000000000',
        attributes: { patch: 'diff --git a/report.py b/report.py\n+ return qs.distinct()  # dedup after join\n' },
        redactedKeys: [],
      },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'evaluator-verified' },
    cost: { durationMs: 1000 },
    provenance: 'contributed',
    ...over,
  };
}

/** Write CapturedTask files into a fresh captures dir; returns the dir. */
function capturesDirWith(...tasks: CapturedTask[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-captures-'));
  for (const t of tasks) writeFileSync(join(dir, `${t.session.sessionId}.json`), JSON.stringify(t));
  return dir;
}

function stubDistillDeps(over: Partial<DistillCliDeps> = {}): DistillCliDeps {
  return { distill: async () => VALID_DISTILL, ...over };
}

async function withEnv(updates: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeHit(overrides: Partial<CorpusSearchHit> = {}): CorpusSearchHit {
  return {
    title: 'prediction.v1 / solution',
    ref: 'bafyPred',
    solverType: 'prediction.v1',
    role: 'solution',
    artifactTypes: ['output.prediction.v1'],
    kind: 'trace',
    evidenceTier: 'self-signed',
    generatedAt: 1745978400,
    publishedAt: 1745978400,
    operator: { agentId: '7', safeAddress: '0x' + 'a'.repeat(40) },
    task: { cid: 'bafyTask', requestId: '0x' + 'b'.repeat(64) },
    ...overrides,
  };
}

describe('bounded IPFS JSON fetcher', () => {
  const VALID_CID = 'QmYwAPJzv5CZsnAzt8auVZRn4xPjgVAc6zP8s8vF5hY8pN';

  function rawBase16Cid(bytes: string, uppercase = false): string {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const body = `01551220${digest}`;
    return uppercase ? `F${body.toUpperCase()}` : `f${body}`;
  }

  function rawBase32Cid(bytes: string): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    const digest = createHash('sha256').update(bytes).digest();
    const cidBytes = new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]);
    let accumulator = 0;
    let bits = 0;
    let encoded = '';
    for (const byte of cidBytes) {
      accumulator = (accumulator << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        encoded += alphabet[(accumulator >>> bits) & 31];
      }
    }
    if (bits > 0) encoded += alphabet[(accumulator << (5 - bits)) & 31];
    return `b${encoded}`;
  }

  it.each([
    ['deployed lowercase base16', (payload: string) => rawBase16Cid(payload)],
    ['uppercase base16 multibase', (payload: string) => rawBase16Cid(payload, true)],
    ['base32', (payload: string) => rawBase32Cid(payload)],
  ])('accepts and content-binds a raw CIDv1 in %s form', async (_label, cidFor) => {
    const payload = '{"authenticated":true}';
    const cid = cidFor(payload);
    const fetchIpfs = createBoundedIpfsJsonFetcher({
      gateway: 'https://gateway.example',
      fetchImpl: vi.fn(async () => new Response(payload)),
    });

    await expect(fetchIpfs(cid)).resolves.toEqual({ authenticated: true });
  });

  it('rejects a noncanonical base32 alias with an extra zero symbol', async () => {
    const canonical = rawBase32Cid('{"authenticated":true}');
    const fetchImpl = vi.fn();
    const fetchIpfs = createBoundedIpfsJsonFetcher({
      gateway: 'https://gateway.example',
      fetchImpl,
    });

    await expect(fetchIpfs(`${canonical}a`)).rejects.toThrow(/valid IPFS CID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects requested raw CID A when the gateway returns valid JSON object B', async () => {
    const requestedBytes = '{"task":"A"}';
    const returnedBytes = '{"task":"B"}';
    const cid = rawBase16Cid(requestedBytes);
    const fetchIpfs = createBoundedIpfsJsonFetcher({
      gateway: 'https://gateway.example',
      fetchImpl: vi.fn(async () => new Response(returnedBytes)),
    });

    await expect(fetchIpfs(cid)).rejects.toThrow(/content digest.*requested CID/i);
  });

  it('passes a caller-supplied cap through to the streamed body reader', async () => {
    const payload = JSON.stringify({ authenticated: true });
    const fetchIpfs = createBoundedIpfsJsonFetcher({
      gateway: 'https://gateway.example',
      fetchImpl: vi.fn(async () => new Response(payload)),
    });

    await expect(fetchIpfs(VALID_CID, Buffer.byteLength(payload)))
      .resolves.toEqual({ authenticated: true });
    await expect(fetchIpfs(VALID_CID, Buffer.byteLength(payload) - 1))
      .rejects.toThrow(/fetch ceiling/);
  });

  it('cancels a streamed response as soon as it crosses the cap', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"proof":'));
        controller.enqueue(new TextEncoder().encode('"too large"}'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(stream);
    });
    const fetchIpfs = createBoundedIpfsJsonFetcher({
      gateway: 'https://gateway.example/',
      fetchImpl,
      timeoutMs: 5_000,
    });

    await expect(fetchIpfs(VALID_CID, 10)).rejects.toThrow(/fetch ceiling/);
    expect(cancelled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://gateway.example/ipfs/${VALID_CID}`,
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects gateway redirects instead of following them to another network destination', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/private' },
      });
    });
    const fetchIpfs = createBoundedIpfsJsonFetcher({
      gateway: 'https://gateway.example',
      fetchImpl,
    });

    await expect(fetchIpfs(VALID_CID)).rejects.toThrow(/HTTP 302|redirect/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a response whose final URL differs from the configured gateway request', async () => {
    const redirected = new Response('{"authenticated":true}');
    Object.defineProperty(redirected, 'url', {
      value: 'http://169.254.169.254/latest/meta-data',
    });
    const fetchIpfs = createBoundedIpfsJsonFetcher({
      gateway: 'https://gateway.example',
      fetchImpl: vi.fn(async () => redirected),
    });

    await expect(fetchIpfs(VALID_CID)).rejects.toThrow(/redirect/i);
  });

  it('keeps the timeout active while a response body is stalled after headers', async () => {
    const fetchIpfs = createBoundedIpfsJsonFetcher({
      gateway: 'https://gateway.example',
      timeoutMs: 20,
      fetchImpl: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => {
              controller.error(signal.reason);
            }, { once: true });
          },
        });
        return new Response(body);
      }),
    });

    await expect(fetchIpfs(VALID_CID)).rejects.toThrow();
  });

  it.each([
    '../../api/v0/id',
    '%2e%2e/%2e%2e/api/v0/id',
    'bafy-not-a-real-cid',
    `f01551220${'a'.repeat(63)}`,
    `f01551220${'a'.repeat(65)}`,
    `f01551320${'a'.repeat(64)}`,
    `f01551220${'A'.repeat(64)}`,
    `F01551220${'a'.repeat(64)}`,
    'Qm' + 'a'.repeat(10_000),
  ])('rejects a non-CID path segment before contacting the gateway: %s', async (cid) => {
    const fetchImpl = vi.fn();
    const fetchIpfs = createBoundedIpfsJsonFetcher({
      gateway: 'https://gateway.example',
      fetchImpl,
    });

    await expect(fetchIpfs(cid)).rejects.toThrow(/valid IPFS CID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function retrievalVisibleTraceRecord(): CorpusRecord {
  const trace = {
    schemaVersion: 'jinn.trace-envelope.v0',
    session: { sessionId: 'seed:doctor-probe', capturedAt: '2026-07-04T00:00:00.000Z' },
    task: {
      summary: 'Fix the dashboard version-status flake',
      distributionTags: ['mono', RETRIEVAL_VISIBLE_TAG],
    },
    environment: {
      harness: { name: 'hermes-agent', version: '0.1.0' },
      model: 'test-model',
      tools: ['bash'],
    },
    steps: [{
      spanId: 's1',
      parentSpanId: null,
      name: 'run tests',
      startTimeUnixNano: '1000000000',
      endTimeUnixNano: '2000000000',
      attributes: { 'tool.args': 'yarn test', 'tool.exitCode': 0 },
      redactedKeys: [],
    }],
    outcome: {
      status: 'completed',
      verifiabilityTier: 'tests-passed',
      summary: 'The flake is fixed.',
    },
    cost: { durationMs: 1000 },
    consent: { contributionConsent: true, scrubCompleted: true },
    provenance: 'imported',
  };
  const content = Buffer.from(JSON.stringify(trace), 'utf-8');
  return {
    ref: 'bafyProbe',
    envelope: { participant: { safeAddress: '0xparticipant' } } as CorpusRecord['envelope'],
    provenance: {
      operator: { agentId: 'agent-77', safeAddress: '0xoperator' },
      evidenceTier: 'self-signed',
      publishedAt: 1_751_587_200,
    },
    artifacts: [{
      sha256: createHash('sha256').update(content).digest('hex'),
      artifactType: TRACE_ENVELOPE_ARTIFACT_TYPE,
      content,
      source: 'ipfs',
      sizeBytes: content.length,
    }],
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

  it('corpus probe --json emits the two doctor checks (corpus-reachable + corpus-content)', async () => {
    const { writer, out } = capture();
    const layer = fakeLayer({
      hits: ['one', 'two', 'three'].map((ref) =>
        fakeHit({ ref, tags: ['mono', RETRIEVAL_VISIBLE_TAG] })),
      record: retrievalVisibleTraceRecord(),
    });
    const code = await runJinnLayerCli(['corpus', 'probe', 'owner/repo', '--json'], { layer, writer });
    expect(code).toBe(0);
    const checks = JSON.parse(out());
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.map((c: { name: string }) => c.name)).toEqual(['corpus-reachable', 'corpus-content']);
    expect(checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it('corpus probe --json on a throwing layer does not throw and reports corpus-reachable failure', async () => {
    const { writer, out } = capture();
    const layer = fakeLayer({});
    (layer.corpus.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('discovery unreachable'));
    const code = await runJinnLayerCli(['corpus', 'probe', 'owner/repo', '--json'], { layer, writer });
    expect(code).toBe(0);
    const checks = JSON.parse(out());
    const reachable = checks.find((c: { name: string }) => c.name === 'corpus-reachable');
    expect(reachable.ok).toBe(false);
    expect(reachable.remedy).toBeDefined();
  });
});

describe('jinn-layer distill — persisted distiller default (resolution order, #1496)', () => {
  /** A distill dep that records the (provider, model) the factory was built with. */
  function recordingFactory(calls: Array<{ provider: string; model: string }>): DistillCliDeps {
    return {
      distillerFactory: (provider, model) => {
        calls.push({ provider, model });
        return { distill: async () => VALID_DISTILL, metaDistill: async () => { throw new Error('unused'); } };
      },
    };
  }

  it('uses the persisted distiller + model when no flag or env is set', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    writeDistillDefaults({ distiller: 'codex', distillerModel: 'gpt-5.5-custom' }, modePath);
    const calls: Array<{ provider: string; model: string }> = [];
    await withEnv(
      { JINN_LAYER_DISTILL_MODE_PATH: modePath, JINN_DISTILL_PROVIDER: undefined, JINN_DISTILL_MODEL: undefined },
      async () => {
        const { writer } = capture();
        const code = await runJinnLayerCli(
          ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'o-')), '--install', 'all'],
          { writer, distillDeps: recordingFactory(calls) },
        );
        expect(code).toBe(0);
        expect(calls).toEqual([{ provider: 'codex', model: 'gpt-5.5-custom' }]);
      },
    );
  });

  it('a per-run --distiller flag overrides the persisted default', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    writeDistillDefaults({ distiller: 'codex', distillerModel: 'gpt-5.5-custom' }, modePath);
    const calls: Array<{ provider: string; model: string }> = [];
    await withEnv(
      { JINN_LAYER_DISTILL_MODE_PATH: modePath, JINN_DISTILL_PROVIDER: undefined, JINN_DISTILL_MODEL: undefined },
      async () => {
        const { writer } = capture();
        await runJinnLayerCli(
          ['distill', '--distiller', 'claude', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'o-')), '--install', 'all'],
          { writer, distillDeps: recordingFactory(calls) },
        );
        expect(calls).toEqual([{ provider: 'claude', model: 'claude-opus-4-8' }]);
      },
    );
  });

  it('env overrides the persisted default but loses to a flag', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    writeDistillDefaults({ distiller: 'codex', distillerModel: 'gpt-persisted' }, modePath);
    const calls: Array<{ provider: string; model: string }> = [];
    await withEnv(
      { JINN_LAYER_DISTILL_MODE_PATH: modePath, JINN_DISTILL_PROVIDER: 'claude', JINN_DISTILL_MODEL: 'model-from-env' },
      async () => {
        const { writer } = capture();
        await runJinnLayerCli(
          ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'o-')), '--install', 'all'],
          { writer, distillDeps: recordingFactory(calls) },
        );
        expect(calls).toEqual([{ provider: 'claude', model: 'model-from-env' }]);
      },
    );
  });

  it('a corrupt persisted distiller falls back to the provider default (fail-safe)', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    writeFileSync(modePath, JSON.stringify({ where: 'local', distiller: 'bogus', distillerModel: 5 }));
    const calls: Array<{ provider: string; model: string }> = [];
    await withEnv(
      { JINN_LAYER_DISTILL_MODE_PATH: modePath, JINN_DISTILL_PROVIDER: undefined, JINN_DISTILL_MODEL: undefined },
      async () => {
        const { writer } = capture();
        await runJinnLayerCli(
          ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'o-')), '--install', 'all'],
          { writer, distillDeps: recordingFactory(calls) },
        );
        expect(calls).toEqual([{ provider: 'claude', model: 'claude-opus-4-8' }]);
      },
    );
  });
});

describe('jinn-layer capture preview', () => {
  const fixturePath = fileURLToPath(
    new URL('./fixtures/seeded-secrets-task.json', import.meta.url),
  );

  it('renders a compact readable summary by default — no raw envelope JSON, no pre-scrub secrets', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['capture', 'preview', fixturePath], { writer });
    expect(code).toBe(0);
    const text = out();

    // Header + tools + per-step lines: the publishable surface, as fields.
    expect(text).toContain('scrub preview — what would leave this machine');
    expect(text).toContain('Wire the todo-app deploy script to the new staging bucket');
    expect(text).toContain('steps');
    expect(text).toContain('tools');
    expect(text).toContain('read_file');
    // Grouped redaction counts (the safety core): a count summary line plus the
    // per-stage grouping. The seeded secrets fire the key-policy stage.
    expect(text).toMatch(/redactions\s+\d+ across \d+ field\(s\)/);
    expect(text).toContain('key-policy');

    // The default view must NOT dump the envelope JSON wall …
    expect(text).not.toContain('envelope as it would publish');
    // … and must NOT carry ANY of the raw pre-scrub `before` values seeded into
    // the fixture (before values live under --full only). These are exactly the
    // value-redacted secrets — the AWS key, GitHub token, generic API key, email,
    // and home-dir path. (The two dropped-key secrets — env.OPENAI_API_KEY and
    // the authorization header — have no `before` value: the whole attribute is
    // dropped, so there is no raw literal to pin here.)
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).not.toContain('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(text).not.toContain('sk-proj-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0De9Cb8Aa7');
    expect(text).not.toContain('jane.doe@example-corp.com');
    expect(text).not.toContain('/Users/janedoe');
  });

  it('--full appends the before→after audit and the full envelope JSON', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['capture', 'preview', fixturePath, '--full'], { writer });
    expect(code).toBe(0);
    const text = out();

    // The compact summary is still present (full is additive).
    expect(text).toContain('scrub preview — what would leave this machine');

    // The local-only before→after audit reappears, with the seeded secret + its scrubbed form.
    expect(text).toContain('never leaves this machine');
    expect(text).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).toContain('[EMAIL]');

    // The envelope-as-it-would-publish JSON wall reappears …
    const marker = 'envelope as it would publish';
    expect(text).toContain(marker);
    // … and that section carries none of the seeded secrets.
    const envelopeSection = text.slice(text.indexOf(marker));
    expect(envelopeSection).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(envelopeSection).not.toContain('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789');
    expect(envelopeSection).not.toContain('jane.doe@example-corp.com');
  });

  it('--json emits the report with before values stripped (persistence-safe)', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['capture', 'preview', fixturePath, '--json'], { writer });
    expect(code).toBe(0);
    const report = JSON.parse(out());
    expect(report.envelope.schemaVersion).toBe('jinn.episode.v1');
    expect(report.redactions.length).toBeGreaterThan(0);
    for (const r of report.redactions) {
      expect(r).not.toHaveProperty('before');
    }
    // No seeded secret anywhere in the serialisable output.
    expect(out()).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out()).not.toContain('jane.doe@example-corp.com');
  });

  it('capture preview without a task file exits 2 with usage', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['capture', 'preview'], { writer });
    expect(code).toBe(2);
    expect(out()).toContain('Usage');
  });
});

function skillRecord(payloadOverrides: Record<string, unknown> = {}): CorpusRecord {
  const companion = Buffer.from('# examples\n', 'utf-8');
  const payload = {
    schemaVersion: 'jinn.skill.v1',
    skill: { name: 'write-tests', skillMd: '# write-tests\n\nAlways write a failing test first.' },
    files: [
      {
        path: 'reference/EXAMPLES.md',
        contentBase64: companion.toString('base64'),
        sha256: createHash('sha256').update(companion).digest('hex'),
      },
    ],
    ...payloadOverrides,
    provenance: {
      kind: 'imported',
      sourceEnvelopeCids: [],
      operator: { safeAddress: '0x' + 'a'.repeat(40) },
      seed: { skill: 'acme/skills/write-tests', source: 'https://github.com/acme/skills', licence: 'MIT' },
    },
  };
  const content = Buffer.from(JSON.stringify(payload), 'utf-8');
  return {
    ref: 'bafySkill',
    envelope: {
      solverType: 'capture.v0',
      role: 'capture',
      participant: { safeAddress: '0x' + 'a'.repeat(40), agentEoa: '0x' + 'b'.repeat(40) },
      artifacts: [],
    } as unknown as CorpusRecord['envelope'],
    provenance: {
      operator: { agentId: '7', safeAddress: '0x' + 'a'.repeat(40) },
      evidenceTier: 'self-signed',
      publishedAt: 1745978400,
    },
    artifacts: [
      {
        sha256: 'c'.repeat(64),
        artifactType: 'jinn.skill.v1',
        content,
        source: 'origin',
        sizeBytes: content.length,
      },
    ],
  };
}

describe('jinn-layer skills install', () => {
  it('installs SKILL.md and companion files from a jinn.skill.v1 record', async () => {
    const { writer, out } = capture();
    const dir = mkdtempSync(join(tmpdir(), 'jinn-skills-'));
    const layer = fakeLayer({ record: skillRecord() });
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', dir],
      { layer, writer },
    );
    expect(code).toBe(0);
    expect(layer.corpus.get).toHaveBeenCalledWith('bafySkill');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('failing test first');
    expect(readFileSync(join(dir, 'reference', 'EXAMPLES.md'), 'utf-8')).toBe('# examples\n');
    const text = out();
    expect(text).toContain(dir);
    expect(text).toContain('imported');
    expect(text).toContain('https://github.com/acme/skills');
  });

  it('exits 1 with a clear message when the record carries no skill', async () => {
    const { writer, out } = capture();
    const record = skillRecord();
    record.artifacts = []; // neither shape present
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', mkdtempSync(join(tmpdir(), 'jinn-skills-'))],
      { layer: fakeLayer({ record }), writer },
    );
    expect(code).toBe(1);
    expect(out()).toContain('no skill');
  });

  it('requires a <ref> argument', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['skills', 'install'], { layer: fakeLayer({}), writer });
    expect(code).toBe(2);
    expect(out()).toContain('skills install requires a <ref>');
  });

  it('defaults the install directory to a safe slug of the skill name', async () => {
    const { writer, out } = capture();
    const base = mkdtempSync(join(tmpdir(), 'jinn-skills-'));
    const cwd = join(base, 'a', 'b');
    mkdirSync(cwd, { recursive: true });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      // Publisher-controlled name shaped as a traversal — the default dir
      // must be a slug inside cwd, never the literal path.
      const record = skillRecord({
        skill: { name: '../../.config/pwn', skillMd: '# pwn\n' },
        files: [],
      });
      const code = await runJinnLayerCli(
        ['skills', 'install', 'bafySkill'],
        { layer: fakeLayer({ record }), writer },
      );
      expect(code).toBe(0);
      expect(readFileSync(join(cwd, 'config-pwn', 'SKILL.md'), 'utf-8')).toBe('# pwn\n');
      expect(existsSync(join(base, '.config'))).toBe(false);
      expect(out()).toContain(join(cwd, 'config-pwn'));
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('verifies all companion digests before writing anything', async () => {
    const { writer, out } = capture();
    const dir = join(mkdtempSync(join(tmpdir(), 'jinn-skills-')), 'skill');
    const good = Buffer.from('good\n', 'utf-8');
    const record = skillRecord({
      files: [
        {
          path: 'a.md',
          contentBase64: good.toString('base64'),
          sha256: createHash('sha256').update(good).digest('hex'),
        },
        {
          path: 'b.md',
          contentBase64: Buffer.from('tampered\n', 'utf-8').toString('base64'),
          sha256: 'd'.repeat(64),
        },
      ],
    });
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', dir],
      { layer: fakeLayer({ record }), writer },
    );
    expect(code).toBe(1);
    expect(out()).toContain('sha256 mismatch');
    // All-or-nothing: the aborted install leaves no partial tree on disk.
    expect(existsSync(dir)).toBe(false);
  });

  it('reports a corrupt jinn.skill.v1 artifact cleanly instead of throwing', async () => {
    const { writer, out } = capture();
    const record = skillRecord();
    record.artifacts[0]!.content = Buffer.from('not json', 'utf-8');
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', mkdtempSync(join(tmpdir(), 'jinn-skills-'))],
      { layer: fakeLayer({ record }), writer },
    );
    expect(code).toBe(1);
    expect(out()).toContain('error: record bafySkill carries a malformed jinn.skill.v1 artifact');
  });

  it('reports a schema-invalid jinn.skill.v1 artifact cleanly instead of throwing', async () => {
    const { writer, out } = capture();
    const record = skillRecord({
      files: [
        {
          path: '../escape.md',
          contentBase64: Buffer.from('x', 'utf-8').toString('base64'),
          sha256: createHash('sha256').update('x').digest('hex'),
        },
      ],
    });
    const code = await runJinnLayerCli(
      ['skills', 'install', 'bafySkill', '--out', mkdtempSync(join(tmpdir(), 'jinn-skills-'))],
      { layer: fakeLayer({ record }), writer },
    );
    expect(code).toBe(1);
    expect(out()).toContain('malformed jinn.skill.v1');
  });
});

describe('jinn-layer distill run', () => {
  type RecordedProvider = 'claude' | 'codex';

  function dref(instanceId: string, polarity: 'pass' | 'fail'): AttemptRef {
    return {
      requestId: `0x${instanceId}`,
      chainId: 84532,
      instanceId,
      model: '',
      manifestCid: '',
      polarity,
      verdictManifestCid: `bafyVerdict-${instanceId}`,
    };
  }

  function verifiedEvidence(
    attempt: AttemptRef,
    over: Partial<BridgeEvidence> = {},
  ): BridgeEvidence {
    const match = /^(.+)__(.+)-\d+$/.exec(attempt.instanceId);
    return {
      taskSummary: `fix the bug in ${attempt.instanceId}`,
      patch: `diff --git a/x.py b/x.py\n+ return qs.distinct()  # for ${attempt.instanceId}\n`,
      repo: match ? `${match[1]}/${match[2]}` : 'unknown/repo',
      baseCommit: 'a'.repeat(40),
      taskCreatedAt: 1_752_000_000_000,
      instanceId: attempt.instanceId,
      verifier: {
        failToPass: ['tests/test_regression.py::test_fix'],
        passToPass: ['tests/test_existing.py::test_still_passes'],
        evalSemanticsVersion: '4',
      },
      ...over,
    };
  }

  function fakePublishDeps(): HarnessPublishDeps {
    let n = 0;
    return {
      participant: { safeAddress: `0x${'1'.repeat(40)}`, agentEoa: `0x${'2'.repeat(40)}` },
      signer: { address: `0x${'2'.repeat(40)}`, privateKey: `0x${'a'.repeat(64)}` },
      clientGitSha: 'sha',
      defaultArtifactEndpoint: 'http://127.0.0.1:7331',
      ledger: createMemoryLedger(),
      publishArtifact: async () => ({ cid: `bafyArt${++n}`, sha256: 'a'.repeat(64) }),
      publishEnvelope: async () => ({ cid: `bafyEnv${++n}`, sha256: 'b'.repeat(64) }),
      anchorEnvelope: async () => ({ txHash: `0x${'e'.repeat(64)}`, blockNumber: 1 }),
    };
  }

  function fakeManifestPublishDeps() {
    const base = fakePublishDeps();
    const anchorEnvelope = vi.fn(base.anchorEnvelope);
    const anchorManifest = vi.fn(async () => ({
      txHash: `0x${'d'.repeat(64)}` as const,
      blockNumber: 7,
      gasUsed: 123456n,
      feeWei: 789012n,
    }));
    const deps: ManifestBatchPublishDeps = {
      ...base,
      anchorEnvelope,
      publishManifestBody: async () => ({
        cid: 'bafyManifest',
        sha256: 'c'.repeat(64),
      }),
      anchorManifest,
      recordManifestAnchor: vi.fn(),
    };
    return { deps, anchorEnvelope, anchorManifest };
  }

  function stubDeps(over: Partial<DistillRunCliDeps> = {}): DistillRunCliDeps {
    return {
      verdictSource: {
        list: async () => [
          dref('flask__flask-1', 'pass'),
          dref('pytest__pytest-2', 'fail'),
          dref('django__django-99999', 'pass'), // held-out → excluded
        ],
      },
      fetchEvidence: async (r: AttemptRef): Promise<BridgeEvidence> => verifiedEvidence(r),
      distill: async (c: DistillCluster): Promise<DistillLLMOutput> => ({
        name: `orm-${c.tier}-${c.instanceIds[0]!.replace(/[^a-z0-9]+/g, '-')}`,
        description: 'Use when a queryset returns duplicate rows after a join. Not for: single-table queries.',
        body: [
          '## When to use',
          'A queryset returns duplicate rows after a join or prefetch.',
          '## Strategy',
          'Collapse the duplicates at the ORM layer, near the join that produced them.',
          '## Steps',
          '1. Identify the fan-out join. 2. Apply .distinct() after it.',
          '## Pitfalls',
          'An order_by on a joined column can re-expand the collapsed rows.',
          '## Verify',
          'Assert the row count equals the expected unique count.',
        ].join('\n\n'),
      }),
      publishDeps: fakePublishDeps(),
      slateInstanceIds: new Set(['django__django-99999']),
      ...over,
    };
  }

  const META_OUT = {
    name: 'cross-instance-orm-dedup',
    description: 'Use when a class of ORM queries fans out rows. Not for: single-table reads.',
    body: [
      '## When to use', 'A class of queries returns duplicate rows after a join.',
      '## Strategy', 'Collapse duplicates at the ORM layer across the shared pattern.',
      '## Steps', '1. Spot the fan-out. 2. Dedup at the join.',
      '## Pitfalls', 'An order_by on a joined column can re-expand the rows.',
      '## Verify', 'Assert the row count equals the expected unique count.',
    ].join('\n\n'),
    supports: ['s1', 's2'],
  };

  function stubMetaDeps(): Partial<DistillRunCliDeps> {
    return {
      verdictSource: {
        list: async () => [
          dref('flask__flask-1', 'pass'),
          dref('requests__requests-3', 'pass'),
        ],
      },
      metaDistill: async (_c: MetaCluster): Promise<MetaDistillLLMOutput> => META_OUT,
    };
  }

  function recordingDistillerFactory(calls: Array<{ provider: RecordedProvider; model: string }>) {
    return (provider: RecordedProvider, model: string) => {
      calls.push({ provider, model });
      return {
        distill: async (c: DistillCluster): Promise<DistillLLMOutput> => ({
          name: `factory-${provider}-${c.tier}-${c.instanceIds[0]!.replace(/[^a-z0-9]+/g, '-')}`,
          description: 'Use when a queryset returns duplicate rows after a join. Not for: single-table queries.',
          body: [
            '## When to use',
            'A queryset returns duplicate rows after a join or prefetch.',
            '## Strategy',
            'Collapse the duplicates at the ORM layer, near the join that produced them.',
            '## Steps',
            '1. Identify the fan-out join. 2. Apply .distinct() after it.',
            '## Pitfalls',
            'An order_by on a joined column can re-expand the collapsed rows.',
            '## Verify',
            'Assert the row count equals the expected unique count.',
          ].join('\n\n'),
        }),
        metaDistill: async (_c: MetaCluster): Promise<MetaDistillLLMOutput> => META_OUT,
      };
    };
  }

  function validEvalOutput(name: string, extra = ''): DistillLLMOutput {
    return {
      name,
      description: 'Use when a grouped solver attempt set exposes a repeatable repair signal. Not for: unrelated tasks.',
      body: [
        '## When to use',
        `A grouped solver attempt set exposes a repeatable repair signal.${extra}`,
        '## Strategy',
        'Compare the retained evidence group and distill the shared decision point.',
        '## Steps',
        '1. Read the grouped attempts. 2. Extract the stable rule.',
        '## Pitfalls',
        'Do not quote instance identifiers or patch-only trivia.',
        '## Verify',
        'Check the skill against every retained attempt in the cluster.',
      ].join('\n\n'),
    };
  }

  const TWO_PATTERN_REFS = [
    dref('alpha__repo-1', 'pass'),
    dref('beta__repo-2', 'pass'),
  ];

  it('runs the pipeline under stubs and writes SKILL.md packages', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--out', outDir], {
      writer,
      distillRunDeps: stubDeps(),
    });
    expect(code).toBe(0);

    const text = out();
    expect(text).toContain('distilled: published 2');
    expect(text).toContain('PUBLISHED strategic-pattern');
    expect(text).toContain('PUBLISHED failure-lesson');
    expect(text).toContain(outDir);

    // One directory per published skill, each with a conformant SKILL.md.
    const dirs = readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(dirs).toHaveLength(2);
    for (const d of dirs) {
      const md = readFileSync(join(outDir, d.name, 'SKILL.md'), 'utf-8');
      const pkg = parseSkillMarkdown(md);
      expect(pkg.name).toBe(d.name);
      expect(['strategic-pattern', 'failure-lesson']).toContain(pkg.jinn.skillKind);
      expect(pkg.jinn.distribution).toBe('coding');
      // The held-out instance never surfaces in a distilled body.
      expect(md).not.toContain('django__django-99999');
    }
  });

  it('--anchor-mode manifest batches bridge records into one anchor and prints measured gas', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const manifest = fakeManifestPublishDeps();
    const code = await runJinnLayerCli(
      ['distill', 'run', '--anchor-mode', 'manifest', '--out', outDir],
      {
        writer,
        distillRunDeps: stubDeps({ publishDeps: manifest.deps }),
      },
    );

    expect(code).toBe(0);
    expect(manifest.anchorManifest).toHaveBeenCalledTimes(1);
    expect(manifest.anchorEnvelope).not.toHaveBeenCalled();
    expect(out()).toContain(
      'manifest anchored bafyManifest — 2 members, gasUsed=123456, feeWei=789012',
    );
  });

  it('--json emits the pipeline result with the out dir', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--out', outDir, '--json'], {
      writer,
      distillRunDeps: stubDeps(),
    });
    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.outDir).toBe(outDir);
    expect(result.distilled.published).toHaveLength(2);
    expect(result.clusterCount).toBe(2);
    // The held-out instance is excluded at the bridge.
    expect(result.bridge.excludedHeldOut.length).toBeGreaterThan(0);
  });

  it('AC4: --meta runs stage-2 and shows a cross-instance skill with evidenceTokens > skillTokens', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--meta', '--out', outDir, '--json'], {
      writer,
      distillRunDeps: stubDeps(stubMetaDeps()),
    });
    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.metaDistilled.published).toHaveLength(1);
    const meta = result.metaDistilled.published[0];
    expect(meta.skillKind).toBe('cross-instance');
    expect(meta.pkg.jinn.evidenceTokens).toBeGreaterThan(meta.pkg.jinn.skillTokens);
  });

  it('--meta prints the meta section in human output', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    await runJinnLayerCli(['distill', 'run', '--meta', '--out', outDir], {
      writer,
      distillRunDeps: stubDeps(stubMetaDeps()),
    });
    const text = out();
    expect(text).toContain('meta-distilled: published 1');
    expect(text).toMatch(/META cross-instance .*evidenceTokens=\d+ skillTokens=\d+/);
  });

  it('without --meta, no meta section is printed (stage-1 unchanged)', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    await runJinnLayerCli(['distill', 'run', '--out', outDir], { writer, distillRunDeps: stubDeps() });
    expect(out()).not.toContain('meta-distilled');
  });

  it('--distiller codex selects Codex ports with the Codex default model', async () => {
    await withEnv({ JINN_DISTILL_PROVIDER: undefined, JINN_DISTILL_MODEL: undefined }, async () => {
      const { writer } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
      const calls: Array<{ provider: RecordedProvider; model: string }> = [];
      const code = await runJinnLayerCli(['distill', 'run', '--distiller', 'codex', '--out', outDir], {
        writer,
        distillRunDeps: stubDeps({
          distill: undefined,
          metaDistill: undefined,
          distillerFactory: recordingDistillerFactory(calls),
        }),
      });

      expect(code).toBe(0);
      expect(calls).toEqual([{ provider: 'codex', model: 'gpt-5.5' }]);
    });
  });

  it('JINN_DISTILL_PROVIDER=codex selects Codex when no --distiller flag is passed', async () => {
    await withEnv({ JINN_DISTILL_PROVIDER: 'codex', JINN_DISTILL_MODEL: undefined }, async () => {
      const { writer } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
      const calls: Array<{ provider: RecordedProvider; model: string }> = [];
      const code = await runJinnLayerCli(['distill', 'run', '--out', outDir], {
        writer,
        distillRunDeps: stubDeps({
          distill: undefined,
          metaDistill: undefined,
          distillerFactory: recordingDistillerFactory(calls),
        }),
      });

      expect(code).toBe(0);
      expect(calls[0]).toEqual({ provider: 'codex', model: 'gpt-5.5' });
    });
  });

  it('--distiller overrides JINN_DISTILL_PROVIDER', async () => {
    await withEnv({ JINN_DISTILL_PROVIDER: 'claude', JINN_DISTILL_MODEL: undefined }, async () => {
      const { writer } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
      const calls: Array<{ provider: RecordedProvider; model: string }> = [];
      const code = await runJinnLayerCli(['distill', 'run', '--distiller', 'codex', '--out', outDir], {
        writer,
        distillRunDeps: stubDeps({
          distill: undefined,
          metaDistill: undefined,
          distillerFactory: recordingDistillerFactory(calls),
        }),
      });

      expect(code).toBe(0);
      expect(calls[0]!.provider).toBe('codex');
    });
  });

  it('JINN_DISTILL_MODEL overrides the selected provider default', async () => {
    await withEnv({ JINN_DISTILL_PROVIDER: 'codex', JINN_DISTILL_MODEL: 'gpt-5.4-mini' }, async () => {
      const { writer } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
      const calls: Array<{ provider: RecordedProvider; model: string }> = [];
      const code = await runJinnLayerCli(['distill', 'run', '--out', outDir], {
        writer,
        distillRunDeps: stubDeps({
          distill: undefined,
          metaDistill: undefined,
          distillerFactory: recordingDistillerFactory(calls),
        }),
      });

      expect(code).toBe(0);
      expect(calls[0]).toEqual({ provider: 'codex', model: 'gpt-5.4-mini' });
    });
  });

  it('--local-only bypasses live publish deps and still writes local skill output', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--local-only', '--out', outDir, '--json'], {
      writer,
      distillRunDeps: stubDeps({ publishDeps: undefined }),
    });

    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.bridge.bridged).toHaveLength(2);
    expect(result.bridge.bridged.every((b: { envelopeRef: string; anchorTx: string | null }) => b.envelopeRef.startsWith('local:envelope:'))).toBe(true);
    expect(result.bridge.bridged.every((b: { anchorTx: string | null }) => b.anchorTx === null)).toBe(true);
    expect(result.outDir).toBe(outDir);
    expect(readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory())).toHaveLength(2);
  });

  it('--local-only overrides injected publish deps', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-cli-'));
    const code = await runJinnLayerCli(['distill', 'run', '--local-only', '--out', outDir, '--json'], {
      writer,
      distillRunDeps: stubDeps(),
    });

    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.bridge.bridged.every((b: { envelopeRef: string }) => b.envelopeRef.startsWith('local:envelope:'))).toBe(true);
    expect(result.bridge.bridged.every((b: { anchorTx: string | null }) => b.anchorTx === null)).toBe(true);
  });

  it('distill eval-prep bridges/gates/clusters once and runs both models over the same frozen clusters', async () => {
    await withEnv({
      JINN_LAYER_PRIVATE_KEY: undefined,
      JINN_LAYER_SAFE_ADDRESS: undefined,
      JINN_LAYER_AGENT_ID: undefined,
    }, async () => {
      const { writer, out } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
      const list = vi.fn(async () => [
        dref('alpha__repo-1', 'pass'),
        dref('alpha__repo-1', 'fail'),
        dref('beta__repo-2', 'fail'),
        dref('beta__repo-2', 'fail'),
        dref('gamma__repo-3', 'pass'),
      ]);
      const calls: Record<string, string[]> = {};
      const factoryCalls: Array<{ provider: RecordedProvider; model: string }> = [];
      const factory = (provider: RecordedProvider, model: string) => {
        factoryCalls.push({ provider, model });
        return {
          distill: async (cluster: DistillCluster): Promise<DistillLLMOutput> => {
            (calls[model] ??= []).push(cluster.clusterId);
            return {
              name: `eval-${model}-${cluster.tier}`.replace(/[^a-z0-9]+/g, '-'),
              description: 'Use when comparing grouped solver attempts. Not for: unrelated tasks.',
              body: [
                '## When to use',
                'A grouped solver attempt set exposes a repeatable repair signal.',
                '## Strategy',
                'Compare the retained evidence group and distill the shared decision point.',
                '## Steps',
                '1. Read the grouped attempts. 2. Extract the stable rule.',
                '## Pitfalls',
                'Do not quote instance identifiers or patch-only trivia.',
                '## Verify',
                'Check the skill against every retained attempt in the cluster.',
              ].join('\n\n'),
            };
          },
          metaDistill: async (_cluster: MetaCluster): Promise<MetaDistillLLMOutput> => META_OUT,
        };
      };

      const code = await runJinnLayerCli([
        'distill',
        'eval-prep',
        '--out',
        outDir,
        '--json',
        '--limit',
        '5',
        '--max-clusters',
        '3',
      ], {
        writer,
        distillRunDeps: stubDeps({
          verdictSource: { list },
          fetchEvidence: async (r: AttemptRef): Promise<BridgeEvidence> => verifiedEvidence(r, {
            taskSummary: `short regression summary for ${r.instanceId}`,
            patch: `diff --git a/x.py b/x.py\n+ change ${r.polarity}\n`,
          }),
          publishDeps: undefined,
          distill: undefined,
          metaDistill: undefined,
          distillerFactory: factory,
          slateInstanceIds: new Set(),
        }),
      });

      expect(code).toBe(0);
      expect(list).toHaveBeenCalledTimes(1);
      expect(factoryCalls).toEqual([
        { provider: 'codex', model: 'gpt-5.4-mini' },
        { provider: 'codex', model: 'gpt-5.5' },
      ]);
      expect(calls['gpt-5.4-mini']).toEqual(calls['gpt-5.5']);
      expect(calls['gpt-5.4-mini']).toEqual([
        'contrastive:alpha__repo-1',
        'lesson:beta__repo-2',
        'pattern:gamma__repo-3',
      ]);

      const result = JSON.parse(out());
      expect(result.selection.map((row: { clusterId: string }) => row.clusterId)).toEqual(calls['gpt-5.5']);
      expect(existsSync(join(outDir, 'selection.json'))).toBe(true);
      expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(outDir, 'raw-evidence', 'manifest.json'))).toBe(true);
      expect(readFileSync(join(outDir, 'raw-evidence', 'evidence.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(5);
      expect(existsSync(join(outDir, 'distilled', 'mini', 'manifest.json'))).toBe(true);
      expect(existsSync(join(outDir, 'distilled', 'gpt-5.5', 'manifest.json'))).toBe(true);
      expect(readdirSync(join(outDir, 'distilled', 'mini', 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory())).toHaveLength(3);
      expect(readdirSync(join(outDir, 'distilled', 'gpt-5.5', 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory())).toHaveLength(3);
    });
  });

  it('distill eval-prep routes explicitly requested Claude models through Claude ports', async () => {
    const { writer } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    const factoryCalls: Array<{ provider: RecordedProvider; model: string }> = [];
    const factory = (provider: RecordedProvider, model: string) => {
      factoryCalls.push({ provider, model });
      return {
        distill: async (cluster: DistillCluster) => validEvalOutput(`${model}-${cluster.clusterId}`),
        metaDistill: async () => META_OUT,
      };
    };

    const code = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--distiller', 'claude',
      '--models', 'claude-haiku-4-5-20251001,claude-opus-4-8',
      '--max-clusters', '1',
    ], {
      writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => [dref('alpha__repo-1', 'pass')] },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        distillerFactory: factory,
        slateInstanceIds: new Set(),
      }),
    });

    expect(code).toBe(0);
    expect(factoryCalls).toEqual([
      { provider: 'claude', model: 'claude-haiku-4-5-20251001' },
      { provider: 'claude', model: 'claude-opus-4-8' },
    ]);
    expect(existsSync(join(outDir, 'distilled', 'haiku', 'manifest.json'))).toBe(true);
    expect(existsSync(join(outDir, 'distilled', 'opus', 'manifest.json'))).toBe(true);
  });

  it('distill eval-prep keeps stage-1 calls within the requested shared concurrency limit', async () => {
    const { writer } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    let active = 0;
    let peak = 0;
    const factory = (_provider: RecordedProvider, model: string) => ({
      distill: async (cluster: DistillCluster): Promise<DistillLLMOutput> => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return validEvalOutput(`${model}-${cluster.clusterId}`);
      },
      metaDistill: async () => META_OUT,
    });

    const code = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini,gpt-5.5',
      '--max-clusters', '3',
      '--max-patterns', '3',
      '--concurrency', '2',
    ], {
      writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => [
          dref('alpha__repo-1', 'pass'),
          dref('beta__repo-2', 'pass'),
          dref('gamma__repo-3', 'pass'),
        ] },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        distillerFactory: factory,
        slateInstanceIds: new Set(),
      }),
    });

    expect(code).toBe(0);
    expect(peak).toBe(2);
  });

  it('distill eval-prep records per-model rejects without changing the attempted cluster set', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    const calls: Record<string, string[]> = {};
    const factory = (_provider: RecordedProvider, model: string) => ({
      distill: async (cluster: DistillCluster): Promise<DistillLLMOutput> => {
        (calls[model] ??= []).push(cluster.clusterId);
        const validBody = [
          '## When to use', 'A grouped solver attempt set exposes a repeatable repair signal.',
          '## Strategy', 'Compare the retained evidence group and distill the shared decision point.',
          '## Steps', '1. Read the grouped attempts. 2. Extract the stable rule.',
          '## Pitfalls', 'Do not quote instance identifiers or patch-only trivia.',
          '## Verify', 'Check the skill against every retained attempt in the cluster.',
        ].join('\n\n');
        return {
          name: `eval-${model}`.replace(/[^a-z0-9]+/g, '-'),
          description: model === 'gpt-5.4-mini'
            ? 'Use when comparing grouped solver attempts.'
            : 'Use when comparing grouped solver attempts. Not for: unrelated tasks.',
          body: validBody,
        };
      },
      metaDistill: async (_cluster: MetaCluster): Promise<MetaDistillLLMOutput> => META_OUT,
    });

    const code = await runJinnLayerCli([
      'distill',
      'eval-prep',
      '--out',
      outDir,
      '--json',
      '--models',
      'gpt-5.4-mini,gpt-5.5',
      '--max-clusters',
      '1',
    ], {
      writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => [dref('alpha__repo-1', 'pass')] },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        distillerFactory: factory,
        slateInstanceIds: new Set(),
      }),
    });

    expect(code).toBe(0);
    expect(calls['gpt-5.4-mini']).toEqual(calls['gpt-5.5']);
    const result = JSON.parse(out());
    const mini = result.models.find((m: { model: string }) => m.model === 'gpt-5.4-mini');
    const full = result.models.find((m: { model: string }) => m.model === 'gpt-5.5');
    expect(mini.rejected).toHaveLength(1);
    expect(mini.published).toHaveLength(0);
    expect(full.published).toHaveLength(1);
    expect(full.rejected).toHaveLength(0);
    expect(mini.attemptedClusterIds).toEqual(result.selection.map((row: { clusterId: string }) => row.clusterId));
    expect(full.attemptedClusterIds).toEqual(result.selection.map((row: { clusterId: string }) => row.clusterId));
  });

  it('distill eval-prep can retain grouped attempts and run per-model meta distillation', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    const stage1Calls: Record<string, string[]> = {};
    const metaCalls: Record<string, string[]> = {};
    const factory = (_provider: RecordedProvider, model: string) => ({
      distill: async (cluster: DistillCluster): Promise<DistillLLMOutput> => {
        (stage1Calls[model] ??= []).push(cluster.clusterId);
        return {
          name: `eval-${model}-${cluster.instanceIds[0]}`.replace(/[^a-z0-9]+/g, '-'),
          description: 'Use when a grouped success pattern repeats across attempts. Not for: unrelated tasks.',
          body: [
            '## When to use', 'A grouped solver attempt set exposes a repeatable repair signal.',
            '## Strategy', 'Compare the retained evidence group and distill the shared decision point.',
            '## Steps', '1. Read the grouped attempts. 2. Extract the stable rule.',
            '## Pitfalls', 'Do not quote instance identifiers or patch-only trivia.',
            '## Verify', 'Check the skill against every retained attempt in the cluster.',
          ].join('\n\n'),
        };
      },
      metaDistill: async (cluster: MetaCluster): Promise<MetaDistillLLMOutput> => {
        (metaCalls[model] ??= []).push(cluster.metaClusterId);
        return META_OUT;
      },
    });
    const groupedRefs = [
      { ...dref('alpha__repo-1', 'pass'), requestId: '0xalpha1', manifestCid: 'bafy-alpha-1' },
      { ...dref('alpha__repo-1', 'pass'), requestId: '0xalpha2', manifestCid: 'bafy-alpha-2' },
      { ...dref('beta__repo-2', 'pass'), requestId: '0xbeta1', manifestCid: 'bafy-beta-1' },
      { ...dref('beta__repo-2', 'pass'), requestId: '0xbeta2', manifestCid: 'bafy-beta-2' },
    ];

    const code = await runJinnLayerCli([
      'distill',
      'eval-prep',
      '--out',
      outDir,
      '--json',
      '--meta',
      '--group-cap',
      '2',
      '--limit',
      '4',
      '--max-clusters',
      '2',
      '--max-patterns',
      '2',
    ], {
      writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => groupedRefs },
        fetchEvidence: async (r: AttemptRef): Promise<BridgeEvidence> => verifiedEvidence(r, {
          taskSummary: `success regression summary for ${r.instanceId}`,
          patch: `diff --git a/x.py b/x.py\n+ success ${r.requestId}\n`,
        }),
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        distillerFactory: factory,
        slateInstanceIds: new Set(),
      }),
    });

    expect(code).toBe(0);
    expect(stage1Calls['gpt-5.4-mini']).toEqual(stage1Calls['gpt-5.5']);
    expect(metaCalls['gpt-5.4-mini']).toEqual(['cross-instance:strategic-pattern']);
    expect(metaCalls['gpt-5.5']).toEqual(['cross-instance:strategic-pattern']);

    const result = JSON.parse(out());
    expect(result.manifest.groupCap).toBe(2);
    expect(result.manifest.meta).toBe(true);
    expect(result.selection.map((row: { score: { groupSize: number } }) => row.score.groupSize)).toEqual([2, 2]);
    for (const model of result.models) {
      expect(model.metaClusterIds).toEqual(['cross-instance:strategic-pattern']);
      expect(model.metaDistilled.published).toHaveLength(1);
      expect(model.metaDistilled.rejected).toHaveLength(0);
      expect(model.metaDistilled.errors).toHaveLength(0);
    }
    expect(existsSync(join(outDir, 'distilled', 'mini', 'meta-skills', 'cross-instance-orm-dedup', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(outDir, 'distilled', 'gpt-5.5', 'meta-skills', 'cross-instance-orm-dedup', 'SKILL.md'))).toBe(true);
  });

  it('distill eval-prep --select-only writes selection artifacts without calling distillers', async () => {
    const { writer, out } = capture();
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    const factory = vi.fn(recordingDistillerFactory([]));

    const code = await runJinnLayerCli([
      'distill',
      'eval-prep',
      '--out',
      outDir,
      '--json',
      '--select-only',
      '--limit',
      '3',
      '--max-clusters',
      '2',
    ], {
      writer,
      distillRunDeps: stubDeps({
        verdictSource: {
          list: async () => [
            dref('alpha__repo-1', 'pass'),
            dref('alpha__repo-1', 'fail'),
            dref('beta__repo-2', 'fail'),
          ],
        },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        distillerFactory: factory,
        slateInstanceIds: new Set(),
      }),
    });

    expect(code).toBe(0);
    expect(factory).not.toHaveBeenCalled();
    const result = JSON.parse(out());
    expect(result.manifest.selectOnly).toBe(true);
    expect(result.models).toEqual([]);
    expect(existsSync(join(outDir, 'selection.json'))).toBe(true);
    expect(existsSync(join(outDir, 'raw-evidence', 'evidence.jsonl'))).toBe(true);
    expect(existsSync(join(outDir, 'distilled'))).toBe(false);
  });

  it('distill eval-prep fails the invariant if a model attempts anything outside the frozen selection', () => {
    expect(() => assertAttemptedClusterIds(
      ['contrastive:alpha__repo-1'],
      ['contrastive:alpha__repo-1', 'lesson:outside__repo-9'],
    )).toThrow(/did not match frozen selection/);
  });

  it('distill eval-prep reruns idempotently without bridge, distill, or meta calls', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    const list = vi.fn(async () => TWO_PATTERN_REFS);
    const stage1Calls: string[] = [];
    const metaCalls: string[] = [];
    const first = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '2',
      '--max-patterns', '2',
      '--meta',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => {
            stage1Calls.push(cluster.clusterId);
            return validEvalOutput(`idem-${cluster.instanceIds[0]}`);
          },
          metaDistill: async (cluster: MetaCluster) => {
            metaCalls.push(cluster.metaClusterId);
            return META_OUT;
          },
        }),
      }),
    });

    expect(first).toBe(0);
    expect(list).toHaveBeenCalledTimes(1);
    expect(stage1Calls).toHaveLength(2);
    expect(metaCalls).toEqual(['cross-instance:strategic-pattern']);
    const topManifestBefore = readFileSync(join(outDir, 'manifest.json'), 'utf-8');
    const modelManifestBefore = readFileSync(join(outDir, 'distilled', 'mini', 'manifest.json'), 'utf-8');

    const secondList = vi.fn(async () => {
      throw new Error('should not bridge on resume');
    });
    const secondStage1 = vi.fn(async () => {
      throw new Error('should not distill on resume');
    });
    const secondMeta = vi.fn(async () => {
      throw new Error('should not meta-distill on resume');
    });
    const second = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '2',
      '--max-patterns', '2',
      '--meta',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: secondList },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({ distill: secondStage1, metaDistill: secondMeta }),
      }),
    });

    expect(second).toBe(0);
    expect(secondList).not.toHaveBeenCalled();
    expect(secondStage1).not.toHaveBeenCalled();
    expect(secondMeta).not.toHaveBeenCalled();
    expect(readFileSync(join(outDir, 'manifest.json'), 'utf-8')).toBe(topManifestBefore);
    expect(readFileSync(join(outDir, 'distilled', 'mini', 'manifest.json'), 'utf-8')).toBe(modelManifestBefore);
  });

  it('distill eval-prep fills only missing stage-1 attempts on resume', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    const first = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '2',
      '--max-patterns', '2',
      '--json',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => TWO_PATTERN_REFS },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => validEvalOutput(`partial-${cluster.instanceIds[0]}`),
          metaDistill: async (_cluster: MetaCluster) => META_OUT,
        }),
      }),
    });
    expect(first).toBe(0);

    const selection = JSON.parse(readFileSync(join(outDir, 'selection.json'), 'utf-8')) as { selected: Array<{ clusterId: string }> };
    const missing = selection.selected[1]!.clusterId;
    rmSync(join(outDir, 'distilled', 'mini', 'attempts', attemptRecordFileName(missing)));

    const calls: string[] = [];
    const code = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '2',
      '--max-patterns', '2',
      '--json',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => { throw new Error('should not bridge on resume'); } },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => {
            calls.push(cluster.clusterId);
            return validEvalOutput(`partial-${cluster.instanceIds[0]}`);
          },
          metaDistill: async (_cluster: MetaCluster) => META_OUT,
        }),
      }),
    });

    expect(code).toBe(0);
    expect(calls).toEqual([missing]);
    const manifest = JSON.parse(readFileSync(join(outDir, 'distilled', 'mini', 'manifest.json'), 'utf-8'));
    expect(manifest.published).toHaveLength(2);
    expect(manifest.errors).toHaveLength(0);
  });

  it('distill eval-prep can add a new model label to an existing frozen selection', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    const first = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '2',
      '--max-patterns', '2',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => TWO_PATTERN_REFS },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => validEvalOutput(`mini-${cluster.instanceIds[0]}`),
          metaDistill: async (_cluster: MetaCluster) => META_OUT,
        }),
      }),
    });
    expect(first).toBe(0);

    const calls: string[] = [];
    const { writer, out } = capture();
    const second = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.5',
      '--max-clusters', '2',
      '--max-patterns', '2',
      '--json',
    ], {
      writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => { throw new Error('should not bridge on resume'); } },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => {
            calls.push(cluster.clusterId);
            return validEvalOutput(`full-${cluster.instanceIds[0]}`);
          },
          metaDistill: async (_cluster: MetaCluster) => META_OUT,
        }),
      }),
    });

    expect(second).toBe(0);
    expect(calls).toEqual(['pattern:alpha__repo-1', 'pattern:beta__repo-2']);
    const result = JSON.parse(out());
    expect(result.models.map((model: { label: string }) => model.label)).toEqual(['gpt-5.5', 'mini']);
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.models.map((model: { label: string }) => model.label)).toEqual(['gpt-5.5', 'mini']);
  });

  it('distill eval-prep rejects changed selection config unless --force rebuilds from scratch', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    const first = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '1',
      '--max-patterns', '2',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => TWO_PATTERN_REFS },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => validEvalOutput(`force-${cluster.instanceIds[0]}`),
          metaDistill: async (_cluster: MetaCluster) => META_OUT,
        }),
      }),
    });
    expect(first).toBe(0);

    const staleDir = join(outDir, 'distilled', 'mini', 'skills', 'stale-skill');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'SKILL.md'), '# stale\n');

    const conflict = capture();
    const conflictCode = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '2',
      '--max-patterns', '2',
    ], {
      writer: conflict.writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => TWO_PATTERN_REFS },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => validEvalOutput(`force-${cluster.instanceIds[0]}`),
          metaDistill: async (_cluster: MetaCluster) => META_OUT,
        }),
      }),
    });
    expect(conflictCode).toBe(1);
    expect(conflict.out()).toContain('different frozen selection config');
    expect(existsSync(join(staleDir, 'SKILL.md'))).toBe(true);

    const forceCalls: string[] = [];
    const forced = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '2',
      '--max-patterns', '2',
      '--force',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => TWO_PATTERN_REFS },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => {
            forceCalls.push(cluster.clusterId);
            return validEvalOutput(`force-${cluster.instanceIds[0]}`);
          },
          metaDistill: async (_cluster: MetaCluster) => META_OUT,
        }),
      }),
    });

    expect(forced).toBe(0);
    expect(forceCalls).toHaveLength(2);
    expect(existsSync(join(staleDir, 'SKILL.md'))).toBe(false);
  });

  it('distill eval-prep treats error attempts as terminal unless --retry-errors is passed', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    const first = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '1',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => [dref('alpha__repo-1', 'pass')] },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async () => { throw new Error('temporary model failure'); },
          metaDistill: async (_cluster: MetaCluster) => META_OUT,
        }),
      }),
    });
    expect(first).toBe(1);

    const skipped = vi.fn(async () => validEvalOutput('retry-alpha'));
    const second = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '1',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => { throw new Error('should not bridge on resume'); } },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({ distill: skipped, metaDistill: async (_cluster: MetaCluster) => META_OUT }),
      }),
    });
    expect(second).toBe(1);
    expect(skipped).not.toHaveBeenCalled();

    const retried: string[] = [];
    const third = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '1',
      '--retry-errors',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => { throw new Error('should not bridge on resume'); } },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => {
            retried.push(cluster.clusterId);
            return validEvalOutput('retry-alpha');
          },
          metaDistill: async (_cluster: MetaCluster) => META_OUT,
        }),
      }),
    });
    expect(third).toBe(0);
    expect(retried).toEqual(['pattern:alpha__repo-1']);
  });

  it('distill eval-prep resumes meta by source signature and reruns when stage-1 inputs change', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-eval-prep-cli-'));
    let changed = false;
    const firstMetaCalls: string[] = [];
    const first = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '2',
      '--max-patterns', '2',
      '--meta',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => TWO_PATTERN_REFS },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => validEvalOutput(`meta-${cluster.instanceIds[0]}`, changed ? ' Changed source.' : ''),
          metaDistill: async (cluster: MetaCluster) => {
            firstMetaCalls.push(cluster.metaClusterId);
            return META_OUT;
          },
        }),
      }),
    });
    expect(first).toBe(0);
    expect(firstMetaCalls).toEqual(['cross-instance:strategic-pattern']);

    const skippedMeta = vi.fn(async () => {
      throw new Error('should not meta-distill when signature matches');
    });
    const second = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '2',
      '--max-patterns', '2',
      '--meta',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => { throw new Error('should not bridge on resume'); } },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => validEvalOutput(`meta-${cluster.instanceIds[0]}`),
          metaDistill: skippedMeta,
        }),
      }),
    });
    expect(second).toBe(0);
    expect(skippedMeta).not.toHaveBeenCalled();

    const selection = JSON.parse(readFileSync(join(outDir, 'selection.json'), 'utf-8')) as { selected: Array<{ clusterId: string }> };
    const changedCluster = selection.selected[0]!.clusterId;
    rmSync(join(outDir, 'distilled', 'mini', 'attempts', attemptRecordFileName(changedCluster)));
    changed = true;
    const metaRerunCalls: string[] = [];
    const third = await runJinnLayerCli([
      'distill', 'eval-prep',
      '--out', outDir,
      '--models', 'gpt-5.4-mini',
      '--max-clusters', '2',
      '--max-patterns', '2',
      '--meta',
    ], {
      writer: capture().writer,
      distillRunDeps: stubDeps({
        verdictSource: { list: async () => { throw new Error('should not bridge on resume'); } },
        publishDeps: undefined,
        distill: undefined,
        metaDistill: undefined,
        slateInstanceIds: new Set(),
        distillerFactory: () => ({
          distill: async (cluster: DistillCluster) => validEvalOutput(`meta-${cluster.instanceIds[0]}`, ' Changed source.'),
          metaDistill: async (cluster: MetaCluster) => {
            metaRerunCalls.push(cluster.metaClusterId);
            return META_OUT;
          },
        }),
      }),
    });

    expect(third).toBe(0);
    expect(metaRerunCalls).toEqual(['cross-instance:strategic-pattern']);
  });
});

describe('jinn-layer distill (own captures, rung 1)', () => {
  // These tests exercise a consented LOCAL run: point the where-it-runs mode
  // (#1490) at a fresh file pre-set to `local`, so a bare `distill` runs the
  // engine rather than showing first-run consent. Consent/mode behaviour has
  // its own describe below.
  beforeEach(() => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    process.env['JINN_LAYER_DISTILL_MODE_PATH'] = modePath;
  });
  afterEach(() => {
    delete process.env['JINN_LAYER_DISTILL_MODE_PATH'];
  });

  it('AC: distills a fixture capture and installs a parseable SKILL.md on disk', async () => {
    const { writer, out } = capture();
    const capturesDir = capturesDirWith(ownCapture());
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));

    // #1490: install is now an explicit step — pass --install all to land the
    // skill in the active dir (default is stage-only, not installed).
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDir, '--out', outDir, '--install', 'all'],
      { writer, distillDeps: stubDistillDeps() },
    );

    expect(code).toBe(0);
    // The installed skill lands under <out>/<name>/SKILL.md — the same shape
    // `skills install` writes, via the shared createLocalSkillSink.
    const md = readFileSync(join(outDir, 'orm-fanout-dedup', 'SKILL.md'), 'utf-8');
    const pkg = parseSkillMarkdown(md);
    expect(pkg.name).toBe('orm-fanout-dedup');
    expect(pkg.jinn.skillKind).toBe('strategic-pattern');
    // The #1490 run presentation shows the skill in the installed panel with
    // its source-capture provenance, and states nothing left the machine.
    expect(out()).toContain('orm-fanout-dedup');
    expect(out()).toMatch(/installed · ready/);
    expect(out()).toContain('nothing left this machine');
  });

  it('AC: install-all — every produced skill lands in the install dir', async () => {
    const { writer, out } = capture();
    // Two distinct own sessions → two clusters → two installed skills.
    const capturesDir = capturesDirWith(
      ownCapture(),
      ownCapture({
        session: { sessionId: 'own-nplusone', capturedAt: '2026-07-09T08:30:00.000Z' },
      }),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    // Give each cluster a distinct skill name so both install side by side.
    let n = 0;
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDir, '--out', outDir, '--install', 'all', '--json'],
      { writer, distillDeps: stubDistillDeps({ distill: async () => ({ ...VALID_DISTILL, name: `skill-${++n}` }) }) },
    );
    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.distilled.published).toHaveLength(2);
    expect(result.installed).toHaveLength(2);
    const dirs = readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(dirs).toHaveLength(2);
  });

  it('AC: the distiller model is honored and recorded distinct from the runtime model', async () => {
    const { writer } = capture();
    const capturesDir = capturesDirWith(ownCapture()); // runtime model: claude-haiku-4-5
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    const calls: Array<{ provider: string; model: string }> = [];

    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDir, '--out', outDir, '--distiller-model', 'claude-opus-4-8', '--install', 'all'],
      {
        writer,
        distillDeps: {
          // No distill port → the provider factory resolves it from the model,
          // proving the chosen distiller model reaches the factory.
          distillerFactory: (provider, model) => {
            calls.push({ provider, model });
            return { distill: async () => VALID_DISTILL, metaDistill: async () => { throw new Error('unused'); } };
          },
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toEqual([{ provider: 'claude', model: 'claude-opus-4-8' }]);
    // Provenance records the DISTILLER model, not the capture's runtime model.
    const pkg = parseSkillMarkdown(readFileSync(join(outDir, 'orm-fanout-dedup', 'SKILL.md'), 'utf-8'));
    expect(pkg.jinn.distillModel).toBe('claude-opus-4-8');
    expect(pkg.jinn.distillModel).not.toBe('claude-haiku-4-5');
  });

  it('selects the most recent captures under --limit', async () => {
    const { writer, out } = capture();
    const capturesDir = capturesDirWith(
      ownCapture({ session: { sessionId: 'old', capturedAt: '2026-07-01T00:00:00.000Z' } }),
      ownCapture({ session: { sessionId: 'recent', capturedAt: '2026-07-09T00:00:00.000Z' } }),
    );
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    const seen: string[] = [];
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDir, '--out', outDir, '--limit', '1', '--json'],
      {
        writer,
        distillDeps: {
          distill: async (c: DistillCluster) => {
            seen.push(...c.instanceIds);
            return VALID_DISTILL;
          },
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out()).capturesConsidered).toBe(1);
    // Only the recent session's capture reached the distiller.
    expect(seen).toEqual(['recent']);
  });

  it('reads captures from JINN_LAYER_CAPTURES_DIR when no --captures flag is passed', async () => {
    await withEnv({ JINN_LAYER_CAPTURES_DIR: capturesDirWith(ownCapture()) }, async () => {
      const { writer, out } = capture();
      const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
      const code = await runJinnLayerCli(['distill', '--out', outDir], { writer, distillDeps: stubDistillDeps() });
      expect(code).toBe(0);
      // Install-agnostic: the run rendered the distilled skill by name.
      expect(out()).toContain('orm-fanout-dedup');
    });
  });

  it('exits 0 with a clear message when there are no local captures', async () => {
    const { writer, out } = capture();
    const emptyDir = mkdtempSync(join(tmpdir(), 'jinn-captures-empty-'));
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    const code = await runJinnLayerCli(
      ['distill', '--captures', emptyDir, '--out', outDir],
      { writer, distillDeps: stubDistillDeps() },
    );
    expect(code).toBe(0);
    expect(out()).toContain('No eligible captures');
  });

  it('skips a malformed capture file without corrupting --json stdout', async () => {
    const { writer, out } = capture();
    const capturesDir = capturesDirWith(ownCapture());
    writeFileSync(join(capturesDir, 'broken.json'), '{ not valid json');
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDir, '--out', outDir, '--json'],
      { writer, distillDeps: stubDistillDeps() },
    );
    expect(code).toBe(0);
    // The malformed-file warning goes to stderr, so stdout is still one JSON line.
    const result = JSON.parse(out());
    expect(result.capturesConsidered).toBe(1);
    expect(result.distilled.published).toHaveLength(1);
  });

  it('emits parseable JSON (not a plain message) when there are no captures under --json', async () => {
    const { writer, out } = capture();
    const emptyDir = mkdtempSync(join(tmpdir(), 'jinn-captures-empty-'));
    const code = await runJinnLayerCli(
      ['distill', '--captures', emptyDir, '--json'],
      { writer, distillDeps: stubDistillDeps() },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out()).capturesConsidered).toBe(0);
  });

  it('rejects an unknown --distiller value', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDirWith(ownCapture()), '--distiller', 'gpt'],
      { writer, distillDeps: stubDistillDeps() },
    );
    expect(code).toBe(2);
    expect(out()).toContain('distiller must be "claude" or "codex"');
  });
});

describe('jinn-layer distill — consent + where-it-runs (#1490)', () => {
  /** Record the sessionIds the distiller was actually asked to distill. */
  function recordingDistill(seen: string[]): DistillCliDeps['distill'] {
    return async (c) => {
      seen.push(...c.instanceIds);
      return { ...VALID_DISTILL, name: `s-${c.instanceIds[0]}` };
    };
  }

  it('AC 1c: --where local persists the mode and echoes it, running nothing', async () => {
    const modePath = tmpModeFile();
    const seen: string[] = [];
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--where', 'local', '--captures', capturesDirWith(ownCapture())],
        { writer, distillDeps: { distill: recordingDistill(seen) } },
      );
      expect(code).toBe(0);
      expect(out()).toMatch(/mode set to local/);
      expect(seen).toEqual([]); // setter only — never ran
      expect(readDistillMode(modePath)).toBe('local');
    });
  });

  it('AC 1c: --where defer and --where off persist and echo, running nothing', async () => {
    for (const mode of ['defer', 'off'] as const) {
      const modePath = tmpModeFile();
      await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
        const { writer, out } = capture();
        const code = await runJinnLayerCli(['distill', '--where', mode], { writer, distillDeps: stubDistillDeps() });
        expect(code).toBe(0);
        expect(readDistillMode(modePath)).toBe(mode);
        expect(out()).toMatch(mode === 'defer' ? /mode set to deferred/ : /mode set to off/);
      });
    }
  });

  it('AC 1c: --where local --json emits the persisted shape', async () => {
    const modePath = tmpModeFile();
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      await runJinnLayerCli(['distill', '--where', 'local', '--json'], { writer, distillDeps: stubDistillDeps() });
      expect(JSON.parse(out())).toEqual({ where: 'local' });
    });
  });

  it('rejects an unknown --where value with exit 2', async () => {
    const modePath = tmpModeFile();
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(['distill', '--where', 'sideways'], { writer, distillDeps: stubDistillDeps() });
      expect(code).toBe(2);
      expect(out()).toContain('--where must be');
      expect(readDistillMode(modePath)).toBe('unset'); // nothing persisted on error
    });
  });

  it('AC 1a: first run (unset, non-interactive) defaults to defer, runs nothing, and does NOT persist', async () => {
    const modePath = tmpModeFile();
    const seen: string[] = [];
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-'))],
        { writer, distillDeps: { distill: recordingDistill(seen), isTty: false } },
      );
      expect(code).toBe(0);
      expect(out()).toMatch(/default is defer/i);
      expect(out()).toMatch(/nothing runs/i);
      expect(seen).toEqual([]); // safe default never runs the frontier pass
      expect(readDistillMode(modePath)).toBe('unset'); // not locked in — a TTY run still gets consent
    });
  });

  it('AC 1a: consent prompt returning local persists local and runs the pass', async () => {
    const modePath = tmpModeFile();
    const seen: string[] = [];
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-'))],
        { writer, distillDeps: { distill: recordingDistill(seen), promptConsent: async () => 'local' } },
      );
      expect(code).toBe(0);
      expect(readDistillMode(modePath)).toBe('local');
      expect(seen).toEqual(['own-orm-dedup']); // it ran
      expect(out()).toMatch(/recorded — distill mode is LOCAL/);
      expect(out()).toContain('nothing left this machine'); // the run presentation followed
    });
  });

  it('AC 1a: consent prompt returning defer persists defer and runs nothing', async () => {
    const modePath = tmpModeFile();
    const seen: string[] = [];
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture())],
        { writer, distillDeps: { distill: recordingDistill(seen), promptConsent: async () => 'defer' } },
      );
      expect(code).toBe(0);
      expect(readDistillMode(modePath)).toBe('defer');
      expect(seen).toEqual([]);
      expect(out()).toMatch(/DEFERRED/);
    });
  });

  it('AC 1c: persisted defer runs nothing and prints the deferred path', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('defer', modePath);
    const seen: string[] = [];
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture())],
        { writer, distillDeps: { distill: recordingDistill(seen) } },
      );
      expect(code).toBe(0);
      expect(seen).toEqual([]);
      expect(out()).toMatch(/deferred/i);
      expect(out()).toContain('--where local');
    });
  });

  it('persisted off runs nothing and says distill is off', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('off', modePath);
    const seen: string[] = [];
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture())],
        { writer, distillDeps: { distill: recordingDistill(seen) } },
      );
      expect(code).toBe(0);
      expect(seen).toEqual([]);
      expect(out()).toMatch(/distill is OFF/);
    });
  });

  it('AC 1b: persisted local renders the run presentation with the skills panel', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    const seen: string[] = [];
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-'))],
        { writer, distillDeps: { distill: recordingDistill(seen) } },
      );
      expect(code).toBe(0);
      expect(seen).toEqual(['own-orm-dedup']);
      const o = out();
      expect(o).toMatch(/distill: local/);
      expect(o).toContain('s-own-orm-dedup'); // skill name in the panel
      expect(o).toContain('from'); // provenance line
      expect(o).toContain('fix duplicate rows after a join'); // source-capture summary
      expect(o).toContain('/jinn skills'); // management hint
    });
  });

  it('AC 1d: an errored cluster renders the failure state and points at --resume', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-'))],
        { writer, distillDeps: { distill: async () => { throw new Error('the distiller stopped responding'); } } },
      );
      expect(code).toBe(1);
      expect(out()).toMatch(/distill failed/i);
      expect(out()).toContain('--resume');
    });
  });

  it('AC 1c: --resume distills only the captures no installed skill covers', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    const capturesDir = capturesDirWith(ownCapture());
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      // First run installs a skill covering own-orm-dedup.
      const first = capture();
      const seen1: string[] = [];
      await runJinnLayerCli(['distill', '--captures', capturesDir, '--out', outDir], {
        writer: first.writer,
        distillDeps: { distill: recordingDistill(seen1) },
      });
      expect(seen1).toEqual(['own-orm-dedup']);

      // A second capture arrives; --resume distills only the uncovered one.
      writeFileSync(
        join(capturesDir, 'own-two.json'),
        JSON.stringify(ownCapture({ session: { sessionId: 'own-two', capturedAt: '2026-07-09T09:00:00.000Z' } })),
      );
      const second = capture();
      const seen2: string[] = [];
      const code = await runJinnLayerCli(['distill', '--resume', '--captures', capturesDir, '--out', outDir], {
        writer: second.writer,
        distillDeps: { distill: recordingDistill(seen2) },
      });
      expect(code).toBe(0);
      expect(seen2).toEqual(['own-two']); // the covered capture was skipped
    });
  });

  it('--resume never bypasses consent: on an unset mode it runs nothing (non-interactive)', async () => {
    const modePath = tmpModeFile(); // absent → unset
    const seen: string[] = [];
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--resume', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-'))],
        { writer, distillDeps: { distill: recordingDistill(seen), isTty: false } },
      );
      expect(code).toBe(0);
      expect(seen).toEqual([]); // no frontier pass without consent
      expect(out()).toMatch(/default is defer/i); // it fell through to first-run consent
      expect(readDistillMode(modePath)).toBe('unset');
    });
  });

  it('AC 1c: --resume with everything already distilled says nothing to resume', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    const capturesDir = capturesDirWith(ownCapture());
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      await runJinnLayerCli(['distill', '--captures', capturesDir, '--out', outDir], {
        writer: capture().writer,
        distillDeps: stubDistillDeps(),
      });
      const seen: string[] = [];
      const { writer, out } = capture();
      const code = await runJinnLayerCli(['distill', '--resume', '--captures', capturesDir, '--out', outDir], {
        writer,
        distillDeps: { distill: recordingDistill(seen) },
      });
      expect(code).toBe(0);
      expect(seen).toEqual([]);
      expect(out()).toMatch(/already distilled|nothing to resume/i);
    });
  });

  it('AC 1d: empty captures render the design empty state whatever the mode', async () => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', mkdtempSync(join(tmpdir(), 'jinn-captures-empty-'))],
        { writer, distillDeps: stubDistillDeps() },
      );
      expect(code).toBe(0);
      expect(out()).toMatch(/No eligible captures/i);
    });
  });
});

describe('jinn-layer distill — staged install choice (#1490)', () => {
  /** A fresh mode file pinned to local, plus the env pointing at it. */
  function withLocalMode(fn: (outDir: string) => Promise<void>): Promise<void> {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    return withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, () => fn(outDir));
  }
  /** The skill dir names directly under `dir` (installed = active, staged = -staged). */
  function skillDirs(dir: string): string[] {
    return existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
      : [];
  }
  const distinctNames = (): DistillCliDeps => ({
    distill: async (c) => ({ ...VALID_DISTILL, name: `s-${c.instanceIds[0]}` }),
  });

  it('default (non-interactive, no --install) distills but installs NOTHING — stage only', async () => {
    await withLocalMode(async (outDir) => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', outDir, '--json'],
        { writer, distillDeps: { distill: async () => VALID_DISTILL, isTty: false } },
      );
      expect(code).toBe(0);
      const r = JSON.parse(out());
      expect(r.distilled.published).toHaveLength(1); // distilled
      expect(r.installed).toEqual([]); // installed nothing (the consent-consistent default)
      expect(skillDirs(outDir)).toEqual([]); // active dir empty
      expect(skillDirs(`${outDir}-staged`)).toEqual(['orm-fanout-dedup']); // waiting in staging
    });
  });

  it('--install all installs every distilled skill into the active dir and clears staging', async () => {
    await withLocalMode(async (outDir) => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', outDir, '--install', 'all', '--json'],
        { writer, distillDeps: { distill: async () => VALID_DISTILL } },
      );
      expect(code).toBe(0);
      expect(JSON.parse(out()).installed).toEqual(['orm-fanout-dedup']);
      expect(skillDirs(outDir)).toEqual(['orm-fanout-dedup']); // live
      expect(skillDirs(`${outDir}-staged`)).toEqual([]); // moved out of staging
    });
  });

  it('--install none is the same as staging only', async () => {
    await withLocalMode(async (outDir) => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', outDir, '--install', 'none', '--json'],
        { writer, distillDeps: { distill: async () => VALID_DISTILL } },
      );
      expect(code).toBe(0);
      expect(JSON.parse(out()).installed).toEqual([]);
      expect(skillDirs(outDir)).toEqual([]);
    });
  });

  it('--install <name> installs just that skill; the rest stay staged', async () => {
    await withLocalMode(async (outDir) => {
      const capturesDir = capturesDirWith(
        ownCapture(),
        ownCapture({ session: { sessionId: 'own-two', capturedAt: '2026-07-09T09:00:00.000Z' } }),
      );
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDir, '--out', outDir, '--install', 's-own-two', '--json'],
        { writer, distillDeps: distinctNames() },
      );
      expect(code).toBe(0);
      expect(JSON.parse(out()).installed).toEqual(['s-own-two']);
      expect(skillDirs(outDir)).toEqual(['s-own-two']); // only the named one is live
      expect(skillDirs(`${outDir}-staged`)).toEqual(['s-own-orm-dedup']); // the other waits
    });
  });

  it('--install <unknown> exits 2 and installs nothing', async () => {
    await withLocalMode(async (outDir) => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', outDir, '--install', 'nope'],
        { writer, distillDeps: { distill: async () => VALID_DISTILL } },
      );
      expect(code).toBe(2);
      expect(out()).toContain('no distilled skill by that name');
      expect(skillDirs(outDir)).toEqual([]);
    });
  });

  it('interactive prompt returning all installs all', async () => {
    await withLocalMode(async (outDir) => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', outDir, '--json'],
        { writer, distillDeps: { distill: async () => VALID_DISTILL, promptInstall: async () => 'all' } },
      );
      expect(code).toBe(0);
      expect(JSON.parse(out()).installed).toEqual(['orm-fanout-dedup']);
    });
  });

  it('interactive prompt returning first installs exactly one of several', async () => {
    await withLocalMode(async (outDir) => {
      const capturesDir = capturesDirWith(
        ownCapture(),
        ownCapture({ session: { sessionId: 'own-two', capturedAt: '2026-07-09T09:00:00.000Z' } }),
      );
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDir, '--out', outDir, '--json'],
        { writer, distillDeps: { ...distinctNames(), promptInstall: async () => 'first' } },
      );
      expect(code).toBe(0);
      expect(JSON.parse(out()).installed).toHaveLength(1);
      expect(skillDirs(outDir)).toHaveLength(1);
    });
  });

  it('interactive prompt returning none stages only', async () => {
    await withLocalMode(async (outDir) => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', outDir, '--json'],
        { writer, distillDeps: { distill: async () => VALID_DISTILL, promptInstall: async () => 'none' } },
      );
      expect(code).toBe(0);
      expect(JSON.parse(out()).installed).toEqual([]);
      expect(skillDirs(outDir)).toEqual([]);
    });
  });

  it('human render: default stages (not installed + how to install); --install all shows installed·ready', async () => {
    await withLocalMode(async (outDir) => {
      const staged = capture();
      await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', outDir],
        { writer: staged.writer, distillDeps: { distill: async () => VALID_DISTILL, isTty: false } },
      );
      expect(staged.out()).toMatch(/distilled locally · not installed/);
      expect(staged.out()).toMatch(/stay local until you install/i);
      expect(staged.out()).toContain('--install all');
      // The forward-looking value shows in the panel.
      expect(staged.out()).toContain('helps');

      const installed = capture();
      await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out2-')), '--install', 'all'],
        { writer: installed.writer, distillDeps: { distill: async () => VALID_DISTILL } },
      );
      expect(installed.out()).toMatch(/installed · ready/);
    });
  });
});

describe('jinn-layer distill --progress ndjson (#1533)', () => {
  beforeEach(() => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    process.env['JINN_LAYER_DISTILL_MODE_PATH'] = modePath;
  });
  afterEach(() => {
    delete process.env['JINN_LAYER_DISTILL_MODE_PATH'];
  });

  function progressSink(): { stream: { write: (s: string) => boolean }; events: () => Array<Record<string, unknown>> } {
    const chunks: string[] = [];
    return {
      stream: { write: (s: string) => (chunks.push(s), true) },
      events: () =>
        chunks
          .join('')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l) as Record<string, unknown>),
    };
  }

  it('emits the full event sequence on stderr-side stream while --json stdout stays a single result object', async () => {
    const { writer, out } = capture();
    const { stream, events } = progressSink();
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-')), '--install', 'none', '--progress', 'ndjson', '--json'],
      { writer, distillDeps: stubDistillDeps({ progressStream: stream }) },
    );
    expect(code).toBe(0);

    // stdout: exactly one JSON object, the unchanged result shape.
    const result = JSON.parse(out());
    expect(result.distilled.published).toHaveLength(1);

    // progress stream: stamped, ordered events bracketing the run.
    const evs = events();
    const names = evs.map((e) => e['event']);
    expect(names[0]).toBe('run_start');
    expect(names).toContain('cluster_plan');
    expect(names).toContain('cluster_start');
    expect(names).toContain('cluster_end');
    expect(names.at(-1)).toBe('run_end');
    for (const ev of evs) {
      expect(ev['v']).toBe(1);
      expect(typeof ev['runId']).toBe('string');
    }

    const runStart = evs.find((e) => e['event'] === 'run_start')!;
    expect(runStart['toDistill']).toBe(1);
    expect(runStart['distillModel']).toBeDefined();

    // The cluster label is the source capture's task summary (what the operator recognises).
    const clusterStart = evs.find((e) => e['event'] === 'cluster_start')!;
    expect(clusterStart['label']).toBe(ownCapture().task.summary);

    const clusterEnd = evs.find((e) => e['event'] === 'cluster_end')!;
    expect(clusterEnd['outcome']).toBe('published');
    expect(typeof clusterEnd['skillName']).toBe('string');

    const runEnd = evs.at(-1)!;
    expect(runEnd['outcome']).toBe('ok');
    expect(runEnd['published']).toEqual(result.distilled.published.map((p: { pkg: { name: string } }) => p.pkg.name));
    expect(runEnd['installed']).toEqual([]);
  });

  it('emits run_end outcome=empty when there is nothing to distill', async () => {
    const { writer } = capture();
    const { stream, events } = progressSink();
    const emptyDir = mkdtempSync(join(tmpdir(), 'jinn-captures-empty-'));
    const code = await runJinnLayerCli(
      ['distill', '--captures', emptyDir, '--progress', 'ndjson', '--json'],
      { writer, distillDeps: stubDistillDeps({ progressStream: stream }) },
    );
    expect(code).toBe(0);
    const evs = events();
    expect(evs.at(-1)?.['event']).toBe('run_end');
    expect(evs.at(-1)?.['outcome']).toBe('empty');
  });

  it('emits cluster_end outcome=error and run_end outcome=partial on a failed run (exit 1)', async () => {
    const { writer } = capture();
    const { stream, events } = progressSink();
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-')), '--progress', 'ndjson', '--json'],
      {
        writer,
        distillDeps: {
          distill: async () => { throw new Error('the distiller stopped responding'); },
          progressStream: stream,
        },
      },
    );
    expect(code).toBe(1);
    const evs = events();
    const clusterEnd = evs.find((e) => e['event'] === 'cluster_end')!;
    expect(clusterEnd['outcome']).toBe('error');
    expect(clusterEnd['error']).toMatch(/stopped responding/);
    const runEnd = evs.at(-1)!;
    expect(runEnd['event']).toBe('run_end');
    expect(runEnd['outcome']).toBe('partial');
    expect(runEnd['errorCount']).toBe(1);
  });

  it('writes nothing to the progress stream without --progress', async () => {
    const { writer } = capture();
    const { stream, events } = progressSink();
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-')), '--install', 'none', '--json'],
      { writer, distillDeps: stubDistillDeps({ progressStream: stream }) },
    );
    expect(code).toBe(0);
    expect(events()).toHaveLength(0);
  });

  it('rejects an unknown --progress format with exit 2', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDirWith(ownCapture()), '--progress', 'xml'],
      { writer, distillDeps: stubDistillDeps() },
    );
    expect(code).toBe(2);
    expect(out()).toMatch(/--progress/);
  });
});

describe('jinn-layer distill --cluster-timeout (#1534)', () => {
  beforeEach(() => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    process.env['JINN_LAYER_DISTILL_MODE_PATH'] = modePath;
  });
  afterEach(() => {
    delete process.env['JINN_LAYER_DISTILL_MODE_PATH'];
  });

  function captureFactory(): {
    factory: (provider: DistillProvider, model: string, timeoutMs?: number) => DistillPorts;
    calls: Array<{ provider: string; model: string; timeoutMs?: number }>;
  } {
    const calls: Array<{ provider: string; model: string; timeoutMs?: number }> = [];
    return {
      calls,
      factory: (provider, model, timeoutMs) => {
        calls.push({ provider, model, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
        return { distill: async () => VALID_DISTILL, metaDistill: async () => ({ ...VALID_DISTILL, supports: ['s1'] }) };
      },
    };
  }

  it('passes --cluster-timeout (seconds) to the distiller factory as milliseconds', async () => {
    const { writer } = capture();
    const { factory, calls } = captureFactory();
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-')), '--install', 'none', '--cluster-timeout', '120', '--json'],
      { writer, distillDeps: { distillerFactory: factory } },
    );
    expect(code).toBe(0);
    expect(calls[0]?.timeoutMs).toBe(120_000);
  });

  it('falls back to JINN_DISTILL_CLUSTER_TIMEOUT_S when no flag is passed', async () => {
    const { writer } = capture();
    const { factory, calls } = captureFactory();
    await withEnv({ JINN_DISTILL_CLUSTER_TIMEOUT_S: '45' }, async () => {
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-')), '--install', 'none', '--json'],
        { writer, distillDeps: { distillerFactory: factory } },
      );
      expect(code).toBe(0);
    });
    expect(calls[0]?.timeoutMs).toBe(45_000);
  });

  it('leaves the factory default when neither flag nor env is set', async () => {
    const { writer } = capture();
    const { factory, calls } = captureFactory();
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-')), '--install', 'none', '--json'],
      { writer, distillDeps: { distillerFactory: factory } },
    );
    expect(code).toBe(0);
    expect(calls[0]?.timeoutMs).toBeUndefined();
  });

  it('rejects a non-positive or non-numeric --cluster-timeout with exit 2', async () => {
    for (const bad of ['0', '-5', 'soon']) {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--captures', capturesDirWith(ownCapture()), '--cluster-timeout', bad],
        { writer, distillDeps: stubDistillDeps() },
      );
      expect(code).toBe(2);
      expect(out()).toMatch(/--cluster-timeout/);
    }
  });
});

describe('ledger', () => {
  function fixtureFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-ledger-'));
    const file = join(dir, 'ledger.jsonl');
    const published: LedgerEntry = {
      ts: '2026-07-11T08:00:00.000Z',
      taskSummary: 'fix duplicate rows after a join in the report query',
      envelopeRef: 'bafyEnvelopePublished',
      anchorTx: '0xabc123',
      verifiabilityTier: 'evaluator-verified',
      status: 'published',
    };
    const vetoed: LedgerEntry = {
      ts: '2026-07-11T09:00:00.000Z',
      taskSummary: 'rename a private helper',
      envelopeRef: null,
      anchorTx: null,
      verifiabilityTier: 'user-accepted',
      status: 'vetoed (local only)',
    };
    writeFileSync(file, `${JSON.stringify(published)}\n${JSON.stringify(vetoed)}\n`, 'utf-8');
    return file;
  }

  it('--json emits the fork row shape, not raw entries', async () => {
    const file = fixtureFile();
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['ledger', '--path', file, '--json'], { writer });
    expect(code).toBe(0);
    const rows = JSON.parse(out());
    expect(rows).toHaveLength(2);

    const [row0, row1] = rows;
    expect(Object.keys(row0).sort()).toEqual(['anchor', 'env', 'task', 'tier', 'time']);
    expect(row0.tier).toBe('evaluator-verified');
    expect('state' in row0).toBe(false);

    expect(row1.state).toBe('vetoed');
    expect(row1.env).toBeNull();
    expect(row1.anchor).toBeNull();
  });

  it('human-readable output (no --json) is unchanged', async () => {
    const file = fixtureFile();
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['ledger', '--path', file], { writer });
    expect(code).toBe(0);
    const text = out();
    expect(text).toContain('contribution(s)');
    expect(text).toContain('published');
    expect(text).toContain('vetoed (local only)');
    expect(text).toContain('task');
    expect(text).toContain('tier');
    expect(text).toContain('ref');
    expect(text).toContain('anchor');
  });
});

describe('jinn-layer distill run log + status/runs subverbs (#1535)', () => {
  let runsPath: string;

  beforeEach(() => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    process.env['JINN_LAYER_DISTILL_MODE_PATH'] = modePath;
    runsPath = join(mkdtempSync(join(tmpdir(), 'jinn-runs-')), 'distill-runs.jsonl');
    process.env['JINN_LAYER_DISTILL_RUNS_PATH'] = runsPath;
  });

  afterEach(() => {
    delete process.env['JINN_LAYER_DISTILL_MODE_PATH'];
    delete process.env['JINN_LAYER_DISTILL_RUNS_PATH'];
  });

  it('records successful, partial, and empty runs', async () => {
    const { writer, out } = capture();
    await runJinnLayerCli(
      ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-')), '--install', 'all', '--json'],
      { writer, distillDeps: stubDistillDeps() },
    );
    const successful = JSON.parse(out());
    await runJinnLayerCli(
      ['distill', '--captures', capturesDirWith(ownCapture()), '--out', mkdtempSync(join(tmpdir(), 'jinn-distill-out-')), '--json'],
      { writer, distillDeps: { distill: async () => { throw new Error('boom'); } } },
    );
    await runJinnLayerCli(['distill', '--captures', mkdtempSync(join(tmpdir(), 'jinn-captures-empty-')), '--json'], { writer, distillDeps: stubDistillDeps() });
    const runs = readFileSync(runsPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(runs.map((run) => run.outcome)).toEqual(['ok', 'partial', 'empty']);
    expect(runs[0].published).toEqual(successful.distilled.published.map((p: { pkg: { name: string } }) => p.pkg.name));
  });

  it('lists runs and reports pure-read status', async () => {
    const { writer, out } = capture();
    const modePath = join(mkdtempSync(join(tmpdir(), 'jinn-virgin-')), 'distill.json');
    const emptyCaptures = mkdtempSync(join(tmpdir(), 'jinn-captures-empty-'));
    const outDir = join(mkdtempSync(join(tmpdir(), 'jinn-out-parent-')), 'skills');
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      expect(await runJinnLayerCli(['distill', 'status', '--captures', emptyCaptures, '--out', outDir, '--json'], { writer, distillDeps: stubDistillDeps() })).toBe(0);
    });
    const status = JSON.parse(out());
    expect(status).toMatchObject({ mode: 'unset', capturesCount: 0, uncoveredCount: 0, stagedCount: 0, installedCount: 0, lastRun: null });
    expect(existsSync(modePath)).toBe(false);
    const runsOutput = capture();
    expect(await runJinnLayerCli(['distill', 'runs', '--limit', '1', '--json'], { writer: runsOutput.writer, distillDeps: stubDistillDeps() })).toBe(0);
    expect(JSON.parse(runsOutput.out())).toEqual([]);
  });
});

describe('jinn-layer distill staged/install — install from staging (#1536)', () => {
  beforeEach(() => {
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    process.env['JINN_LAYER_DISTILL_MODE_PATH'] = modePath;
  });
  afterEach(() => {
    delete process.env['JINN_LAYER_DISTILL_MODE_PATH'];
  });

  /** A distill port that fails loudly if the subverbs ever invoke the LLM. */
  const forbiddenDistill = async (): Promise<DistillLLMOutput> => {
    throw new Error('distill install/staged must never invoke the distiller');
  };

  async function stageOne(outDir: string, name = 'orm-fanout-dedup'): Promise<string> {
    const capturesDir = capturesDirWith(ownCapture());
    const w = capture();
    const code = await runJinnLayerCli(
      ['distill', '--captures', capturesDir, '--out', outDir, '--install', 'none', '--json'],
      { writer: w.writer, distillDeps: stubDistillDeps({ distill: async () => ({ ...VALID_DISTILL, name }) }) },
    );
    expect(code).toBe(0);
    return capturesDir;
  }

  it('distill staged --json lists staged skills with name, description, and provenance', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    await stageOne(outDir);
    const { writer, out } = capture();
    const code = await runJinnLayerCli(
      ['distill', 'staged', '--out', outDir, '--json'],
      { writer, distillDeps: { distill: forbiddenDistill } },
    );
    expect(code).toBe(0);
    const staged = JSON.parse(out());
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe('orm-fanout-dedup');
    expect(typeof staged[0].description).toBe('string');
    expect(staged[0].provenance.some((r: string) => r.startsWith('local-capture:'))).toBe(true);
  });

  it('distill staged on an empty staging dir returns [] / a clear message', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    const { writer, out } = capture();
    const code = await runJinnLayerCli(
      ['distill', 'staged', '--out', outDir, '--json'],
      { writer, distillDeps: { distill: forbiddenDistill } },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out())).toEqual([]);
  });

  it('distill install --all installs every staged skill with zero LLM calls and empties staging', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    await stageOne(outDir);
    const { writer, out } = capture();
    const code = await runJinnLayerCli(
      ['distill', 'install', '--all', '--out', outDir, '--json'],
      { writer, distillDeps: { distill: forbiddenDistill } },
    );
    expect(code).toBe(0);
    const result = JSON.parse(out());
    expect(result.installed).toHaveLength(1);
    expect(result.installed[0].name).toBe('orm-fanout-dedup');
    // Installed into the active dir, staged copy removed.
    const md = readFileSync(join(outDir, 'orm-fanout-dedup', 'SKILL.md'), 'utf-8');
    expect(parseSkillMarkdown(md).name).toBe('orm-fanout-dedup');
    expect(existsSync(join(outDir + '-staged', 'orm-fanout-dedup'))).toBe(false);
  });

  it('distill install <name> installs just that skill from a previous run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    await stageOne(outDir, 'skill-one');
    const { writer } = capture();
    const code = await runJinnLayerCli(
      ['distill', 'install', 'skill-one', '--out', outDir, '--json'],
      { writer, distillDeps: { distill: forbiddenDistill } },
    );
    expect(code).toBe(0);
    expect(existsSync(join(outDir, 'skill-one', 'SKILL.md'))).toBe(true);
  });

  it('does not read the mode file — install works on a virgin mode (no consent gate)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    await stageOne(outDir);
    const virginMode = join(mkdtempSync(join(tmpdir(), 'jinn-virgin-')), 'distill.json');
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: virginMode }, async () => {
      const { writer } = capture();
      const code = await runJinnLayerCli(
        ['distill', 'install', '--all', '--out', outDir, '--json'],
        { writer, distillDeps: { distill: forbiddenDistill } },
      );
      expect(code).toBe(0);
    });
    expect(existsSync(virginMode)).toBe(false);
  });

  it('an unknown name exits 2 and lists what is staged', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    await stageOne(outDir, 'real-skill');
    const { writer, out } = capture();
    const code = await runJinnLayerCli(
      ['distill', 'install', 'nope', '--out', outDir, '--json'],
      { writer, distillDeps: { distill: forbiddenDistill } },
    );
    expect(code).toBe(2);
    expect(out()).toContain('real-skill');
  });

  it('install with neither names nor --all exits 2', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jinn-distill-out-'));
    const { writer, out } = capture();
    const code = await runJinnLayerCli(
      ['distill', 'install', '--out', outDir],
      { writer, distillDeps: { distill: forbiddenDistill } },
    );
    expect(code).toBe(2);
    expect(out()).toMatch(/--all|<name>/);
  });
});

describe('jinn-layer distill — persistent distiller setter (#1496)', () => {
  it('--set-distiller persists the provider and runs nothing', async () => {
    const modePath = tmpModeFile();
    const seen: string[] = [];
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--set-distiller', 'codex', '--captures', capturesDirWith(ownCapture())],
        { writer, distillDeps: { distill: async (c: DistillCluster) => { seen.push(...c.instanceIds); return VALID_DISTILL; } } },
      );
      expect(code).toBe(0);
      expect(seen).toEqual([]); // setter only — never ran
      expect(readDistillDefaults(modePath)).toEqual({ distiller: 'codex' });
      expect(out()).toMatch(/codex/);
    });
  });

  it('--set-distiller-model persists the model and runs nothing', async () => {
    const modePath = tmpModeFile();
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(['distill', '--set-distiller-model', 'claude-opus-4-9'], { writer, distillDeps: stubDistillDeps() });
      expect(code).toBe(0);
      expect(readDistillDefaults(modePath)).toEqual({ distillerModel: 'claude-opus-4-9' });
      expect(out()).toContain('claude-opus-4-9');
    });
  });

  it('accepts both flags in one call and writes both', async () => {
    const modePath = tmpModeFile();
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer } = capture();
      const code = await runJinnLayerCli(
        ['distill', '--set-distiller', 'codex', '--set-distiller-model', 'gpt-5.5'],
        { writer, distillDeps: stubDistillDeps() },
      );
      expect(code).toBe(0);
      expect(readDistillDefaults(modePath)).toEqual({ distiller: 'codex', distillerModel: 'gpt-5.5' });
    });
  });

  it('rejects an unknown --set-distiller provider with exit 2 and writes nothing', async () => {
    const modePath = tmpModeFile();
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const code = await runJinnLayerCli(['distill', '--set-distiller', 'gpt'], { writer, distillDeps: stubDistillDeps() });
      expect(code).toBe(2);
      expect(out()).toContain('distiller must be "claude" or "codex"');
      expect(readDistillDefaults(modePath)).toEqual({});
    });
  });

  it('rejects an empty --set-distiller-model with exit 2 and writes nothing', async () => {
    const modePath = tmpModeFile();
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer } = capture();
      const code = await runJinnLayerCli(['distill', '--set-distiller-model', ''], { writer, distillDeps: stubDistillDeps() });
      expect(code).toBe(2);
      expect(readDistillDefaults(modePath)).toEqual({});
    });
  });

  it('--set-distiller --json emits the persisted patch', async () => {
    const modePath = tmpModeFile();
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      await runJinnLayerCli(['distill', '--set-distiller', 'codex', '--json'], { writer, distillDeps: stubDistillDeps() });
      expect(JSON.parse(out())).toEqual({ distiller: 'codex' });
    });
  });
});

describe('jinn-layer distill models — discovery (#1496)', () => {
  it('lists every catalog model with execution/cost/privacy attributes', async () => {
    const { writer, out } = capture();
    const code = await runJinnLayerCli(['distill', 'models'], { writer, distillDeps: stubDistillDeps() });
    expect(code).toBe(0);
    for (const e of DISTILLER_CATALOG) {
      expect(out()).toContain(e.model);
      expect(out()).toContain(e.execution);
    }
    expect(out()).toMatch(/frontier pass/); // cost
    expect(out()).toMatch(/local/); // privacy/execution
  });

  it('marks the resolved default (persisted default wins the marker)', async () => {
    const modePath = tmpModeFile();
    writeDistillDefaults({ distiller: 'codex', distillerModel: 'gpt-5.5' }, modePath);
    await withEnv(
      { JINN_LAYER_DISTILL_MODE_PATH: modePath, JINN_DISTILL_PROVIDER: undefined, JINN_DISTILL_MODEL: undefined },
      async () => {
        const { writer, out } = capture();
        await runJinnLayerCli(['distill', 'models'], { writer, distillDeps: stubDistillDeps() });
        const gptLine = out().split('\n').find((l) => l.includes('gpt-5.5'));
        expect(gptLine).toMatch(/default/i);
      },
    );
  });

  it('--json emits the catalog array and the resolved selection', async () => {
    const modePath = tmpModeFile();
    await withEnv(
      { JINN_LAYER_DISTILL_MODE_PATH: modePath, JINN_DISTILL_PROVIDER: undefined, JINN_DISTILL_MODEL: undefined },
      async () => {
        const { writer, out } = capture();
        const code = await runJinnLayerCli(['distill', 'models', '--json'], { writer, distillDeps: stubDistillDeps() });
        expect(code).toBe(0);
        const parsed = JSON.parse(out());
        expect(parsed.catalog).toHaveLength(DISTILLER_CATALOG.length);
        expect(parsed.resolved).toEqual({ provider: 'claude', model: 'claude-opus-4-8' });
      },
    );
  });

  it('a bare distill is NOT treated as models (run path intact)', async () => {
    // Regression guard: bare distil with an empty captures dir still runs the
    // normal path (No eligible captures), not the models catalog.
    const modePath = tmpModeFile();
    writeDistillMode('local', modePath);
    await withEnv({ JINN_LAYER_DISTILL_MODE_PATH: modePath }, async () => {
      const { writer, out } = capture();
      const emptyDir = mkdtempSync(join(tmpdir(), 'jinn-captures-empty-'));
      const code = await runJinnLayerCli(['distill', '--captures', emptyDir], { writer, distillDeps: stubDistillDeps() });
      expect(code).toBe(0);
      expect(out()).toContain('No eligible captures');
      expect(out()).not.toMatch(/frontier pass/);
    });
  });
});
