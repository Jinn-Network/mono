import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContributionCandidateV1 } from '@jinn-network/plugin';
import { describe, expect, it } from 'vitest';
import {
  CONTRIBUTION_PUBLICATION_DISABLED_FILE,
  CONTRIBUTION_STORE_SCHEMA_VERSION,
  ContributionStore,
  type ContributionStoreRecord,
} from '../src/contribution-store.js';

function candidate(
  sourceId: string,
  overrides: Partial<ContributionCandidateV1> = {},
): ContributionCandidateV1 {
  return {
    schemaVersion: 'jinn.contribution-candidate.v1',
    sourceId,
    repositorySlug: 'Jinn-Network/mono',
    baseCommit: '0123456789abcdef',
    acceptedDiff: 'diff --git a/a.ts b/a.ts\n+fixed\n',
    testRuns: [{ command: 'yarn test', exitCode: 0, at: '2026-07-15T12:00:00.000Z' }],
    intermediateFailureDiffs: ['diff --git a/a.ts b/a.ts\n-broken\n'],
    skillEvents: [{ skillRef: 'systematic-debugging', action: 'invoked' }],
    publishMinedTasksConsent: false,
    createdAt: '2026-07-15T12:00:00.000Z',
    ...overrides,
  };
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'contribution-store-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('ContributionStore state model', () => {
  it('records locally regardless of share consent and persists the canonical candidate verbatim', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });
      const input = candidate('source-disabled');

      const stored = await store.record(input);

      expect(stored).toMatchObject({
        recordId: 'source-disabled',
        candidate: input,
        localState: 'recorded',
        publicationState: 'disabled',
      });
      expect(await store.get('source-disabled')).toEqual(stored);
    });
  });

  it('treats opaque source ids as data rather than inherited object properties', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });

      for (const sourceId of ['__proto__', 'constructor', 'toString']) {
        await expect(store.record(candidate(sourceId))).resolves.toMatchObject({ recordId: sourceId });
      }

      expect((await store.list()).map((record) => record.recordId).sort())
        .toEqual(['__proto__', 'constructor', 'toString'].sort());
      expect(await store.get('__proto__')).toMatchObject({
        recordId: '__proto__',
        candidate: { sourceId: '__proto__' },
      });
    });
  });

  it('requires one preview acknowledgement, then queues later consented candidates', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });
      const first = await store.record(candidate('first', { publishMinedTasksConsent: true }));
      const waiting = await store.record(candidate('also-waiting', { publishMinedTasksConsent: true }));
      expect(first.publicationState).toBe('preview-required');
      expect(waiting.publicationState).toBe('preview-required');

      await store.authorize('first', '2026-07-15T12:01:00.000Z');

      expect((await store.get('first'))?.publicationState).toBe('queued');
      expect((await store.get('also-waiting'))?.publicationState).toBe('queued');
      const later = await store.record(candidate('later', { publishMinedTasksConsent: true }));
      expect(later.publicationState).toBe('queued');
    });
  });

  it('tracks local mint/rejection independently from publication and keeps optional refs', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });
      await store.record(candidate('minted'));
      await store.record(candidate('rejected'));

      await store.markMinted('minted', 'mint:1');
      await store.markRejected('rejected', 'empirical-dead');

      expect(await store.get('minted')).toMatchObject({
        localState: 'minted',
        publicationState: 'disabled',
        mintRef: 'mint:1',
      });
      expect(await store.get('rejected')).toMatchObject({
        localState: 'rejected',
        publicationState: 'disabled',
        rejectionReason: 'empirical-dead',
      });
    });
  });

  it('never authorizes a locally rejected candidate', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });
      await store.record(candidate('rejected-preview', { publishMinedTasksConsent: true }));
      await store.markRejected('rejected-preview', 'not reproducible');

      await expect(store.authorize('rejected-preview', '2026-07-15T12:01:00.000Z'))
        .rejects.toThrow(/rejected|disabled/i);
      expect(await store.get('rejected-preview')).toMatchObject({
        localState: 'rejected',
        publicationState: 'disabled',
      });
    });
  });

  it('allows veto before publication and makes published records immutable', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });
      await store.record(candidate('veto', { publishMinedTasksConsent: true }));
      await store.veto('veto');
      expect((await store.get('veto'))?.publicationState).toBe('vetoed');

      await store.record(candidate('published', { publishMinedTasksConsent: true }));
      await store.authorize('published', '2026-07-15T12:01:00.000Z');
      await store.markMinted('published', 'mint:published');
      await store.markPublished('published', 'ipfs://publication');

      await expect(store.veto('published')).rejects.toThrow(/published.*immutable/i);
      await expect(store.markRejected('published', 'late failure')).rejects.toThrow(/published.*immutable/i);
      expect(await store.get('published')).toMatchObject({
        localState: 'minted',
        publicationState: 'published',
        publicationRef: 'ipfs://publication',
      });
    });
  });

  it('can record an already-vetoed candidate atomically', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });

      const stored = await store.record(
        candidate('veto-at-record', { publishMinedTasksConsent: true }),
        undefined,
        { publicationState: 'vetoed' },
      );

      expect(stored).toMatchObject({
        localState: 'recorded',
        publicationState: 'vetoed',
      });
      expect(await store.get('veto-at-record')).toMatchObject({
        localState: 'recorded',
        publicationState: 'vetoed',
      });
    });
  });

  it('revokes every unpublished sharing authorization without rewriting published history', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });
      await store.record(candidate('waiting', { publishMinedTasksConsent: true }));
      await store.record(candidate('queued', { publishMinedTasksConsent: true }));
      await store.authorize('queued', '2026-07-15T12:01:00.000Z');
      await store.record(candidate('published', { publishMinedTasksConsent: true }));
      await store.markMinted('published', 'mint:published');
      await store.markPublished('published', 'ipfs://published');

      const revoked = await store.disableUnpublished();

      expect(revoked.sort()).toEqual(['queued', 'waiting']);
      expect((await store.get('waiting'))?.publicationState).toBe('disabled');
      expect((await store.get('queued'))?.publicationState).toBe('disabled');
      expect((await store.get('published'))?.publicationState).toBe('published');
      expect(existsSync(join(stateDir, CONTRIBUTION_PUBLICATION_DISABLED_FILE))).toBe(true);

      const whileDisabled = await store.record(candidate('while-disabled', { publishMinedTasksConsent: true }));
      expect(whileDisabled.publicationState).toBe('disabled');
      await store.enablePublication();
      const afterEnable = await store.record(candidate('after-enable', { publishMinedTasksConsent: true }));
      expect(afterEnable.publicationState).toBe('queued');
    });
  });

  it('holds canonical authorization through the outbound operation and commits publication atomically', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });
      await store.record(candidate('publish', { publishMinedTasksConsent: true }));
      await store.authorize('publish', '2026-07-15T12:01:00.000Z');

      const value = await store.publishAuthorized('publish', async () => ({
        value: 'uploaded',
        mintRef: 'mint:publish',
        publicationRef: 'ipfs://published',
      }));

      expect(value).toBe('uploaded');
      expect(await store.get('publish')).toMatchObject({
        localState: 'minted',
        mintRef: 'mint:publish',
        publicationState: 'published',
        publicationRef: 'ipfs://published',
      });
      await expect(store.publishAuthorized('publish', async () => ({
        value: 'again', mintRef: 'mint:publish', publicationRef: 'ipfs://again',
      }))).rejects.toThrow(/published.*immutable/i);
    });
  });

  it('does not block or lose an unrelated session record during a slow publication', async () => {
    await withTmpDir(async (stateDir) => {
      const publishing = new ContributionStore({ stateDir });
      const recording = new ContributionStore({
        stateDir,
        lock: { retryDelayMs: 1, maxRetries: 2 },
      });
      await publishing.record(candidate('publishing', { publishMinedTasksConsent: true }));
      await publishing.authorize('publishing', '2026-07-15T12:01:00.000Z');
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });

      const outbound = publishing.publishAuthorized('publishing', async () => {
        entered();
        await gate;
        return {
          value: 'uploaded',
          mintRef: 'mint:publishing',
          publicationRef: 'ipfs://publishing',
        };
      });
      await started;

      await expect(recording.record(candidate('concurrent-session'))).resolves.toMatchObject({
        recordId: 'concurrent-session',
        localState: 'recorded',
      });
      release();
      await outbound;
      expect((await publishing.list()).map((record) => record.recordId).sort())
        .toEqual(['concurrent-session', 'publishing']);
    });
  });

  it('records a successful outbound publication even if the fail-closed marker arrives during upload', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });
      await store.record(candidate('publication-linearized', { publishMinedTasksConsent: true }));
      await store.authorize('publication-linearized', '2026-07-15T12:01:00.000Z');

      const value = await store.publishAuthorized('publication-linearized', async () => {
        await writeFile(
          join(stateDir, CONTRIBUTION_PUBLICATION_DISABLED_FILE),
          'disabled\n',
          { encoding: 'utf8', mode: 0o600 },
        );
        return {
          value: 'uploaded',
          mintRef: 'mint:publication-linearized',
          publicationRef: 'ipfs://publication-linearized',
        };
      });

      expect(value).toBe('uploaded');
      expect(await store.get('publication-linearized')).toMatchObject({
        localState: 'minted',
        mintRef: 'mint:publication-linearized',
        publicationState: 'published',
        publicationRef: 'ipfs://publication-linearized',
      });
      expect(existsSync(join(stateDir, CONTRIBUTION_PUBLICATION_DISABLED_FILE))).toBe(true);
      expect((await store.record(candidate('future', { publishMinedTasksConsent: true }))).publicationState)
        .toBe('disabled');
    });
  });
});

describe('ContributionStore v1 migration', () => {
  it('backs up v1, disables publication, and makes processed legacy records unavailable', async () => {
    await withTmpDir(async (stateDir) => {
      const path = join(stateDir, 'mineable-traces.json');
      const legacy = {
        schemaVersion: 'mineable-trace-store.v1',
        records: {
          pending: {
            sourceId: 'pending',
            kind: 'harness-session',
            repo: 'Jinn-Network/mono',
            baseCommit: 'abc123',
            acceptedDiff: 'diff --git a/a b/a\n+pending\n',
            testRuns: [{ cmd: 'yarn test', exitCode: 0, at: '2026-07-15T12:00:00.000Z' }],
            intermediateFailureDiffs: ['diff --git a/a b/a\n-failed\n'],
            skillEvents: [{ skill: 'debug', action: 'loaded' }],
            publishMinedTasksConsent: true,
            createdAt: '2026-07-15T12:00:00.000Z',
          },
          processed: {
            sourceId: 'processed',
            kind: 'solvernet-execution',
            repo: 'Jinn-Network/mono',
            baseCommit: 'def456',
            acceptedDiff: 'diff --git a/b b/b\n+processed\n',
            testRuns: [],
            intermediateFailureDiffs: [],
            skillEvents: [],
            publishMinedTasksConsent: true,
            createdAt: '2026-07-15T12:00:00.000Z',
            mined: true,
          },
        },
      };
      const original = `${JSON.stringify(legacy, null, 2)}\n`;
      await mkdir(stateDir, { recursive: true });
      await writeFile(path, original, 'utf8');

      const store = new ContributionStore({ stateDir });
      const records = await store.list();

      expect(await readFile(`${path}.v1.bak`, 'utf8')).toBe(original);
      expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(CONTRIBUTION_STORE_SCHEMA_VERSION);
      expect(records.find((record) => record.recordId === 'pending')).toMatchObject({
        candidate: {
          schemaVersion: 'jinn.contribution-candidate.v1',
          repositorySlug: 'Jinn-Network/mono',
          testRuns: [{ command: 'yarn test' }],
          skillEvents: [{ skillRef: 'debug', action: 'loaded' }],
          publishMinedTasksConsent: false,
        },
        localState: 'recorded',
        publicationState: 'disabled',
        legacy: { availability: 'candidate' },
      });
      expect(records.find((record) => record.recordId === 'processed')).toMatchObject({
        localState: 'rejected',
        publicationState: 'disabled',
        legacy: { availability: 'unavailable' },
      });
      expect((await store.listRecorded()).map((record) => record.recordId)).toEqual(['pending']);
    });
  });
});

describe('ContributionStore locking', () => {
  it('has no process-local stale cache across store instances', async () => {
    await withTmpDir(async (stateDir) => {
      const first = new ContributionStore({ stateDir });
      const second = new ContributionStore({ stateDir });
      await first.record(candidate('first'));
      await second.record(candidate('second'));

      expect((await first.list()).map((record) => record.recordId).sort()).toEqual(['first', 'second']);
    });
  });

  it('serializes concurrent read-modify-write operations without dropping records', async () => {
    await withTmpDir(async (stateDir) => {
      const stores = Array.from({ length: 4 }, () => new ContributionStore({
        stateDir,
        lock: { maxRetries: 0 },
      }));
      const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) =>
        stores[index % stores.length]!.record(candidate(`record-${index}`)),
      ));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;

      expect(await stores[0]!.list()).toHaveLength(40);
    });
  });

  it('recovers a stale lock and bounds retries for a live lock', async () => {
    await withTmpDir(async (stateDir) => {
      const path = join(stateDir, 'mineable-traces.json');
      const lockPath = `${path}.lock`;
      await mkdir(lockPath, { recursive: true });
      const old = new Date('2020-01-01T00:00:00.000Z');
      await utimes(lockPath, old, old);
      const recovering = new ContributionStore({
        stateDir,
        lock: { retryDelayMs: 1, maxRetries: 2, staleAfterMs: 10 },
      });
      await recovering.record(candidate('after-stale'));
      expect(existsSync(lockPath)).toBe(false);

      await mkdir(lockPath, { recursive: true });
      const blocked = new ContributionStore({
        stateDir,
        lock: { retryDelayMs: 1, maxRetries: 2, staleAfterMs: 60_000 },
      });
      await expect(blocked.record(candidate('blocked'))).rejects.toThrow(/lock.*2 retries/i);
    });
  });

  it('does not steal an old lock from a still-live owner process', async () => {
    await withTmpDir(async (stateDir) => {
      const path = join(stateDir, 'mineable-traces.json');
      const lockPath = `${path}.lock`;
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ token: 'live', pid: process.pid }));
      const old = new Date('2020-01-01T00:00:00.000Z');
      await utimes(lockPath, old, old);
      const blocked = new ContributionStore({
        stateDir,
        lock: { retryDelayMs: 1, maxRetries: 2, staleAfterMs: 10 },
      });

      await expect(blocked.record(candidate('must-not-steal'))).rejects.toThrow(/lock.*2 retries/i);
      expect(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))).toMatchObject({ token: 'live' });
    });
  });

  it('serializes concurrent stale-lock recovery without deleting a successor lock', async () => {
    await withTmpDir(async (stateDir) => {
      const path = join(stateDir, 'mineable-traces.json');
      const lockPath = `${path}.lock`;
      await mkdir(lockPath, { recursive: true });
      const old = new Date('2020-01-01T00:00:00.000Z');
      await utimes(lockPath, old, old);
      const stores = Array.from({ length: 8 }, () => new ContributionStore({
        stateDir,
        lock: { retryDelayMs: 1, maxRetries: 200, staleAfterMs: 10 },
      }));

      await Promise.all(stores.map((store, index) => store.record(candidate(`recovered-${index}`))));

      expect((await stores[0]!.list()).map((record) => record.recordId).sort())
        .toEqual(Array.from({ length: 8 }, (_, index) => `recovered-${index}`).sort());
    });
  });

  it('recovers when a previous process crashed while holding the stale-lock recovery guard', async () => {
    await withTmpDir(async (stateDir) => {
      const path = join(stateDir, 'mineable-traces.json');
      const lockPath = `${path}.lock`;
      const recoveryPath = `${lockPath}.recovery`;
      await mkdir(lockPath, { recursive: true });
      await mkdir(recoveryPath, { recursive: true });
      await writeFile(
        join(recoveryPath, 'owner.0.99999999.00000000-0000-4000-8000-000000000000.json'),
        '',
        { mode: 0o600 },
      );
      const old = new Date('2020-01-01T00:00:00.000Z');
      await utimes(lockPath, old, old);
      await utimes(recoveryPath, old, old);
      const recovering = new ContributionStore({
        stateDir,
        lock: { retryDelayMs: 1, maxRetries: 5, staleAfterMs: 10 },
      });

      await expect(recovering.record(candidate('after-crashed-recovery'))).resolves.toMatchObject({
        recordId: 'after-crashed-recovery',
      });
      expect(existsSync(lockPath)).toBe(false);
      expect(existsSync(recoveryPath)).toBe(false);
    });
  });
});

describe('ContributionStore outbound privacy', () => {
  it('projects only public mint bindings and omits local ids, diff gold, failures, skill events, and trajectories', async () => {
    await withTmpDir(async (stateDir) => {
      const store = new ContributionStore({ stateDir });
      await store.record(candidate('private-local-source', {
        acceptedDiff: 'SECRET_ACCEPTED_DIFF_GOLD',
        intermediateFailureDiffs: ['SECRET_HOLDOUT_FAILURE'],
        skillEvents: [{ skillRef: 'SECRET_LOCAL_SKILL', action: 'loaded' }],
        publishMinedTasksConsent: true,
      }));
      await store.authorize('private-local-source', '2026-07-15T12:01:00.000Z');
      await store.markMinted('private-local-source', 'mint:public-safe-ref');

      const record = await store.get('private-local-source') as ContributionStoreRecord;
      const outbound = store.toOutboundProjection(record);
      const serialized = JSON.stringify(outbound);

      expect(outbound).toEqual({
        schemaVersion: 'jinn.contribution-publication.v1',
        repositorySlug: 'Jinn-Network/mono',
        baseCommit: '0123456789abcdef',
        mintRef: 'mint:public-safe-ref',
      });
      expect(serialized).not.toMatch(/private-local-source|SECRET_ACCEPTED_DIFF_GOLD|SECRET_HOLDOUT_FAILURE|SECRET_LOCAL_SKILL|trajectory/);
    });
  });
});

describe('ContributionStore local privacy permissions', () => {
  it('writes private directories and files with owner-only permissions', async () => {
    await withTmpDir(async (root) => {
      const stateDir = join(root, 'private-state');
      const store = new ContributionStore({ stateDir });
      await store.record(candidate('private-mode'));

      expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(stateDir, 'mineable-traces.json'))).mode & 0o777).toBe(0o600);
    });
  });
});
