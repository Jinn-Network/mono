/**
 * File-backed seed-import state tests (issue #1771, PR #1779 review).
 *
 * `createFileSeedImportState` is the production default behind
 * `seed execute` (cli.ts). Covered here: round-trip persistence across
 * store instances, the documented fail-open corrupt-file behavior (empty
 * state + a warning, at most once per store instance), `set()` self-heal,
 * and — at the CLI level — that the corruption warning is surfaced through
 * the command's own writer/output path (a `warnings` field in `--json`
 * mode, a WARNING line in table mode), not only `console.warn`.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryLedger } from '../src/ledger.js';
import type { HarnessPublishDeps } from '../src/publish.js';
import { createFileSeedImportState, type SeedPublicationRecord } from '../src/seed-import/state.js';
import { planEpisodes } from '../src/seed-import/episode-plan.js';
import type { SeedEpisode, EpisodeSource } from '../src/seed-import/episode-fetch.js';
import { runJinnLayerCli } from '../src/cli.js';

const RECORD: SeedPublicationRecord = {
  contentHash: 'a'.repeat(64),
  envelopeRef: 'bafy-envelope-1',
  publishedAt: '2026-07-16T00:00:00.000Z',
};

function tmpStatePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'jinn-seed-state-')), 'state.json');
}

describe('createFileSeedImportState', () => {
  it('round-trips a record across two store instances at the same path', () => {
    const path = tmpStatePath();
    const first = createFileSeedImportState(path);
    first.set('episode:x', RECORD);

    const second = createFileSeedImportState(path);
    expect(second.get('episode:x')).toEqual(RECORD);
    expect(second.get('episode:missing')).toBeUndefined();
  });

  it('a missing file is an empty state — no warning', () => {
    const warn = vi.fn();
    const store = createFileSeedImportState(tmpStatePath(), { onWarning: warn });
    expect(store.get('episode:x')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a corrupt file is fail-open: empty state plus exactly one warning per store instance', () => {
    const path = tmpStatePath();
    writeFileSync(path, '{ definitely not json', 'utf-8');
    const warn = vi.fn();
    const store = createFileSeedImportState(path, { onWarning: warn });

    expect(store.get('episode:x')).toBeUndefined();
    expect(store.get('episode:y')).toBeUndefined(); // second read: latched, no second warning
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('unreadable');
    expect(message).toContain(path);
  });

  it('a schema-invalid (but valid JSON) file is treated the same as corrupt', () => {
    const path = tmpStatePath();
    writeFileSync(path, JSON.stringify({ 'episode:x': { nope: true } }), 'utf-8');
    const warn = vi.fn();
    const store = createFileSeedImportState(path, { onWarning: warn });

    expect(store.get('episode:x')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('set() self-heals a corrupt file — the write wins and later reads succeed cleanly', () => {
    const path = tmpStatePath();
    writeFileSync(path, '{ corrupt', 'utf-8');
    const store = createFileSeedImportState(path, { onWarning: vi.fn() });
    store.set('episode:x', RECORD);

    // A fresh instance reads the healed file with no warning.
    const warn = vi.fn();
    const fresh = createFileSeedImportState(path, { onWarning: warn });
    expect(fresh.get('episode:x')).toEqual(RECORD);
    expect(warn).not.toHaveBeenCalled();
    // And the on-disk content is the canonical JSON map shape.
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ 'episode:x': RECORD });
  });

  it('the default warning sink is console.warn (non-CLI callers keep the old behavior)', () => {
    const path = tmpStatePath();
    writeFileSync(path, '{ corrupt', 'utf-8');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createFileSeedImportState(path).get('episode:x');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toContain('unreadable');
    } finally {
      spy.mockRestore();
    }
  });
});

// ── CLI surfacing (PR #1779 review): the warning reaches the command's own
// output, not only console.warn ────────────────────────────────────────────

const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const TEST_SAFE = '0x1111111111111111111111111111111111111111' as const;

function episodeFixture(): SeedEpisode {
  return {
    id: 'state-cli-fixture',
    repo: 'acme/widgets',
    taskSummary: 'Fix a flaky widget test by awaiting the async fetch before asserting',
    tags: ['acme', 'widgets'],
    steps: [
      { label: 'failure', title: 'run failing test', text: '$ yarn test\nFAIL widget.test.ts' },
      { label: 'fix', title: 'await the fetch', text: 'await waitFor(() => expect(fetchMock).toHaveBeenCalled());' },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    synthesis: 'The test asserted before the async fetch settled. Waiting on the fetch mock directly fixes the race. This is the general pattern for this class of flake.',
    attribution: { origin: 'operator-recorded-session' },
  };
}

function mockEpisodeSource(episodes: SeedEpisode[]): EpisodeSource {
  return { name: 'mock-episodes', list: async () => episodes };
}

function mockPublishDeps(): HarnessPublishDeps {
  let n = 0;
  return {
    participant: { safeAddress: TEST_SAFE, agentEoa: TEST_ADDRESS },
    signer: { address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY },
    clientGitSha: 'test-sha',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: createMemoryLedger(),
    publishArtifact: async () => ({ cid: `bafy-artifact-${++n}`, sha256: 'a'.repeat(64) }),
    publishEnvelope: async () => ({ cid: `bafy-envelope-${++n}`, sha256: 'b'.repeat(64) }),
    anchorEnvelope: async () => ({ txHash: `0x${'cd'.repeat(32)}` as `0x${string}`, blockNumber: 7 }),
  };
}

describe('seed execute — corrupt state warning on the CLI output', () => {
  async function runExecuteWithCorruptState(json: boolean): Promise<{ code: number; out: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-seed-state-cli-'));
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, '{ corrupt', 'utf-8');
    const source = mockEpisodeSource([episodeFixture()]);
    const reportFile = join(dir, 'report.json');
    writeFileSync(reportFile, JSON.stringify(await planEpisodes(source)));

    let out = '';
    const writer = { write: (s: string) => { out += s; return true; } };
    const prev = process.env['JINN_LAYER_SEED_STATE_PATH'];
    process.env['JINN_LAYER_SEED_STATE_PATH'] = statePath;
    try {
      // No seedImportState injection: the CLI builds its file-backed default
      // at the env-overridden path — the production wiring under test.
      const code = await runJinnLayerCli(
        ['seed', 'execute', reportFile, ...(json ? ['--json'] : [])],
        { writer, episodeSource: source, publishDeps: mockPublishDeps() },
      );
      return { code, out };
    } finally {
      if (prev === undefined) delete process.env['JINN_LAYER_SEED_STATE_PATH'];
      else process.env['JINN_LAYER_SEED_STATE_PATH'] = prev;
    }
  }

  it('--json output carries the warning as a warnings field (not only console.warn)', async () => {
    const { code, out } = await runExecuteWithCorruptState(true);
    expect(code).toBe(0);
    const payload = JSON.parse(out.trim()) as { imported: unknown[]; warnings?: string[] };
    expect(payload.imported).toHaveLength(1); // fail-open: the corrupt state never blocked the publish
    expect(payload.warnings).toHaveLength(1);
    expect(String(payload.warnings![0])).toContain('unreadable');
  });

  it('table output carries a WARNING line', async () => {
    const { code, out } = await runExecuteWithCorruptState(false);
    expect(code).toBe(0);
    expect(out).toContain('WARNING');
    expect(out).toContain('unreadable');
    expect(out).toContain('1 imported');
  });
});
