/**
 * File-backed seed-import state tests (issue #1771, PR #1779 review).
 *
 * `createFileSeedImportState` is the production default behind
 * `seed execute` (cli.ts). Covered here: round-trip persistence across
 * store instances, fail-closed corrupt-file behavior, atomic replace
 * persistence, and the CLI guarantee that corrupt lineage blocks before any
 * publication call.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

  it('a missing file is an empty state', () => {
    const store = createFileSeedImportState(tmpStatePath());
    expect(store.get('episode:x')).toBeUndefined();
  });

  it('a corrupt file fails closed instead of becoming empty state', () => {
    const path = tmpStatePath();
    writeFileSync(path, '{ definitely not json', 'utf-8');
    const store = createFileSeedImportState(path);

    expect(() => store.get('episode:x')).toThrow(/state.*unreadable/i);
    expect(readFileSync(path, 'utf-8')).toBe('{ definitely not json');
  });

  it('a schema-invalid (but valid JSON) file also fails closed', () => {
    const path = tmpStatePath();
    writeFileSync(path, JSON.stringify({ 'episode:x': { nope: true } }), 'utf-8');
    const store = createFileSeedImportState(path);

    expect(() => store.get('episode:x')).toThrow(/state.*unreadable/i);
  });

  it('set() refuses to overwrite corrupt lineage', () => {
    const path = tmpStatePath();
    writeFileSync(path, '{ corrupt', 'utf-8');
    const store = createFileSeedImportState(path);

    expect(() => store.set('episode:x', RECORD)).toThrow(/state.*unreadable/i);
    expect(readFileSync(path, 'utf-8')).toBe('{ corrupt');
  });

  it('persists by replacing the state file atomically', () => {
    const path = tmpStatePath();
    const store = createFileSeedImportState(path);
    store.set('episode:x', RECORD);
    const beforeInode = statSync(path).ino;

    store.set('episode:y', { ...RECORD, envelopeRef: 'bafy-envelope-2' });

    expect(statSync(path).ino).not.toBe(beforeInode);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      'episode:x': RECORD,
      'episode:y': { ...RECORD, envelopeRef: 'bafy-envelope-2' },
    });
  });
});

// ── CLI fail-closed behavior ──────────────────────────────────────────────

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

function mockPublishDeps(): { deps: HarnessPublishDeps; publishCalls: () => number } {
  let n = 0;
  const deps: HarnessPublishDeps = {
    participant: { safeAddress: TEST_SAFE, agentEoa: TEST_ADDRESS },
    signer: { address: TEST_ADDRESS, privateKey: TEST_PRIVATE_KEY },
    clientGitSha: 'test-sha',
    defaultArtifactEndpoint: 'http://127.0.0.1:7331',
    ledger: createMemoryLedger(),
    publishArtifact: async () => ({ cid: `bafy-artifact-${++n}`, sha256: 'a'.repeat(64) }),
    publishEnvelope: async () => ({ cid: `bafy-envelope-${++n}`, sha256: 'b'.repeat(64) }),
    anchorEnvelope: async () => ({ txHash: `0x${'cd'.repeat(32)}` as `0x${string}`, blockNumber: 7 }),
  };
  return { deps, publishCalls: () => n };
}

describe('seed execute — corrupt state fails closed', () => {
  async function runExecuteWithCorruptState(json: boolean): Promise<{ code: number; out: string; publishCalls: number }> {
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
      const publish = mockPublishDeps();
      const code = await runJinnLayerCli(
        ['seed', 'execute', reportFile, ...(json ? ['--json'] : [])],
        { writer, episodeSource: source, publishDeps: publish.deps },
      );
      return { code, out, publishCalls: publish.publishCalls() };
    } finally {
      if (prev === undefined) delete process.env['JINN_LAYER_SEED_STATE_PATH'];
      else process.env['JINN_LAYER_SEED_STATE_PATH'] = prev;
    }
  }

  it('--json exits nonzero and publishes nothing', async () => {
    const { code, out, publishCalls } = await runExecuteWithCorruptState(true);
    expect(code).toBe(1);
    const payload = JSON.parse(out.trim()) as { imported: unknown[]; errors: Array<{ error: string }> };
    expect(payload.imported).toHaveLength(0);
    expect(payload.errors[0]!.error).toMatch(/state.*unreadable/i);
    expect(publishCalls).toBe(0);
  });

  it('table output reports the state error without claiming an import', async () => {
    const { code, out, publishCalls } = await runExecuteWithCorruptState(false);
    expect(code).toBe(1);
    expect(out).toContain('ERROR');
    expect(out).toMatch(/state.*unreadable/i);
    expect(out).toContain('0 imported');
    expect(publishCalls).toBe(0);
  });
});
