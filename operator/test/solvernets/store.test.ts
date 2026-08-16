/**
 * Tests for the local launched + draft persistence store (Task 5).
 *
 * Spec: operator/src/solvernets/store.ts persists owned launched-SolverNet
 * records to ~/.jinn-client/solvernets/launched/<solverNetId>.json and
 * draft records to ~/.jinn-client/solvernets/drafts/<draftId>.json.
 *
 * Tests use a per-test tmpdir baseDir; no test should ever touch the real
 * ~/.jinn-client directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  createSolverNetStore,
  type LaunchedSolverNetRecord,
  type DraftSolverNetRecord,
} from '../../src/solvernets/store.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeLaunched(overrides: Partial<LaunchedSolverNetRecord> = {}): LaunchedSolverNetRecord {
  return {
    schemaVersion: 'solvernet.launched.v1',
    solverNetId: 'sn_01HEXAMPLE000000000000',
    manifestCid: 'bafy...example',
    manifestHash: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    launcherAgentId: '42',
    launcherSafeAddress: '0x1111111111111111111111111111111111111111',
    launchedAt: '2026-05-05T12:00:00.000Z',
    status: 'launched',
    statusUpdatedAt: '2026-05-05T12:00:00.000Z',
    generatorEnabled: true,
    registry: {},
    ...overrides,
  };
}

function makeDraft(overrides: Partial<DraftSolverNetRecord> = {}): DraftSolverNetRecord {
  return {
    schemaVersion: 'solvernet.draft.v1',
    draftId: 'draft_01HEXAMPLE000000000000',
    completedSteps: [],
    createdAt: '2026-05-05T12:00:00.000Z',
    updatedAt: '2026-05-05T12:00:00.000Z',
    ...overrides,
  };
}

// ── Setup ───────────────────────────────────────────────────────────────────

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'solvernet-store-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Launched-record tests ──────────────────────────────────────────────────

describe('createSolverNetStore — launched records', () => {
  it('returns empty array when launched directory does not exist', async () => {
    const store = createSolverNetStore({ baseDir });
    const records = await store.loadOwnedRecords();
    expect(records).toEqual([]);
  });

  it('round-trips a launched record through write + load', async () => {
    const store = createSolverNetStore({ baseDir });
    const rec = makeLaunched();
    await store.writeRecord(rec);

    const loaded = await store.loadRecord(rec.solverNetId);
    expect(loaded).toEqual(rec);

    const all = await store.loadOwnedRecords();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(rec);
  });

  it('persists optional launchProgress and generatorState fields', async () => {
    const store = createSolverNetStore({ baseDir });
    const rec = makeLaunched({
      status: 'launching',
      launchProgress: {
        phase: 'broadcasting',
        txHash: ('0x' + 'cd'.repeat(32)) as `0x${string}`,
        attemptCount: 1,
      },
      generatorState: {
        lastPollAt: '2026-05-05T12:30:00.000Z',
        lastError: { message: 'rpc timeout', at: '2026-05-05T12:29:00.000Z' },
      },
      registry: {
        metadataTxHash: ('0x' + 'ef'.repeat(32)) as `0x${string}`,
        metadataBlockNumber: 12345,
      },
    });
    await store.writeRecord(rec);

    const loaded = await store.loadRecord(rec.solverNetId);
    expect(loaded).toEqual(rec);
  });

  it('loadRecord returns null for unknown id', async () => {
    const store = createSolverNetStore({ baseDir });
    expect(await store.loadRecord('sn_unknown')).toBeNull();
  });

  it('loadOwnedRecords skips and logs corrupted JSON files but returns valid ones', async () => {
    const store = createSolverNetStore({ baseDir });
    const valid = makeLaunched({ solverNetId: 'sn_valid' });
    await store.writeRecord(valid);

    // Plant a corrupted file alongside.
    const launchedDir = path.join(baseDir, 'solvernets', 'launched');
    await writeFile(path.join(launchedDir, 'sn_corrupt.json'), '{ this is not json', 'utf8');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const records = await store.loadOwnedRecords();

    expect(records).toHaveLength(1);
    expect(records[0]?.solverNetId).toBe('sn_valid');
    expect(errSpy).toHaveBeenCalled();
  });

  it('loadOwnedRecords skips and logs schema-violating JSON files', async () => {
    const store = createSolverNetStore({ baseDir });
    const valid = makeLaunched({ solverNetId: 'sn_valid' });
    await store.writeRecord(valid);

    const launchedDir = path.join(baseDir, 'solvernets', 'launched');
    await writeFile(
      path.join(launchedDir, 'sn_bad_schema.json'),
      JSON.stringify({ schemaVersion: 'solvernet.launched.v1', solverNetId: 'oops' }),
      'utf8',
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const records = await store.loadOwnedRecords();

    expect(records.map(r => r.solverNetId)).toEqual(['sn_valid']);
    expect(errSpy).toHaveBeenCalled();
  });

  it('loadOwnedRecords ignores AppleDouble dotfiles (._*.json) without logging', async () => {
    const store = createSolverNetStore({ baseDir });
    const valid = makeLaunched({ solverNetId: 'foo' });
    await store.writeRecord(valid);

    // macOS-tarball-seeded state drops an AppleDouble ._foo.json companion
    // alongside foo.json. It carries valid-looking JSON, so it would parse
    // and (worse) might mis-validate if listed. It must be excluded at the
    // listing layer — no extra record, no error log.
    const launchedDir = path.join(baseDir, 'solvernets', 'launched');
    await writeFile(
      path.join(launchedDir, '._foo.json'),
      JSON.stringify(makeLaunched({ solverNetId: 'foo' })),
      'utf8',
    );

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const records = await store.loadOwnedRecords();

    expect(records).toHaveLength(1);
    expect(records[0]?.solverNetId).toBe('foo');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('loadOwnedRecords ignores non-.json files (e.g. crashed-write tmp files)', async () => {
    const store = createSolverNetStore({ baseDir });
    const valid = makeLaunched({ solverNetId: 'sn_valid' });
    await store.writeRecord(valid);

    const launchedDir = path.join(baseDir, 'solvernets', 'launched');
    // Simulate a tmp file from a crashed atomic write.
    await writeFile(
      path.join(launchedDir, 'sn_valid.json.tmp-1234-abcd'),
      'partial garbage',
      'utf8',
    );

    const records = await store.loadOwnedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.solverNetId).toBe('sn_valid');
  });

  it('writeRecord uses atomic-rename pattern (no tmp files left after success)', async () => {
    const store = createSolverNetStore({ baseDir });
    await store.writeRecord(makeLaunched());

    const launchedDir = path.join(baseDir, 'solvernets', 'launched');
    const files = await readdir(launchedDir);
    expect(files.every(f => !f.includes('.tmp'))).toBe(true);
    expect(files.filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  it('writeRecord overwrites existing record for the same solverNetId', async () => {
    const store = createSolverNetStore({ baseDir });
    const rec = makeLaunched();
    await store.writeRecord(rec);

    const updated = makeLaunched({
      status: 'paused',
      statusUpdatedAt: '2026-05-06T00:00:00.000Z',
    });
    await store.writeRecord(updated);

    const loaded = await store.loadRecord(rec.solverNetId);
    expect(loaded?.status).toBe('paused');
    expect(loaded?.statusUpdatedAt).toBe('2026-05-06T00:00:00.000Z');
  });

  it('deleteRecord removes the file', async () => {
    const store = createSolverNetStore({ baseDir });
    const rec = makeLaunched();
    await store.writeRecord(rec);

    expect(await store.loadRecord(rec.solverNetId)).not.toBeNull();
    await store.deleteRecord(rec.solverNetId);
    expect(await store.loadRecord(rec.solverNetId)).toBeNull();
  });

  it('deleteRecord on unknown id is a no-op', async () => {
    const store = createSolverNetStore({ baseDir });
    await expect(store.deleteRecord('sn_does_not_exist')).resolves.toBeUndefined();
  });

  it('writeRecord rejects records that fail schema validation', async () => {
    const store = createSolverNetStore({ baseDir });
    const bad = { ...makeLaunched(), status: 'bogus' } as unknown as LaunchedSolverNetRecord;
    await expect(store.writeRecord(bad)).rejects.toThrow();
  });

  it('writeRecord persists JSON readable by hand (sanity round-trip via fs)', async () => {
    const store = createSolverNetStore({ baseDir });
    const rec = makeLaunched();
    await store.writeRecord(rec);

    const file = path.join(baseDir, 'solvernets', 'launched', `${rec.solverNetId}.json`);
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.solverNetId).toBe(rec.solverNetId);
    expect(parsed.schemaVersion).toBe('solvernet.launched.v1');
  });
});

// ── Draft tests ────────────────────────────────────────────────────────────

describe('createSolverNetStore — drafts', () => {
  it('returns empty array when drafts directory does not exist', async () => {
    const store = createSolverNetStore({ baseDir });
    expect(await store.listDrafts()).toEqual([]);
  });

  it('round-trips a draft through write + load + list', async () => {
    const store = createSolverNetStore({ baseDir });
    const draft = makeDraft({
      templateContractId: 'prediction',
      templateContractVersion: 'v1',
      name: 'My SolverNet',
      completedSteps: ['define', 'reviewContract'],
    });
    await store.writeDraft(draft);

    const loaded = await store.loadDraft(draft.draftId);
    expect(loaded).toEqual(draft);

    const all = await store.listDrafts();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(draft);
  });

  it('loadDraft returns null for unknown id', async () => {
    const store = createSolverNetStore({ baseDir });
    expect(await store.loadDraft('draft_unknown')).toBeNull();
  });

  it('listDrafts skips corrupted files and returns valid ones', async () => {
    const store = createSolverNetStore({ baseDir });
    await store.writeDraft(makeDraft({ draftId: 'draft_valid' }));

    const draftsDir = path.join(baseDir, 'solvernets', 'drafts');
    await writeFile(path.join(draftsDir, 'draft_corrupt.json'), 'not json', 'utf8');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const drafts = await store.listDrafts();
    expect(drafts.map(d => d.draftId)).toEqual(['draft_valid']);
    expect(errSpy).toHaveBeenCalled();
  });

  it('writeDraft overwrites existing draft for the same draftId', async () => {
    const store = createSolverNetStore({ baseDir });
    const draft = makeDraft({ name: 'first' });
    await store.writeDraft(draft);
    await store.writeDraft({ ...draft, name: 'second', updatedAt: '2026-05-06T00:00:00.000Z' });

    const loaded = await store.loadDraft(draft.draftId);
    expect(loaded?.name).toBe('second');
  });

  it('deleteDraft removes the file', async () => {
    const store = createSolverNetStore({ baseDir });
    const draft = makeDraft();
    await store.writeDraft(draft);

    expect(await store.loadDraft(draft.draftId)).not.toBeNull();
    await store.deleteDraft(draft.draftId);
    expect(await store.loadDraft(draft.draftId)).toBeNull();
  });

  it('deleteDraft on unknown id is a no-op', async () => {
    const store = createSolverNetStore({ baseDir });
    await expect(store.deleteDraft('draft_does_not_exist')).resolves.toBeUndefined();
  });

  it('writeDraft rejects drafts that fail schema validation', async () => {
    const store = createSolverNetStore({ baseDir });
    const bad = {
      ...makeDraft(),
      completedSteps: ['not-a-step'],
    } as unknown as DraftSolverNetRecord;
    await expect(store.writeDraft(bad)).rejects.toThrow();
  });
});

// ── Path-isolation guard ───────────────────────────────────────────────────

describe('createSolverNetStore — path isolation', () => {
  it('writes only under the supplied baseDir', async () => {
    const store = createSolverNetStore({ baseDir });
    await store.writeRecord(makeLaunched());
    await store.writeDraft(makeDraft());

    // Both files must live under baseDir; no leakage to other locations.
    const launched = await readdir(path.join(baseDir, 'solvernets', 'launched'));
    const drafts = await readdir(path.join(baseDir, 'solvernets', 'drafts'));
    expect(launched.filter(f => f.endsWith('.json'))).toHaveLength(1);
    expect(drafts.filter(f => f.endsWith('.json'))).toHaveLength(1);
  });
});

// ── Id-validation guard (jinn-mono-qwdc.34) ────────────────────────────────

describe('createSolverNetStore — id validation', () => {
  // The store keys files by solverNetId / draftId. Without input validation,
  // an id containing `/` would create subdirectories that listJsonFiles
  // can't recurse into; an id like `..` or `../etc/passwd` could escape the
  // baseDir entirely.

  it.each([
    ['contains forward slash', 'launcher-1/prediction-001'],
    ['contains backslash', 'launcher\\\\prediction'],
    ['is "."', '.'],
    ['is ".."', '..'],
    ['contains "../" path traversal', '../etc/passwd'],
    ['contains shell metachar (semicolon)', 'a;b'],
    ['contains shell metachar (pipe)', 'a|b'],
    ['contains space', 'has space'],
    ['contains newline', 'a\\nb'],
    ['is empty', ''],
  ])('writeRecord rejects solverNetId that %s', async (_description, badId) => {
    const store = createSolverNetStore({ baseDir });
    const rec = makeLaunched({ solverNetId: badId });
    await expect(store.writeRecord(rec)).rejects.toThrow();
  });

  it('loadRecord rejects solverNetId with path separator (defense in depth)', async () => {
    const store = createSolverNetStore({ baseDir });
    await expect(store.loadRecord('launcher-1/prediction-001')).rejects.toThrow(
      /Invalid solverNetId/,
    );
  });

  it('loadRecord rejects ".." (path traversal)', async () => {
    const store = createSolverNetStore({ baseDir });
    await expect(store.loadRecord('..')).rejects.toThrow(/Invalid solverNetId/);
  });

  it('writeDraft rejects draftId with forward slash', async () => {
    const store = createSolverNetStore({ baseDir });
    const draft = makeDraft({ draftId: 'campaign/2026-05' });
    await expect(store.writeDraft(draft)).rejects.toThrow();
  });

  it('loadDraft rejects draftId with path separator', async () => {
    const store = createSolverNetStore({ baseDir });
    await expect(store.loadDraft('campaign/2026-05')).rejects.toThrow(
      /Invalid draftId/,
    );
  });

  it('accepts ids that contain only safe chars (alnum, dash, underscore, dot)', async () => {
    const store = createSolverNetStore({ baseDir });
    const ids = ['sn_01', 'launcher-1.prediction', 'AaBb_99', 'x.y.z', '01HEXAMPLE'];
    for (const id of ids) {
      const rec = makeLaunched({ solverNetId: id });
      await expect(store.writeRecord(rec)).resolves.toBeUndefined();
      const loaded = await store.loadRecord(id);
      expect(loaded?.solverNetId).toBe(id);
    }
  });
});
