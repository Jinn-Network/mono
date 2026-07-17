import { describe, it, expect, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { withTempStore } from '../_support/store.js';
import {
  makeTarGz,
  sha256Hex,
  wrapDonation,
} from '../../packages/harness-layer/test/tar-fixture.js';
import { backfillDerivedTrajectories } from '../../scripts/lib/backfill-derived-trajectories.js';
import { buildLayer2ScrubPipeline } from '../../src/trajectory/scrub/layer2.js';
import { uploadToIpfs } from '../../src/adapters/mech/ipfs.js';
import { keccak256, toBytes } from 'viem';
import { canonicalJson } from '../../src/harnesses/engine/canonical-json.js';

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async (_url: string, data: unknown) => {
    const h = keccak256(toBytes(canonicalJson(data)));
    return `bafy-stub-${h.slice(2, 10)}`;
  }),
}));

// A minimal claude-code stream-json transcript with two turns and one tool call.
const CLAUDE_STREAM_JSON = [
  '{"type":"system","subtype":"init","cwd":"/workspace"}',
  '{"type":"user","message":{"role":"user","content":"Fix the failing test"}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading the file."},{"type":"tool_use","id":"c1","name":"Read","input":{"path":"pkg.py"}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"def load(): pass"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fixed it."}]}}',
  '{"type":"result","subtype":"success","usage":{"input_tokens":10,"output_tokens":5}}',
].join('\n');

// A codex exec-json transcript (matches the shipped fixture shape).
const CODEX_EXEC_JSON = [
  '{"timestamp":"2026-07-14T09:00:00.000Z","type":"session_meta","payload":{"id":"s","cwd":"/w","source":"exec"}}',
  '{"timestamp":"2026-07-14T09:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix it"}]}}',
  '{"timestamp":"2026-07-14T09:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","namespace":"","arguments":"{\\"command\\":[\\"ls\\"]}","call_id":"call_1"}}',
  '{"timestamp":"2026-07-14T09:00:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"ok"}}',
  '{"timestamp":"2026-07-14T09:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}}',
  '{"timestamp":"2026-07-14T09:00:05.000Z","type":"turn.completed","usage":{"input_tokens":42,"output_tokens":3}}',
].join('\n');

function seedLocalSnapshot(
  store: import('@/store/store.js').Store,
  files: Record<string, string>,
  opts: { envelopeCid?: string | null; requestId?: string; createdAt?: string } = {},
): string {
  const bytes = makeTarGz(files);
  const sha256 = sha256Hex(bytes);
  store.saveServedArtifact({
    sha256,
    artifactType: 'system_snapshot',
    requestId: opts.requestId ?? 'req-1',
    envelopeCid: opts.envelopeCid ?? null,
    content: bytes,
    priceUsdc: '0',
    createdAt: opts.createdAt ?? '2026-07-15T00:00:00.000Z',
  });
  return sha256;
}

describe('backfillDerivedTrajectories', () => {
  // Step 4 — local claude-code snapshot → derived record with provenance (AC1, AC2).
  it('derives a claude-code trajectory from a local snapshot with derivedFrom provenance', async () => {
    await withTempStore(async (store) => {
      const sha = seedLocalSnapshot(
        store,
        { '.claude-code/stdout.jsonl': CLAUDE_STREAM_JSON, 'task.json': '{}' },
        { envelopeCid: 'bafy-src' },
      );
      const before = store.getServedArtifact(sha)!.content;

      const summary = await backfillDerivedTrajectories({ store });

      expect(summary).toMatchObject({
        found: 1,
        fetched: 1,
        parsed: 1,
        skippedNoTranscript: 0,
        skippedUnavailable: 0,
        alreadyDone: 0,
      });

      const rec = store.getDerivedTrajectory(sha);
      expect(rec).not.toBeNull();
      expect(rec!.outcome).toBe('parsed');
      expect(rec!.harness).toBe('claude-code');
      expect(rec!.parserName).toBe('claude-code-stream-json');
      expect(rec!.parserVersion).toBe('1.0.0');

      const blob = JSON.parse(rec!.trajectoryJson!) as {
        schemaVersion: string;
        derivedFrom: string;
        spans: Array<{ attributes: Record<string, unknown> }>;
      };
      expect(blob.schemaVersion).toBe('jinn.trajectory.v1');
      expect(blob.derivedFrom).toBe('bafy-src');
      expect(blob.spans.length).toBeGreaterThan(0);
      for (const span of blob.spans) {
        expect(span.attributes['jinn.transcript.derivedFrom']).toBe('bafy-src');
        expect(span.attributes['jinn.transcript.backfillJob']).toBe(
          'backfill-derived-trajectories@1.0.0',
        );
      }
      const kinds = new Set(blob.spans.map((s) => s.attributes['jinn.span.kind']));
      expect(kinds.has('jinn.agent_turn') || kinds.has('jinn.tool_call')).toBe(true);
      const withParser = blob.spans.find(
        (s) => s.attributes['jinn.transcript.parser'] === 'claude-code-stream-json',
      );
      expect(withParser).toBeDefined();

      // AC2 — the source served_artifacts row is byte-identical after the run.
      expect(store.getServedArtifact(sha)!.content.equals(before)).toBe(true);
    });
  });

  // Step 5 — codex branch (AC1).
  it('derives a codex trajectory and stamps codex parser provenance', async () => {
    await withTempStore(async (store) => {
      const sha = seedLocalSnapshot(store, { '.codex-code/stdout.jsonl': CODEX_EXEC_JSON });
      const summary = await backfillDerivedTrajectories({ store });
      expect(summary.parsed).toBe(1);
      const rec = store.getDerivedTrajectory(sha)!;
      expect(rec.harness).toBe('codex');
      expect(rec.parserName).toBe('codex-exec-json');
      expect(JSON.parse(rec.trajectoryJson!).spans.length).toBeGreaterThan(0);
    });
  });

  // Step 6 — hermes / no-transcript ⇒ skipped-no-transcript (AC3).
  it('counts hermes-only and transcript-less snapshots as skipped-no-transcript', async () => {
    await withTempStore(async (store) => {
      const shaHermes = seedLocalSnapshot(
        store,
        { '.hermes-agent/stdout.log': 'plain log', 'task.json': '{}' },
        { requestId: 'req-h', createdAt: '2026-07-15T00:00:01.000Z' },
      );
      const shaNone = seedLocalSnapshot(store, { 'task.json': '{}' }, {
        requestId: 'req-n',
        createdAt: '2026-07-15T00:00:02.000Z',
      });
      const summary = await backfillDerivedTrajectories({ store });
      expect(summary.parsed).toBe(0);
      expect(summary.skippedNoTranscript).toBe(2);
      expect(store.getDerivedTrajectory(shaHermes)!.outcome).toBe('no_transcript');
      expect(store.getDerivedTrajectory(shaHermes)!.trajectoryJson).toBeNull();
      expect(store.getDerivedTrajectory(shaNone)!.outcome).toBe('no_transcript');
    });
  });

  // Step 7 — idempotency on re-run (AC1, AC3).
  it('short-circuits already-done sources on re-run without rewriting them', async () => {
    await withTempStore(async (store) => {
      seedLocalSnapshot(
        store,
        { '.claude-code/stdout.jsonl': CLAUDE_STREAM_JSON },
        { requestId: 'req-a', createdAt: '2026-07-15T00:00:01.000Z' },
      );
      const shaSkip = seedLocalSnapshot(store, { 'task.json': '{}' }, {
        requestId: 'req-b',
        createdAt: '2026-07-15T00:00:02.000Z',
      });

      const first = await backfillDerivedTrajectories({ store });
      expect(first).toMatchObject({ parsed: 1, skippedNoTranscript: 1, alreadyDone: 0 });
      const createdAtAfterFirst = store.getDerivedTrajectory(shaSkip)!.createdAt;

      const second = await backfillDerivedTrajectories({
        store,
        now: () => '2099-01-01T00:00:00.000Z',
      });
      expect(second).toMatchObject({ alreadyDone: 2, parsed: 0, found: 0 });
      // The already-done record was not rewritten.
      expect(store.getDerivedTrajectory(shaSkip)!.createdAt).toBe(createdAtAfterFirst);
    });
  });

  // Step 8 — recovery-rate summary shape (AC3).
  it('reports every recovery-rate bucket for a mixed batch', async () => {
    await withTempStore(async (store) => {
      seedLocalSnapshot(store, { '.claude-code/stdout.jsonl': CLAUDE_STREAM_JSON }, {
        requestId: 'r1',
        createdAt: '2026-07-15T00:00:01.000Z',
      });
      seedLocalSnapshot(store, { '.codex-code/stdout.jsonl': CODEX_EXEC_JSON }, {
        requestId: 'r2',
        createdAt: '2026-07-15T00:00:02.000Z',
      });
      seedLocalSnapshot(store, { '.hermes-agent/stdout.log': 'x' }, {
        requestId: 'r3',
        createdAt: '2026-07-15T00:00:03.000Z',
      });
      seedLocalSnapshot(store, { '.claude-code/stdout.jsonl': '' }, {
        requestId: 'r4',
        createdAt: '2026-07-15T00:00:04.000Z',
      });

      const s = await backfillDerivedTrajectories({ store });
      for (const k of [
        'found',
        'fetched',
        'parsed',
        'skippedUnavailable',
        'skippedNoTranscript',
        'alreadyDone',
        'published',
      ] as const) {
        expect(typeof s[k]).toBe('number');
      }
      expect(s.found).toBe(4);
      expect(s.fetched).toBe(4);
      expect(s.parsed).toBe(2);
      expect(s.skippedNoTranscript).toBe(2); // hermes-only + empty-transcript
      expect(s.skippedUnavailable).toBe(0);
    });
  });

  // M1 — `--limit` caps how many source snapshots the run considers.
  it('caps the number of source snapshots processed at `limit`', async () => {
    await withTempStore(async (store) => {
      const shas: string[] = [];
      for (let i = 0; i < 5; i++) {
        const idx = String(i).padStart(2, '0');
        // Distinct content per snapshot ⇒ distinct sha256 (the served_artifacts PK).
        const transcript = `{"type":"system","subtype":"init","cwd":"/w-${idx}"}\n${CLAUDE_STREAM_JSON}`;
        shas.push(
          seedLocalSnapshot(
            store,
            { '.claude-code/stdout.jsonl': transcript },
            { requestId: `req-${idx}`, createdAt: `2026-07-15T00:00:${idx}.000Z` },
          ),
        );
      }

      const summary = await backfillDerivedTrajectories({ store, limit: 2 });

      expect(summary.found).toBe(2);
      expect(summary.parsed).toBe(2);
      // Exactly two derived rows written; the other three are untouched.
      const derived = shas.filter((sha) => store.hasDerivedTrajectory(sha));
      expect(derived.length).toBe(2);
      // The newest two (DESC walk) are the ones processed.
      expect(store.hasDerivedTrajectory(shas[4]!)).toBe(true);
      expect(store.hasDerivedTrajectory(shas[3]!)).toBe(true);
      expect(store.hasDerivedTrajectory(shas[2]!)).toBe(false);
      expect(store.hasDerivedTrajectory(shas[1]!)).toBe(false);
      expect(store.hasDerivedTrajectory(shas[0]!)).toBe(false);
    });
  });

  // Step 9 — optional indexer/IPFS second pass (AC1).
  it('derives from the indexer/IPFS pass when a snapshot is not held locally', async () => {
    await withTempStore(async (store) => {
      const bytes = makeTarGz({ '.claude-code/stdout.jsonl': CLAUDE_STREAM_JSON });
      const { wrapper, sha256 } = wrapDonation(bytes);

      const summary = await backfillDerivedTrajectories({
        store,
        listEnvelopeSnapshots: async () => [
          { envelopeCid: 'bafy-env', snapshotCid: 'bafy-snap', sha256 },
        ],
        ipfs: async () => wrapper,
      });

      expect(summary.parsed).toBe(1);
      const rec = store.getDerivedTrajectory(sha256)!;
      expect(rec.sourceEnvelopeCid).toBe('bafy-env');
      expect(JSON.parse(rec.trajectoryJson!).derivedFrom).toBe('bafy-env');
    });
  });

  it('records an unavailable outcome when the IPFS fetch throws (no throw out)', async () => {
    await withTempStore(async (store) => {
      const summary = await backfillDerivedTrajectories({
        store,
        listEnvelopeSnapshots: async () => [
          { envelopeCid: 'bafy-env', snapshotCid: 'bafy-missing', sha256: 'sha-missing' },
        ],
        ipfs: async () => {
          throw new Error('unresolvable CID');
        },
      });
      expect(summary.skippedUnavailable).toBe(1);
      expect(summary.parsed).toBe(0);
      expect(store.getDerivedTrajectory('sha-missing')!.outcome).toBe('unavailable');
    });
  });

  // Step 10 — publish edge runs layer-2 scrub; local path never publishes (AC4).
  it('scrubs at layer-2 before publishing and never publishes on the local-only path', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const withSecret = [
      '{"type":"user","message":{"role":"user","content":"start"}}',
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"the key is ${secret} ok"}]}}`,
    ].join('\n');

    // Control: local-only run performs NO uploadToIpfs.
    await withTempStore(async (store) => {
      seedLocalSnapshot(store, { '.claude-code/stdout.jsonl': withSecret });
      vi.mocked(uploadToIpfs).mockClear();
      await backfillDerivedTrajectories({ store });
      expect(vi.mocked(uploadToIpfs)).not.toHaveBeenCalled();
    });

    // Publish edge: scrub runs, secret is gone from the published blob.
    await withTempStore(async (store) => {
      const sha = seedLocalSnapshot(
        store,
        { '.claude-code/stdout.jsonl': withSecret },
        { envelopeCid: 'bafy-src' },
      );
      vi.mocked(uploadToIpfs).mockClear();
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);

      const summary = await backfillDerivedTrajectories({
        store,
        publish: {
          signerPrivateKey: pk,
          signerAddress: account.address,
          ipfsRegistryUrl: 'http://stub',
          scrubPipeline: buildLayer2ScrubPipeline(),
        },
      });

      expect(summary.published).toBe(1);
      expect(vi.mocked(uploadToIpfs)).toHaveBeenCalledTimes(1);
      const publishedBlob = vi.mocked(uploadToIpfs).mock.calls[0]![1];
      const serialized = JSON.stringify(publishedBlob);
      expect(serialized).not.toContain(secret);
      expect((publishedBlob as { redactionManifest: { totalRedactions: number } }).redactionManifest.totalRedactions).toBeGreaterThan(0);
      expect(store.getDerivedTrajectory(sha)!.publishedCid).toMatch(/^bafy-stub-/);
    });
  });
});
