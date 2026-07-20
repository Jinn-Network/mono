import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EPISODE_SCHEMA_VERSION, type EpisodeV1 } from '@jinn-network/plugin';
import { EvidenceIndex } from '@jinn-network/core';
import { runJinnLayerCli } from '../src/cli.js';

const tempDirs: string[] = [];

function fixture(): { root: string; episodesDir: string; indexPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'jinn-reindex-cli-'));
  tempDirs.push(root);
  const episodesDir = join(root, 'episodes');
  mkdirSync(episodesDir);
  return { root, episodesDir, indexPath: join(root, 'index.sqlite') };
}

function episode(id: string): EpisodeV1 {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: id,
    retrievalVisible: false,
    session: {
      sessionId: `session-${id}`,
      capturedAt: '2026-07-20T00:00:00.000Z',
      kind: 'user',
    },
    origin: { writer: 'reindex-cli-test', build: '1.0.0' },
    task: { summary: 'Reindex fixture', distributionTags: [] },
    trajectory: [{
      spanId: 'span-1',
      parentSpanId: null,
      kind: 'jinn.agent_turn',
      name: 'turn',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: { role: 'user' },
      redactedKeys: [],
    }],
    environment: {
      harness: { name: 'hermes', version: '1' },
      model: 'test',
      tools: [],
      skillsLoadout: [],
    },
    outcome: { status: 'completed', verificationStrength: 'user-accepted' },
    cost: { durationMs: 1 },
    retention: { policy: 'local-private' },
    provenance: 'contributed',
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('jinn-layer reindex', () => {
  it('repairs a store and emits machine-readable before/after counts', async () => {
    const { episodesDir, indexPath } = fixture();
    const raw = structuredClone(episode('misnamed')) as unknown as {
      outcome: { summary: null };
      cost: { tokens: null; usdEstimate: null };
      lineage: null;
      origin?: unknown;
    };
    raw.outcome.summary = null;
    raw.cost.tokens = null;
    raw.cost.usdEstimate = null;
    raw.lineage = null;
    delete raw.origin;
    writeFileSync(join(episodesDir, 'misnamed.json'), JSON.stringify(raw));
    let output = '';

    const code = await runJinnLayerCli([
      'reindex',
      '--repair',
      '--json',
      '--episodes-dir',
      episodesDir,
      '--index-path',
      indexPath,
    ], { writer: { write: (value) => { output += value; return true; } } });

    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      status: 'ok',
      episodesDir,
      indexPath,
      repair: true,
      report: {
        scannedFiles: 1,
        indexedEpisodes: 1,
        unreadableFiles: 0,
        nullToleratedFiles: 1,
        nullFieldsRemoved: 4,
        misnamedEpisodes: 1,
        renamedFiles: 1,
        legacyUnstampedFiles: 1,
      },
    });
    expect(existsSync(join(episodesDir, 'misnamed.episode.json'))).toBe(true);
    const index = new EvidenceIndex({ dbPath: indexPath });
    expect(index.listEpisodes()).toHaveLength(1);
    index.close();
  });

  it('surfaces every unreadable path and exits non-zero', async () => {
    const { episodesDir, indexPath } = fixture();
    writeFileSync(join(episodesDir, 'broken.episode.json'), '{broken');
    let output = '';

    const code = await runJinnLayerCli([
      'reindex',
      '--json',
      '--episodes-dir',
      episodesDir,
      '--index-path',
      indexPath,
    ], { writer: { write: (value) => { output += value; return true; } } });

    expect(code).toBe(1);
    const result = JSON.parse(output);
    expect(result.status).toBe('degraded');
    expect(result.report.unreadableFiles).toBe(1);
    expect(result.report.unreadable[0]).toMatchObject({
      path: join(episodesDir, 'broken.episode.json'),
    });
  });

  it('supports a read-only doctor scan without creating the derived index', async () => {
    const { episodesDir, indexPath } = fixture();
    writeFileSync(join(episodesDir, 'valid.episode.json'), JSON.stringify(episode('valid')));
    let output = '';

    const code = await runJinnLayerCli([
      'reindex',
      '--dry-run',
      '--json',
      '--episodes-dir',
      episodesDir,
      '--index-path',
      indexPath,
    ], { writer: { write: (value) => { output += value; return true; } } });

    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      status: 'ok',
      mode: 'inspect',
      episodesDir,
      indexPath: null,
      report: { scannedFiles: 1, indexedEpisodes: 1, unreadableFiles: 0 },
    });
    expect(existsSync(indexPath)).toBe(false);
  });

  it('rejects unknown flags without touching the store', async () => {
    const { episodesDir, indexPath } = fixture();
    let output = '';

    const code = await runJinnLayerCli([
      'reindex',
      '--destroy-source',
      '--episodes-dir',
      episodesDir,
      '--index-path',
      indexPath,
    ], { writer: { write: (value) => { output += value; return true; } } });

    expect(code).toBe(2);
    expect(output).toContain('invalid reindex command');
    expect(existsSync(indexPath)).toBe(false);
  });
});
