import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ValidatedPoolStore,
  filterToScorablePool,
  validatePoolInstances,
  EVAL_SEMANTICS_VERSION,
  MAX_TRANSIENT_PASSES,
  TRANSIENT_INFRA_REASONS,
  exportScorableVettedPoolArtifact,
  excludeFromVettedPoolArtifact,
  shouldRepublishVettedPool,
  hashVettedPoolArtifact,
  loadVettedPoolArtifactScorableEntries,
  sweRebenchV2VettedPoolArtifactMetadataKey,
  normalizeReason,
  summarizeValidatedPool,
  vettedPoolRefSemanticsMismatch,
  SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION,
  SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE,
  isPublicationStale,
  readVettedPoolArtifactPublicationUnfiltered,
  writeVettedPoolArtifactPublication,
  createVettedPoolArtifactRef,
  parseVettedPoolArtifact,
} from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { computeRowHash } from '../../src/solver-types/_swe-rebench-v2-substrate.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'swe-validated-pool-test-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function poolTask(id: string, overrides: Partial<PoolTask> = {}): PoolTask {
  return {
    instance_id: id,
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: '2026_02',
    repo: 'acme/widget',
    base_commit: 'deadbeef',
    language: 'python',
    patch: 'diff --git a/src/x.py b/src/x.py\n--- a/src/x.py\n+++ b/src/x.py\n@@ -1 +1 @@\n-a\n+b\n',
    test_patch: 'diff --git a/tests/test_x.py b/tests/test_x.py\n--- a/tests/test_x.py\n+++ b/tests/test_x.py\n@@ -1 +1 @@\n-c\n+d\n',
    ...overrides,
  };
}

describe('normalizeReason (#493 reason histogram)', () => {
  it('splits gold-patch-not-resolved by PASS_TO_PASS breakage (#806)', () => {
    // p2p_broke == 0: genuinely-hard / mislabeled instance — leave alone.
    expect(normalizeReason('gold-patch-not-resolved (f2p 1, p2p_broke 0)')).toBe('gold-patch-not-resolved');
    expect(normalizeReason('gold-patch-not-resolved (f2p 0, p2p_broke 0)')).toBe('gold-patch-not-resolved');
    // p2p_broke > 0: PASS_TO_PASS tests that should still pass are failing —
    // environment/setup problem, a chase-able evaluator-capacity blocker.
    expect(normalizeReason('gold-patch-not-resolved (f2p 0, p2p_broke 5)')).toBe('gold-patch-not-resolved:p2p-broke');
    expect(normalizeReason('gold-patch-not-resolved (f2p 0, p2p_broke 53)')).toBe('gold-patch-not-resolved:p2p-broke');
    expect(normalizeReason('gold-patch-not-resolved (f2p 2, p2p_broke 1)')).toBe('gold-patch-not-resolved:p2p-broke');
  });

  it('falls back to the base bucket when the p2p_broke detail is absent or unparseable', () => {
    // Defensive: a bare or legacy reason with no parseable count must not
    // be miscounted as an environment break.
    expect(normalizeReason('gold-patch-not-resolved')).toBe('gold-patch-not-resolved');
    expect(normalizeReason('gold-patch-not-resolved (malformed)')).toBe('gold-patch-not-resolved');
  });

  it('collapses transient:HF-429:<msg> variants into transient:HF-429', () => {
    expect(normalizeReason('transient:HF-429:HF datasets-server returned 429 for X/2026_02')).toBe('transient:HF-429');
    expect(normalizeReason('transient:HF-429:anything')).toBe('transient:HF-429');
  });

  it('collapses error:HF datasets-server returned 429 ... variants into error:HF-429', () => {
    // Legacy 429 reasons emitted before the transient classifier shipped
    // (issue #578). The histogram should still bucket them by family so
    // operators can see "this is the same problem" at a glance.
    expect(normalizeReason('error:HF datasets-server returned 429 for nebius/SWE-rebench-leaderboard/2026_02')).toBe('error:HF-429');
    expect(normalizeReason('error:HF datasets-server returned 429 for nebius/SWE-rebench-leaderboard/2025_05')).toBe('error:HF-429');
  });

  it('preserves canonical reasons unchanged', () => {
    expect(normalizeReason('gold-patch-resolves')).toBe('gold-patch-resolves');
    expect(normalizeReason('ungradeable:pytest_missing')).toBe('ungradeable:pytest_missing');
    expect(normalizeReason('ungradeable:docker_unavailable')).toBe('ungradeable:docker_unavailable');
    expect(normalizeReason('error:HF-429-permanent-after-5-passes')).toBe('error:HF-429-permanent-after-5-passes');
    expect(normalizeReason('non-pytest-unsupported')).toBe('non-pytest-unsupported');
    expect(normalizeReason('unresolvable-image-digest')).toBe('unresolvable-image-digest');
    expect(normalizeReason('missing-gold-patch')).toBe('missing-gold-patch');
  });
});

describe('summarizeValidatedPool (#493 reason histogram)', () => {
  it('returns total/scorable/unscorable counts and a descending-sorted byReason map', () => {
    const file = {
      schemaVersion: 'swe-rebench-v2-validated-pool.v1',
      evalSemanticsVersion: '4',
      updatedAt: '2026-05-25T00:00:00Z',
      entries: {
        'a__1': { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-25T00:00:00Z' },
        'a__2': { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-25T00:00:00Z' },
        'a__3': { scorable: false, reason: 'ungradeable:pytest_missing', checkedAt: '2026-05-25T00:00:00Z' },
        'a__4': { scorable: false, reason: 'ungradeable:pytest_missing', checkedAt: '2026-05-25T00:00:00Z' },
        'a__5': { scorable: false, reason: 'ungradeable:pytest_missing', checkedAt: '2026-05-25T00:00:00Z' },
        'a__6': { scorable: false, reason: 'gold-patch-not-resolved (f2p 1, p2p_broke 0)', checkedAt: '2026-05-25T00:00:00Z' },
        'a__7': { scorable: false, reason: 'gold-patch-not-resolved (f2p 0, p2p_broke 5)', checkedAt: '2026-05-25T00:00:00Z' },
        'a__8': { scorable: false, reason: 'transient:HF-429:HF datasets-server returned 429 for X/2026_02', checkedAt: '2026-05-25T00:00:00Z' },
        'a__9': { scorable: false, reason: 'error:HF datasets-server returned 429 for X/2025_05', checkedAt: '2026-05-25T00:00:00Z' },
      },
    };
    const summary = summarizeValidatedPool(file);
    expect(summary.totalEntries).toBe(9);
    expect(summary.scorable).toBe(2);
    expect(summary.unscorable).toBe(7);
    // byReason is an array of {reason, count} sorted descending by count then ascending by reason.
    // Per #806 the two gold-patch-not-resolved entries split: a__6 (p2p_broke 0)
    // stays in the base bucket; a__7 (p2p_broke 5) moves to the :p2p-broke bucket.
    expect(summary.byReason).toEqual([
      { reason: 'ungradeable:pytest_missing', count: 3 },
      { reason: 'gold-patch-resolves', count: 2 },
      { reason: 'error:HF-429', count: 1 },
      { reason: 'gold-patch-not-resolved', count: 1 },
      { reason: 'gold-patch-not-resolved:p2p-broke', count: 1 },
      { reason: 'transient:HF-429', count: 1 },
    ]);
  });

  it('separates p2p-intact and p2p-broke gold-patch-not-resolved entries into distinct buckets (#806)', () => {
    const file = {
      schemaVersion: 'swe-rebench-v2-validated-pool.v1',
      evalSemanticsVersion: '4',
      updatedAt: '2026-05-28T00:00:00Z',
      entries: {
        intact__1: { scorable: false, reason: 'gold-patch-not-resolved (f2p 1, p2p_broke 0)', checkedAt: '2026-05-28T00:00:00Z' },
        intact__2: { scorable: false, reason: 'gold-patch-not-resolved (f2p 0, p2p_broke 0)', checkedAt: '2026-05-28T00:00:00Z' },
        // the #806 concrete example: noppanut15__depthviz-55 with 53 broken p2p tests
        broke__1: { scorable: false, reason: 'gold-patch-not-resolved (f2p 0, p2p_broke 53)', checkedAt: '2026-05-28T00:00:00Z' },
      },
    };
    const summary = summarizeValidatedPool(file);
    expect(summary.byReason).toEqual([
      { reason: 'gold-patch-not-resolved', count: 2 },
      { reason: 'gold-patch-not-resolved:p2p-broke', count: 1 },
    ]);
  });

  it('handles an empty entries map', () => {
    const summary = summarizeValidatedPool({
      schemaVersion: 'swe-rebench-v2-validated-pool.v1',
      evalSemanticsVersion: '4',
      updatedAt: '2026-05-25T00:00:00Z',
      entries: {},
    });
    expect(summary).toEqual({ totalEntries: 0, scorable: 0, unscorable: 0, byReason: [] });
  });

  it('throws when the file is malformed (missing entries)', () => {
    expect(() => summarizeValidatedPool({ schemaVersion: 'x' })).toThrow();
  });
});

describe('ValidatedPoolStore', () => {
  it('records entries and round-trips them via getEntry / getScorableIds', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('a__1', { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-13T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    await store.record('a__2', { scorable: false, reason: 'ungradeable:docker_unavailable', checkedAt: '2026-05-13T00:00:01Z' }, EVAL_SEMANTICS_VERSION);
    expect((await store.getEntry('a__1', EVAL_SEMANTICS_VERSION))?.scorable).toBe(true);
    expect((await store.getEntry('a__2', EVAL_SEMANTICS_VERSION))?.scorable).toBe(false);
    expect(await store.getEntry('a__3', EVAL_SEMANTICS_VERSION)).toBeNull();
    const scorable = await store.getScorableIds(EVAL_SEMANTICS_VERSION);
    expect(scorable).toEqual(new Set(['a__1']));
    expect(existsSync(join(dir, 'validated-pool.json'))).toBe(true);
  });

  it('getScorableIds returns null when the file is absent or built for a different semantics version', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    expect(await store.getScorableIds(EVAL_SEMANTICS_VERSION)).toBeNull();
    await store.record('a__1', { scorable: true, reason: 'ok', checkedAt: '2026-05-13T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    expect(await store.getScorableIds(EVAL_SEMANTICS_VERSION)).toEqual(new Set(['a__1']));
    // Same file, different semantics version → treated as no data.
    expect(await store.getScorableIds('999')).toBeNull();
  });

  it('treats entries from a stale semantics version as not-yet-validated (re-validatable)', async () => {
    const dir = tmpDir();
    // Hand-write a file built for an old semantics version.
    writeFileSync(join(dir, 'validated-pool.json'), JSON.stringify({
      schemaVersion: 'swe-rebench-v2-validated-pool.v1',
      evalSemanticsVersion: 'OLD',
      updatedAt: '2026-01-01T00:00:00Z',
      entries: { a__1: { scorable: true, reason: 'ok', checkedAt: '2026-01-01T00:00:00Z' } },
    }));
    const store = new ValidatedPoolStore({ stateDir: dir });
    expect(await store.getEntry('a__1', EVAL_SEMANTICS_VERSION)).toBeNull();
    expect(await store.getScorableIds(EVAL_SEMANTICS_VERSION)).toBeNull();
  });
});

describe('filterToScorablePool', () => {
  const pool: PoolTask[] = [
    poolTask('a__1'),
    poolTask('a__2'),
    poolTask('go__1', { language: 'go' }),
    poolTask('rust__1', { language: 'rust' }),
  ];

  it('restricts to validated-scorable instances when validation data is present', () => {
    const { pool: out, mode } = filterToScorablePool(pool, new Set(['a__1', 'go__1']));
    expect(mode).toBe('validated');
    expect(out.map((t) => t.instance_id)).toEqual(['a__1', 'go__1']);
  });

  it('falls back to Python-only instances when no validation data exists (python-floor mode)', () => {
    const { pool: out, mode } = filterToScorablePool(pool, null, 'python-floor');
    expect(mode).toBe('python-floor');
    expect(out.map((t) => t.instance_id)).toEqual(['a__1', 'a__2']);
  });

  it('returns empty pool when no validation data exists in required mode (default)', () => {
    const { pool: out, mode } = filterToScorablePool(pool, null);
    expect(mode).toBe('admission-required-no-data');
    expect(out).toHaveLength(0);
  });

  it('infers Python from .py paths in the patch when the language field is unset (as the leaderboard rows are)', () => {
    const inferred: PoolTask[] = [
      poolTask('a__inferred_py', { language: undefined, patch: 'diff --git a/src/foo.py b/src/foo.py\n--- a/src/foo.py\n+++ b/src/foo.py\n@@ -1 +1 @@\n-a\n+b\n' }),
      poolTask('a__inferred_go', { language: undefined, patch: 'diff --git a/x.go b/x.go\n--- a/x.go\n+++ b/x.go\n@@ -1 +1 @@\n-a\n+b\n', test_patch: undefined }),
    ];
    const { pool: out } = filterToScorablePool(inferred, null, 'python-floor');
    expect(out.map((t) => t.instance_id)).toEqual(['a__inferred_py']);
  });
});

describe('swe-rebench-v2 vetted pool artifact helpers', () => {
  it('exports only scorable entries with grading substrate metadata and stable hash', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record(
      'org__repo-2',
      {
        scorable: true,
        reason: 'gold-patch-resolves',
        checkedAt: '2026-05-14T00:00:02Z',
        rowHash: 'sha256:' + '2'.repeat(64),
        imageName: 'swerebenchv2/repo-2:latest',
        imageDigest: 'sha256:' + 'b'.repeat(64),
        upstreamEvalCommit: '2'.repeat(40),
      },
      EVAL_SEMANTICS_VERSION,
    );
    await store.record(
      'org__repo-1',
      {
        scorable: true,
        reason: 'gold-patch-resolves',
        checkedAt: '2026-05-14T00:00:01Z',
        rowHash: 'sha256:' + '1'.repeat(64),
        imageName: 'swerebenchv2/repo-1:latest',
        imageDigest: 'sha256:' + 'a'.repeat(64),
        upstreamEvalCommit: '1'.repeat(40),
      },
      EVAL_SEMANTICS_VERSION,
    );
    await store.record(
      'org__repo-bad',
      {
        scorable: false,
        reason: 'gold-patch-not-resolved',
        checkedAt: '2026-05-14T00:00:03Z',
      },
      EVAL_SEMANTICS_VERSION,
    );

    const artifact = await exportScorableVettedPoolArtifact(store, EVAL_SEMANTICS_VERSION, {
      generatedAt: '2026-05-22T00:00:00.000Z',
    });

    expect(artifact).toMatchObject({
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-05-22T00:00:00.000Z',
    });
    expect(artifact.entries.map((e) => e.instance_id)).toEqual(['org__repo-1', 'org__repo-2']);
    expect(artifact.entries[0]).toMatchObject({
      instance_id: 'org__repo-1',
      reason: 'gold-patch-resolves',
      rowHash: 'sha256:' + '1'.repeat(64),
      imageName: 'swerebenchv2/repo-1:latest',
      imageDigest: 'sha256:' + 'a'.repeat(64),
      upstreamEvalCommit: '1'.repeat(40),
    });

    const entries = loadVettedPoolArtifactScorableEntries(artifact);
    expect(entries.ids).toEqual(new Set(['org__repo-1', 'org__repo-2']));
    expect(entries.byId.get('org__repo-2')?.imageDigest).toBe('sha256:' + 'b'.repeat(64));
    expect(hashVettedPoolArtifact(artifact)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashVettedPoolArtifact({ ...artifact, entries: [...artifact.entries].reverse() }))
      .toBe(hashVettedPoolArtifact(artifact));
    expect(sweRebenchV2VettedPoolArtifactMetadataKey('bafy-manifest'))
      .toBe('solvernet-artifact:bafy-manifest:swe-rebench-v2-vetted-pool');
  });

  it('publishes and parses the exact public v2 environment admission binding', async () => {
    const store = new ValidatedPoolStore({ stateDir: tmpDir() });
    const digest = `sha256:${'a'.repeat(64)}` as `sha256:${string}`;
    await store.record('jinn__mono-1', {
      scorable: true,
      reason: 'gold-patch-resolves',
      checkedAt: '2026-07-10T00:00:00.000Z',
      rowHashVersion: 2,
      publicRowHash: `sha256:${'b'.repeat(64)}`,
      v2Environment: {
        environmentSpecCid: 'bafy-environment',
        environmentHash: `sha256:${'c'.repeat(64)}`,
        parser: { id: 'vitest-json.v1', version: 'v1', digest, bundleId: 'jinn.swe-rebench-v2.patch-bundle.v1' },
        image: { reference: `ghcr.io/jinn-network/task-environment@${digest}`, digest },
        platform: 'linux/amd64',
      },
    }, EVAL_SEMANTICS_VERSION);

    const artifact = await exportScorableVettedPoolArtifact(store, EVAL_SEMANTICS_VERSION);
    const entry = loadVettedPoolArtifactScorableEntries(artifact!).byId.get('jinn__mono-1');

    expect(entry).toMatchObject({
      rowHashVersion: 2,
      publicRowHash: `sha256:${'b'.repeat(64)}`,
      v2Environment: { environmentSpecCid: 'bafy-environment', platform: 'linux/amd64' },
    });
  });
});

describe('excludeFromVettedPoolArtifact (#986 substrate-level held-out exclusion)', () => {
  async function buildArtifact(ids: string[]) {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    for (const id of ids) {
      await store.record(
        id,
        { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-06-05T00:00:00Z', rowHash: 'sha256:' + 'f'.repeat(64) },
        EVAL_SEMANTICS_VERSION,
      );
    }
    const artifact = await exportScorableVettedPoolArtifact(store, EVAL_SEMANTICS_VERSION, { generatedAt: '2026-06-05T00:00:00.000Z' });
    if (!artifact) throw new Error('expected artifact');
    return artifact;
  }

  it('drops exactly the excluded ids and preserves the rest', async () => {
    const artifact = await buildArtifact(['org__a', 'org__b', 'org__c']);
    const filtered = excludeFromVettedPoolArtifact(artifact, new Set(['org__b']));
    expect(filtered.entries.map((e) => e.instance_id)).toEqual(['org__a', 'org__c']);
  });

  it('is a no-op when the exclusion set is empty and never mutates its input', async () => {
    const artifact = await buildArtifact(['org__a', 'org__b']);
    const before = artifact.entries.map((e) => e.instance_id);
    const filtered = excludeFromVettedPoolArtifact(artifact, new Set());
    expect(filtered.entries.map((e) => e.instance_id)).toEqual(['org__a', 'org__b']);
    expect(artifact.entries.map((e) => e.instance_id)).toEqual(before);
  });

  it('yields the same content+hash as an artifact built without the held-out entry', async () => {
    const full = await buildArtifact(['org__a', 'org__b', 'org__c']);
    const filtered = excludeFromVettedPoolArtifact(full, new Set(['org__b']));
    const clean = await buildArtifact(['org__a', 'org__c']);
    expect(loadVettedPoolArtifactScorableEntries(filtered).ids).toEqual(new Set(['org__a', 'org__c']));
    expect(hashVettedPoolArtifact(filtered)).toBe(hashVettedPoolArtifact(clean));
    expect(hashVettedPoolArtifact(filtered)).not.toBe(hashVettedPoolArtifact(full));
  });
});

describe('shouldRepublishVettedPool (#986 held-out contamination trigger)', () => {
  const heldOut = new Set(['b']);
  it('republishes when there is no existing publication', () => {
    expect(shouldRepublishVettedPool({ existingIds: null, heldOutIds: heldOut, validatedNewer: false })).toBe(true);
  });
  it('republishes when the validated pool is newer (preserves the prior timestamp-gated refresh)', () => {
    expect(shouldRepublishVettedPool({ existingIds: new Set(['a', 'c']), heldOutIds: heldOut, validatedNewer: true })).toBe(true);
  });
  it('reuses an uncontaminated publication that is not newer (write-once / published-authoritative)', () => {
    expect(shouldRepublishVettedPool({ existingIds: new Set(['a', 'c']), heldOutIds: heldOut, validatedNewer: false })).toBe(false);
  });
  it('republishes when the existing publication still lists a now-held-out instance (the rollout/slate-bump trigger)', () => {
    expect(shouldRepublishVettedPool({ existingIds: new Set(['a', 'b', 'c']), heldOutIds: heldOut, validatedNewer: false })).toBe(true);
  });
  it('does NOT republish merely because the publication diverges from local scorable (no held-out overlap)', () => {
    // existing lists an instance absent from local scorable, but none are held-out
    expect(shouldRepublishVettedPool({ existingIds: new Set(['z']), heldOutIds: heldOut, validatedNewer: false })).toBe(false);
  });
});

describe('validatePoolInstances', () => {
  function makeRunner(byId: Record<string, { passed_match: boolean; passed?: string[]; failed?: string[] } | Error>) {
    return {
      runEval: vi.fn(async (args: { instance_id: string }) => {
        const v = byId[args.instance_id];
        if (v instanceof Error) throw v;
        if (!v) throw new Error(`no stub for ${args.instance_id}`);
        return { passed_match: v.passed_match, passed: v.passed ?? [], failed: v.failed ?? [], log: '', exitCode: v.passed_match ? 0 : 1 };
      }),
    };
  }
  function makeFetcher() {
    return {
      fetchTaskRow: vi.fn(async (a: { instance_id: string }) => ({
        instance_id: a.instance_id, repo: 'acme/widget',
        image_name: `swerebench/sweb.eval.x86_64.acme_1776_${a.instance_id}:latest`,
        FAIL_TO_PASS: ['tests/test_x.py::test_new'], PASS_TO_PASS: ['tests/test_x.py::test_old'],
        test_patch: 'diff --git a/tests/test_x.py b/tests/test_x.py\n',
        install_config: { install: 'pip install -e .', test_cmd: 'pytest tests/', log_parser: 'parse_log_pytest' },
      })),
    };
  }

  it('marks an instance scorable when the gold patch resolves, unscorable otherwise', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const runner = makeRunner({
      a__pass: { passed_match: true, passed: ['tests/test_x.py::test_new'] },
      a__fail: { passed_match: false, passed: [], failed: [] },
      a__ungradeable: Object.assign(new Error('eval could not grade'), { name: 'EvalCouldNotGradeError', reason: 'install_build_failed' }),
    });
    // commandRunner: docker returns a valid digest so substrate fields resolve;
    // git returns exitCode 1 so upstreamEvalCommit is omitted (non-fatal).
    const commandRunner = async (bin: string, args: string[]) => {
      if (bin === 'docker' && args[0] === 'image') {
        return { exitCode: 0, stdout: '["acme/widget@sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    const summary = await validatePoolInstances(
      [poolTask('a__pass'), poolTask('a__fail'), poolTask('a__ungradeable')],
      { fetcher: makeFetcher(), runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary).toMatchObject({ checked: 3, scorable: 1, unscorable: 2, skipped: 0 });
    expect((await store.getEntry('a__pass', EVAL_SEMANTICS_VERSION))?.scorable).toBe(true);
    expect((await store.getEntry('a__fail', EVAL_SEMANTICS_VERSION))?.scorable).toBe(false);
    const ung = await store.getEntry('a__ungradeable', EVAL_SEMANTICS_VERSION);
    expect(ung?.scorable).toBe(false);
    expect(ung?.reason).toBe('ungradeable:install_build_failed');
  });

  it('skips non-Python instances (records them unscorable, never invokes the runner)', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const runner = makeRunner({});
    // Non-Python instance exits before substrate resolution. upstreamRepoDir is
    // required but resolveUpstreamEvalCommit runs before the loop; use a stub
    // commandRunner so the test doesn't spawn real git.
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });
    const summary = await validatePoolInstances(
      [poolTask('go__1', { language: 'go' })],
      { fetcher: makeFetcher(), runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary).toMatchObject({ checked: 0, skipped: 1 });
    expect(runner.runEval).not.toHaveBeenCalled();
    expect((await store.getEntry('go__1', EVAL_SEMANTICS_VERSION))?.scorable).toBe(false);
  });

  it('skips already-validated instances unless force is set', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('a__1', { scorable: true, reason: 'ok', checkedAt: '2026-05-13T00:00:00Z' }, EVAL_SEMANTICS_VERSION);
    const runner = makeRunner({ a__1: { passed_match: false } });
    // Minimal stub: git returns null commit (non-fatal), docker returns exitCode 1
    // so imageDigest is unresolvable → entry is scorable:false regardless.
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });
    const s1 = await validatePoolInstances([poolTask('a__1')], { fetcher: makeFetcher(), runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner });
    expect(s1.checked).toBe(0);
    expect(runner.runEval).not.toHaveBeenCalled();
    const s2 = await validatePoolInstances([poolTask('a__1')], { fetcher: makeFetcher(), runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner }, { force: true });
    expect(s2.checked).toBe(1);
    expect(runner.runEval).toHaveBeenCalledTimes(1);
    expect((await store.getEntry('a__1', EVAL_SEMANTICS_VERSION))?.scorable).toBe(false);
  });

  it('honors the limit on how many instances it validates in one run', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const runner = makeRunner({ a__1: { passed_match: true }, a__2: { passed_match: true }, a__3: { passed_match: true } });
    // Minimal stub: digest fails → unresolvable-image-digest (scorable:false) but
    // checked still increments correctly — the limit assertion is unaffected.
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });
    const summary = await validatePoolInstances(
      [poolTask('a__1'), poolTask('a__2'), poolTask('a__3')],
      { fetcher: makeFetcher(), runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
      { limit: 2 },
    );
    expect(summary.checked).toBe(2);
    expect(runner.runEval).toHaveBeenCalledTimes(2);
  });
});

describe('ValidatedPoolStore — extended substrate fields (semantics v3)', () => {
  it('persists rowHash, imageName, imageDigest, upstreamEvalCommit alongside scorable/reason/checkedAt', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record(
      'a__1',
      {
        scorable: true,
        reason: 'gold-patch-resolves',
        checkedAt: '2026-05-14T00:00:00Z',
        rowHash: 'sha256:abc123',
        imageName: 'swerebenchv2/sweb.eval.x86_64.a__1:latest',
        imageDigest: 'sha256:def456',
        upstreamEvalCommit: '0123456789abcdef',
      },
      EVAL_SEMANTICS_VERSION,
    );
    const entry = await store.getEntry('a__1', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: true,
      rowHash: 'sha256:abc123',
      imageName: 'swerebenchv2/sweb.eval.x86_64.a__1:latest',
      imageDigest: 'sha256:def456',
      upstreamEvalCommit: '0123456789abcdef',
    });
  });

  it('round-trips an entry that omits the optional substrate fields, returning them as undefined', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record(
      'a__nosubstrate',
      {
        scorable: true,
        reason: 'gold-patch-resolves',
        checkedAt: '2026-05-14T00:00:00Z',
      },
      EVAL_SEMANTICS_VERSION,
    );
    const entry = await store.getEntry('a__nosubstrate', EVAL_SEMANTICS_VERSION);
    expect(entry).not.toBeNull();
    expect(entry!.scorable).toBe(true);
    expect(entry!.rowHash).toBeUndefined();
    expect(entry!.imageName).toBeUndefined();
    expect(entry!.imageDigest).toBeUndefined();
    expect(entry!.upstreamEvalCommit).toBeUndefined();
  });

  it('is "4" — bump this when grading semantics change, and update the JSDoc history block above', () => {
    expect(EVAL_SEMANTICS_VERSION).toBe('4');
  });
});

describe('ValidatedPoolStore — concurrent record() does not lose entries', () => {
  it('two concurrent record() calls for different instance ids leave both in the file', async () => {
    const dir = tmpDir();
    const storeA = new ValidatedPoolStore({ stateDir: dir });
    const storeB = new ValidatedPoolStore({ stateDir: dir });
    // Both stores load (empty), then both record concurrently.
    await Promise.all([
      storeA.record('a__1', { scorable: true, reason: 'ok', checkedAt: '2026-05-14T00:00:00Z' }, EVAL_SEMANTICS_VERSION),
      storeB.record('a__2', { scorable: true, reason: 'ok', checkedAt: '2026-05-14T00:00:01Z' }, EVAL_SEMANTICS_VERSION),
    ]);
    // A fresh store sees both entries on disk.
    const storeC = new ValidatedPoolStore({ stateDir: dir });
    expect(await storeC.getEntry('a__1', EVAL_SEMANTICS_VERSION)).not.toBeNull();
    expect(await storeC.getEntry('a__2', EVAL_SEMANTICS_VERSION)).not.toBeNull();
  });
});

describe('validatePoolInstances — #493 pytest_missing → scorable under v4', () => {
  it('demonstrates a v3 ungradeable:pytest_missing entry re-validates as scorable under v4 + the install-guard', async () => {
    // The stub EvalRunner simulates the in-container behavior: if no install
    // line installs pytest, the eval aborts as ungradeable:pytest_missing
    // (the actual fingerprint matched by matchInfraSignature on
    // "No module named pytest"). Under v4, validatePoolInstances feeds the
    // runner an install array still drawn from the HF row, but the
    // PythonEvalRunner's buildTestCommands prepends the install-guard.
    // For this test we simulate the same behavior at the validatePoolInstances
    // level: the runner stub treats v3 (no guard) like the pre-#493 behaviour
    // and v4 (guard) like the post-#493 behaviour.
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });

    // Pre-seed a v3 entry with the terminal pytest_missing reason.
    const PRIOR_V3 = '3';
    await store.record(
      'pkg__1',
      {
        scorable: false,
        reason: 'ungradeable:pytest_missing',
        checkedAt: '2026-05-25T00:00:00Z',
      },
      PRIOR_V3,
    );

    // Build a runner stub keyed on semanticsVersion: under v3 it throws
    // pytest_missing; under v4 (current) it returns passed_match=true,
    // simulating the install-guard providing pytest in-container.
    function makeRunnerForVersion(v: string) {
      return {
        runEval: vi.fn(async () => {
          if (v === EVAL_SEMANTICS_VERSION) {
            return { passed_match: true, passed: ['t::a'], failed: [], log: '', exitCode: 0, imageDigest: 'sha256:' + 'd'.repeat(64) };
          }
          throw Object.assign(new Error('eval could not grade'), { name: 'EvalCouldNotGradeError', reason: 'pytest_missing' });
        }),
      };
    }

    const fetcher = {
      fetchTaskRow: async () => ({
        instance_id: 'pkg__1',
        repo: 'acme/widget',
        image_name: 'acme/widget:latest',
        FAIL_TO_PASS: ['t::a'],
        PASS_TO_PASS: ['t::b'],
        test_patch: 'diff b',
        // The HF row's install does NOT include pytest — pre-#493 this is
        // exactly the shape that triggered ungradeable:pytest_missing.
        install_config: { install: ['pip install -e .'], test_cmd: ['pytest tests/'], log_parser: 'parse_log_pytest' },
      }),
    };
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });

    // Under v3 (pre-#493) the runner throws and the entry stays unscorable.
    const v3Summary = await validatePoolInstances(
      [poolTask('pkg__1')],
      { fetcher, runner: makeRunnerForVersion(PRIOR_V3), store, semanticsVersion: PRIOR_V3, upstreamRepoDir: '/fake/upstream', commandRunner },
      { force: true },
    );
    expect(v3Summary.scorable).toBe(0);
    expect((await store.getEntry('pkg__1', PRIOR_V3))?.reason).toMatch(/pytest_missing/);

    // Under v4 (post-#493) the install-guard provides pytest and the
    // gold-patch eval succeeds. Same gold-patch-resolves admission rule.
    expect(EVAL_SEMANTICS_VERSION).toBe('4');
    const v4Summary = await validatePoolInstances(
      [poolTask('pkg__1')],
      { fetcher, runner: makeRunnerForVersion(EVAL_SEMANTICS_VERSION), store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(v4Summary.scorable).toBe(1);
    const v4Entry = await store.getEntry('pkg__1', EVAL_SEMANTICS_VERSION);
    expect(v4Entry?.scorable).toBe(true);
    expect(v4Entry?.reason).toBe('gold-patch-resolves');

    // The store partitions by semantics version: querying for v3 entries
    // after a v4 record() returns null (the on-disk file was rewritten under
    // v4), which is the expected re-validation behaviour. The "previously
    // unscorable" claim is grounded in the operator's prior reality, not
    // a cross-version on-disk fossil.
    expect(await store.getEntry('pkg__1', PRIOR_V3)).toBeNull();
  });
});

describe('ValidatedPoolStore — targeted v3→v4 carry-forward migration (#493)', () => {
  const SCHEMA = 'swe-rebench-v2-validated-pool.v1';
  function writeV3File(dir: string, entries: Record<string, { scorable: boolean; reason: string; checkedAt: string }>): void {
    writeFileSync(join(dir, 'validated-pool.json'), JSON.stringify({
      schemaVersion: SCHEMA,
      evalSemanticsVersion: '3',
      updatedAt: '2026-05-25T00:00:00Z',
      entries,
    }));
  }

  it('carries forward gold-patch-resolves and gold-patch-not-resolved entries verbatim under v4', async () => {
    const dir = tmpDir();
    writeV3File(dir, {
      scor__1: { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-20T10:00:00Z' },
      unres__1: { scorable: false, reason: 'gold-patch-not-resolved (f2p 1, p2p_broke 0)', checkedAt: '2026-05-20T11:00:00Z' },
    });
    const store = new ValidatedPoolStore({ stateDir: dir });
    expect(await store.getScorableIds('4')).toEqual(new Set(['scor__1']));
    const scor = await store.getEntry('scor__1', '4');
    expect(scor).toMatchObject({ scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-20T10:00:00Z' });
    // The non-resolved verdict is retained too — it can't flip under the install guard.
    const unres = await store.getEntry('unres__1', '4');
    expect(unres).toMatchObject({ scorable: false, reason: 'gold-patch-not-resolved (f2p 1, p2p_broke 0)', checkedAt: '2026-05-20T11:00:00Z' });
  });

  it('drops ungradeable:pytest_missing entries so the validate loop re-processes them under v4', async () => {
    const dir = tmpDir();
    writeV3File(dir, {
      scor__1: { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-20T10:00:00Z' },
      pyt__1: { scorable: false, reason: 'ungradeable:pytest_missing', checkedAt: '2026-05-20T12:00:00Z' },
    });
    const store = new ValidatedPoolStore({ stateDir: dir });
    expect(await store.getEntry('pyt__1', '4')).toBeNull();
    // The carried-forward scorable entry is untouched.
    expect((await store.getEntry('scor__1', '4'))?.scorable).toBe(true);
  });

  it('read-path getScorableEntries / getScorableIds reflect the carried-forward set before any write', async () => {
    const dir = tmpDir();
    writeV3File(dir, {
      scor__1: { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-20T10:00:00Z' },
      scor__2: { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-20T10:05:00Z' },
      pyt__1: { scorable: false, reason: 'ungradeable:pytest_missing', checkedAt: '2026-05-20T12:00:00Z' },
    });
    const store = new ValidatedPoolStore({ stateDir: dir });
    const entries = await store.getScorableEntries('4');
    expect(entries).not.toBeNull();
    expect(new Set(Object.keys(entries!.entries))).toEqual(new Set(['scor__1', 'scor__2']));
    expect(await store.getScorableIds('4')).toEqual(new Set(['scor__1', 'scor__2']));
  });

  it('falls back to a fresh empty pool for an unknown prior version (no defined migration)', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'validated-pool.json'), JSON.stringify({
      schemaVersion: SCHEMA,
      evalSemanticsVersion: '2',
      updatedAt: '2026-05-25T00:00:00Z',
      entries: { scor__1: { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-20T10:00:00Z' } },
    }));
    const store = new ValidatedPoolStore({ stateDir: dir });
    expect(await store.getScorableIds('4')).toBeNull();
    expect(await store.getEntry('scor__1', '4')).toBeNull();
  });

  it('falls back to a fresh empty pool for a wrong schemaVersion', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'validated-pool.json'), JSON.stringify({
      schemaVersion: 'bogus-schema',
      evalSemanticsVersion: '3',
      updatedAt: '2026-05-25T00:00:00Z',
      entries: { scor__1: { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-20T10:00:00Z' } },
    }));
    const store = new ValidatedPoolStore({ stateDir: dir });
    expect(await store.getScorableIds('4')).toBeNull();
    expect(await store.getEntry('scor__1', '4')).toBeNull();
  });

  it('does not re-validate carried-forward terminals: runner fires only for the dropped pytest_missing id', async () => {
    const dir = tmpDir();
    writeV3File(dir, {
      scor__1: { scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-20T10:00:00Z' },
      pyt__1: { scorable: false, reason: 'ungradeable:pytest_missing', checkedAt: '2026-05-20T12:00:00Z' },
    });
    const store = new ValidatedPoolStore({ stateDir: dir });
    const runEval = vi.fn(async () => ({
      passed_match: true, passed: ['t::a'], failed: [], log: '', exitCode: 0, imageDigest: 'sha256:' + 'd'.repeat(64),
    }));
    const fetcher = {
      fetchTaskRow: async (a: { instance_id: string }) => ({
        instance_id: a.instance_id, repo: 'acme/widget', image_name: 'acme/widget:latest',
        FAIL_TO_PASS: ['t::a'], PASS_TO_PASS: ['t::b'], test_patch: 'tp',
        install_config: { install: ['pip install -e .'], test_cmd: ['pytest tests/'], log_parser: 'parse_log_pytest' },
      }),
    };
    const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });
    const summary = await validatePoolInstances(
      [poolTask('scor__1'), poolTask('pyt__1')],
      { fetcher, runner: { runEval }, store, semanticsVersion: '4', upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    // scor__1 carried forward → skipped; pyt__1 dropped → re-validated (gold + discrimination).
    expect(runEval).toHaveBeenCalledTimes(2);
    expect(runEval.mock.calls.every(([a]) => (a as { instance_id: string }).instance_id === 'pyt__1')).toBe(true);
    expect(summary.checked).toBe(1);
    expect((await store.getEntry('scor__1', '4'))?.reason).toBe('gold-patch-resolves');
    expect((await store.getEntry('pyt__1', '4'))?.scorable).toBe(true);
  });
});

describe('isPublicationStale + readVettedPoolArtifactPublicationUnfiltered (#796)', () => {
  function makeArtifact(version: string) {
    return parseVettedPoolArtifact({
      schemaVersion: 'swe-rebench-v2-vetted-pool.v1',
      evalSemanticsVersion: version,
      generatedAt: '2026-05-25T00:00:00Z',
      entries: [
        { instance_id: 'a__1', scorable: true, reason: 'gold-patch-resolves', checkedAt: '2026-05-25T00:00:00Z' },
      ],
    });
  }

  it('isPublicationStale returns false for a null publication (no publication ≠ stale publication)', () => {
    expect(isPublicationStale(null, EVAL_SEMANTICS_VERSION)).toBe(false);
  });

  it('isPublicationStale returns true when ref.evalSemanticsVersion differs from current', async () => {
    const dir = tmpDir();
    const artifact = makeArtifact('3');
    const ref = createVettedPoolArtifactRef({
      manifestCid: 'bafy-test',
      artifactCid: 'bafkrei-test',
      artifactHash: hashVettedPoolArtifact(artifact),
      evalSemanticsVersion: '3',
      publishedAt: '2026-05-25T00:00:00Z',
    });
    await writeVettedPoolArtifactPublication({ stateDir: dir, ref, artifact });
    const pub = await readVettedPoolArtifactPublicationUnfiltered({ stateDir: dir });
    expect(pub).not.toBeNull();
    expect(isPublicationStale(pub, '4')).toBe(true);
    expect(isPublicationStale(pub, '3')).toBe(false);
  });

  it('readVettedPoolArtifactPublicationUnfiltered returns the publication regardless of version mismatch', async () => {
    const dir = tmpDir();
    const artifact = makeArtifact('3');
    const ref = createVettedPoolArtifactRef({
      manifestCid: 'bafy-test',
      artifactCid: 'bafkrei-test',
      artifactHash: hashVettedPoolArtifact(artifact),
      evalSemanticsVersion: '3',
      publishedAt: '2026-05-25T00:00:00Z',
    });
    await writeVettedPoolArtifactPublication({ stateDir: dir, ref, artifact });
    const pub = await readVettedPoolArtifactPublicationUnfiltered({ stateDir: dir });
    expect(pub?.ref.evalSemanticsVersion).toBe('3');
  });
});

describe('validatePoolInstances — base_commit sentinel alignment', () => {
  it('uses the 40-hex sentinel when PoolTask.base_commit is undefined', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await validatePoolInstances(
      [poolTask('a__nobase', { base_commit: undefined })],
      {
        fetcher: {
          fetchTaskRow: async () => ({
            instance_id: 'a__nobase', repo: 'r', image_name: 'img:latest',
            FAIL_TO_PASS: ['t::a'], PASS_TO_PASS: ['t::b'], test_patch: 'tp',
            install_config: { install: ['x'], test_cmd: ['y'], log_parser: 'parse_log_pytest' },
          }),
        },
        runner: { runEval: async () => ({ passed_match: true, passed: ['t::a'], failed: [], log: '', exitCode: 0 }) },
        store,
        semanticsVersion: EVAL_SEMANTICS_VERSION,
        upstreamRepoDir: '/fake',
        commandRunner: async (bin, args) => {
          if (bin === 'docker') return { exitCode: 0, stdout: '["img@sha256:' + 'a'.repeat(64) + '"]', stderr: '' };
          if (bin === 'git') return { exitCode: 0, stdout: '0'.repeat(40) + '\n', stderr: '' };
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      },
    );
    const entry = await store.getEntry('a__nobase', EVAL_SEMANTICS_VERSION);
    // The entry must have been persisted.
    expect(entry?.rowHash).toBeDefined();
    // Recomputing with the sentinel must reproduce the stored hash.
    // If the fallback had used '' instead, this would produce a different hash.
    // repo: validatePoolInstances uses task.repo ?? row.repo; poolTask defaults to 'acme/widget'.
    const expected = computeRowHash({
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      instance_id: 'a__nobase',
      repo: 'acme/widget',
      base_commit: '0000000000000000000000000000000000000000',
      image_name: 'img:latest',
      patch: poolTask('a__nobase').patch!,
      test_patch: 'tp',
      install_config: { install: ['x'], test_cmd: ['y'], log_parser: 'parse_log_pytest' },
      FAIL_TO_PASS: ['t::a'],
      PASS_TO_PASS: ['t::b'],
    });
    expect(entry?.rowHash).toBe(expected);
  });
});

describe('validatePoolInstances — transient HF 429 handling', () => {
  function makeTransientFetcher() {
    return {
      fetchTaskRow: vi.fn(async () => {
        throw Object.assign(
          new Error('HF datasets-server returned 429 for nebius/SWE-rebench-leaderboard/2026_02'),
          { httpStatus: 429 },
        );
      }),
    };
  }
  function noopRunner() {
    return { runEval: vi.fn(async () => ({ passed_match: true, passed: [], failed: [], log: '', exitCode: 0 })) };
  }
  // Minimal stub: docker/git fail. The transient catch-block fires before substrate resolution
  // anyway because fetchTaskRow throws first, so the commandRunner doesn't matter much.
  const commandRunner = async () => ({ exitCode: 1, stdout: '', stderr: '' });

  it('records transient:HF-429:<msg> with transientRetryCount=1 on first pass', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const fetcher = makeTransientFetcher();
    const summary = await validatePoolInstances(
      [poolTask('a__429')],
      { fetcher, runner: noopRunner(), store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary).toMatchObject({ checked: 1, scorable: 0, unscorable: 1 });
    const entry = await store.getEntry('a__429', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: false,
      reason:
        'transient:HF-429:HF datasets-server returned 429 for nebius/SWE-rebench-leaderboard/2026_02',
      transientRetryCount: 1,
    });
    expect(typeof entry?.lastTransientAt).toBe('string');
    // Sanity: lastTransientAt is an ISO timestamp.
    expect(entry?.lastTransientAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('re-processes a transient entry on the next pass (skip-check does NOT fire) and increments transientRetryCount', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const fetcher = makeTransientFetcher();
    // First pass.
    await validatePoolInstances(
      [poolTask('a__429')],
      { fetcher, runner: noopRunner(), store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect((await store.getEntry('a__429', EVAL_SEMANTICS_VERSION))?.transientRetryCount).toBe(1);
    // Second pass — no force.
    const summary2 = await validatePoolInstances(
      [poolTask('a__429')],
      { fetcher, runner: noopRunner(), store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary2.checked).toBe(1);
    expect(fetcher.fetchTaskRow).toHaveBeenCalledTimes(2);
    expect((await store.getEntry('a__429', EVAL_SEMANTICS_VERSION))?.transientRetryCount).toBe(2);
  });

  it('boundary count=4 → 5: flips to terminal reason error:HF-429-permanent-after-5-passes', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    // Seed the store with a pre-existing transient entry at count=4.
    await store.record(
      'a__429',
      {
        scorable: false,
        reason: 'transient:HF-429:prior',
        checkedAt: '2026-05-25T00:00:00Z',
        transientRetryCount: 4,
        lastTransientAt: '2026-05-25T00:00:00Z',
      },
      EVAL_SEMANTICS_VERSION,
    );
    const fetcher = makeTransientFetcher();
    await validatePoolInstances(
      [poolTask('a__429')],
      { fetcher, runner: noopRunner(), store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    const entry = await store.getEntry('a__429', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: false,
      reason: 'error:HF-429-permanent-after-5-passes',
      transientRetryCount: 5,
    });
    expect(fetcher.fetchTaskRow).toHaveBeenCalledTimes(1);
  });

  it('boundary count=5: skip-check fires (terminal) — fetcher is not called, entry unchanged', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record(
      'a__429',
      {
        scorable: false,
        reason: 'error:HF-429-permanent-after-5-passes',
        checkedAt: '2026-05-25T00:00:00Z',
        transientRetryCount: 5,
        lastTransientAt: '2026-05-25T00:00:00Z',
      },
      EVAL_SEMANTICS_VERSION,
    );
    const fetcher = makeTransientFetcher();
    const summary = await validatePoolInstances(
      [poolTask('a__429')],
      { fetcher, runner: noopRunner(), store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary.checked).toBe(0);
    expect(fetcher.fetchTaskRow).not.toHaveBeenCalled();
    const entry = await store.getEntry('a__429', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: false,
      reason: 'error:HF-429-permanent-after-5-passes',
      transientRetryCount: 5,
    });
  });
});

describe('validatePoolInstances — populates substrate fields', () => {
  it('records rowHash, imageName, imageDigest, upstreamEvalCommit on a successful validation', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const summary = await validatePoolInstances(
      [poolTask('a__1')],
      {
        fetcher: {
          fetchTaskRow: async () => ({
            instance_id: 'a__1',
            repo: 'acme/widget',
            image_name: 'acme/widget:latest',
            FAIL_TO_PASS: ['t::a'],
            PASS_TO_PASS: ['t::b'],
            test_patch: 'diff b',
            install_config: { install: ['pip install .'], test_cmd: ['pytest'], log_parser: 'parse_log_pytest' },
          }),
        },
        runner: {
          runEval: async () => ({ passed_match: true, passed: ['t::a'], failed: [], log: '', exitCode: 0 }),
        },
        store,
        semanticsVersion: EVAL_SEMANTICS_VERSION,
        upstreamRepoDir: '/fake/upstream',
        commandRunner: async (bin, args) => {
          if (bin === 'docker' && args[0] === 'image') {
            return { exitCode: 0, stdout: '["acme/widget@sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]', stderr: '' };
          }
          if (bin === 'git' && args[0] === 'rev-parse') {
            return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: 'unexpected' };
        },
      },
    );
    expect(summary.scorable).toBe(1);
    const entry = await store.getEntry('a__1', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: true,
      imageName: 'acme/widget:latest',
      imageDigest: 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      upstreamEvalCommit: '0123456789abcdef0123456789abcdef01234567',
    });
    expect(entry!.rowHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('uses the runner-carried imageDigest when cleanup pruned the local image before post-eval inspection', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const carriedDigest = 'sha256:' + 'f'.repeat(64);

    const summary = await validatePoolInstances(
      [poolTask('a__1')],
      {
        fetcher: {
          fetchTaskRow: async () => ({
            instance_id: 'a__1',
            repo: 'acme/widget',
            image_name: 'acme/widget:latest',
            FAIL_TO_PASS: ['t::a'],
            PASS_TO_PASS: ['t::b'],
            test_patch: 'diff b',
            install_config: { install: ['pip install .'], test_cmd: ['pytest'], log_parser: 'parse_log_pytest' },
          }),
        },
        runner: {
          runEval: async () => ({
            passed_match: true,
            passed: ['t::a'],
            failed: [],
            log: '',
            exitCode: 0,
            imageDigest: carriedDigest,
          }),
        },
        store,
        semanticsVersion: EVAL_SEMANTICS_VERSION,
        upstreamRepoDir: '/fake/upstream',
        commandRunner: async (bin, args) => {
          if (bin === 'docker' && args[0] === 'image') {
            return { exitCode: 1, stdout: '', stderr: 'No such image: acme/widget:latest' };
          }
          if (bin === 'git' && args[0] === 'rev-parse') {
            return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
          }
          return { exitCode: 1, stdout: '', stderr: 'unexpected' };
        },
      },
    );

    expect(summary).toMatchObject({ checked: 1, scorable: 1, unscorable: 0 });
    const entry = await store.getEntry('a__1', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: true,
      reason: 'gold-patch-resolves',
      imageName: 'acme/widget:latest',
      imageDigest: carriedDigest,
    });
  });

  it('records the entry as unscorable when imageDigest cannot be resolved (required mode)', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    await validatePoolInstances(
      [poolTask('a__1')],
      {
        fetcher: {
          fetchTaskRow: async () => ({
            instance_id: 'a__1', repo: 'acme/widget', image_name: 'acme/widget:latest',
            FAIL_TO_PASS: ['t::a'], PASS_TO_PASS: ['t::b'], test_patch: 'diff b',
            install_config: { install: ['pip install .'], test_cmd: ['pytest'], log_parser: 'parse_log_pytest' },
          }),
        },
        runner: { runEval: async () => ({ passed_match: true, passed: ['t::a'], failed: [], log: '', exitCode: 0 }) },
        store,
        semanticsVersion: EVAL_SEMANTICS_VERSION,
        upstreamRepoDir: '/fake/upstream',
        commandRunner: async (bin, args) => {
          if (bin === 'docker') return { exitCode: 1, stdout: '', stderr: 'no such image' };
          if (bin === 'git') return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
          return { exitCode: 1, stdout: '', stderr: '' };
        },
      },
    );
    const entry = await store.getEntry('a__1', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({ scorable: false, reason: 'unresolvable-image-digest' });
    expect(entry!.rowHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry!.imageName).toBe('acme/widget:latest');
    expect(entry!.upstreamEvalCommit).toBe('0123456789abcdef0123456789abcdef01234567');
  });
});

describe('validatePoolInstances — transient operator-environment infra handling (#811)', () => {
  // Fetcher succeeds (the row resolves); the runner throws an
  // EvalCouldNotGradeError so the eval never grades the solution. Constructed
  // the same duck-typed way the existing ungradeable test does (line ~216):
  // the catch-block classifier keys on `err.name === 'EvalCouldNotGradeError'`.
  function makeInfraFetcher() {
    return {
      fetchTaskRow: vi.fn(async (a: { instance_id: string }) => ({
        instance_id: a.instance_id, repo: 'acme/widget', image_name: 'acme/widget:latest',
        FAIL_TO_PASS: ['t::a'], PASS_TO_PASS: ['t::b'], test_patch: 'diff b',
        install_config: { install: ['pip install .'], test_cmd: ['pytest'], log_parser: 'parse_log_pytest' },
      })),
    };
  }
  function ungradeableRunner(reason: string) {
    return {
      runEval: vi.fn(async () => {
        throw Object.assign(new Error(`eval could not grade (${reason})`), {
          name: 'EvalCouldNotGradeError',
          reason,
        });
      }),
    };
  }
  // docker succeeds (digest resolves), git fails (upstreamEvalCommit omitted, non-fatal).
  const commandRunner = async (bin: string, args: string[]) => {
    if (bin === 'docker' && args[0] === 'image') {
      return { exitCode: 0, stdout: '["acme/widget@sha256:' + 'a'.repeat(64) + '"]', stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: '' };
  };

  it('TRANSIENT_INFRA_REASONS has exactly the operator-environment infra subset', () => {
    expect(TRANSIENT_INFRA_REASONS).toEqual(
      new Set(['docker_unavailable', 'venv_collision', 'venv_missing', 'image_arch_mismatch']),
    );
    // Real per-instance ungradeable reasons must NOT be in the transient set.
    expect(TRANSIENT_INFRA_REASONS.has('pytest_missing')).toBe(false);
    expect(TRANSIENT_INFRA_REASONS.has('install_build_failed')).toBe(false);
    expect(TRANSIENT_INFRA_REASONS.has('conftest_import_error')).toBe(false);
    expect(TRANSIENT_INFRA_REASONS.has('eval_setup_error')).toBe(false);
  });

  it('docker_unavailable records transient:docker_unavailable with transientRetryCount=1 (not terminal)', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const fetcher = makeInfraFetcher();
    const runner = ungradeableRunner('docker_unavailable');
    const summary = await validatePoolInstances(
      [poolTask('a__docker')],
      { fetcher, runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary).toMatchObject({ checked: 1, scorable: 0, unscorable: 1 });
    const entry = await store.getEntry('a__docker', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({
      scorable: false,
      reason: 'transient:docker_unavailable',
      transientRetryCount: 1,
    });
    expect(typeof entry?.lastTransientAt).toBe('string');
    expect(entry?.lastTransientAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Substrate fields are available because the fetcher succeeded before the runner threw.
    expect(entry?.rowHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(entry?.imageName).toBe('acme/widget:latest');
  });

  it('re-processes a transient infra entry on the next pass (skip-check does NOT fire) and increments the count', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const fetcher = makeInfraFetcher();
    const runner = ungradeableRunner('docker_unavailable');
    await validatePoolInstances(
      [poolTask('a__docker')],
      { fetcher, runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect((await store.getEntry('a__docker', EVAL_SEMANTICS_VERSION))?.transientRetryCount).toBe(1);
    // Second pass — no force. The idempotence guard must NOT skip a transient entry below the boundary.
    const summary2 = await validatePoolInstances(
      [poolTask('a__docker')],
      { fetcher, runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary2.checked).toBe(1);
    expect(runner.runEval).toHaveBeenCalledTimes(2);
    expect((await store.getEntry('a__docker', EVAL_SEMANTICS_VERSION))?.transientRetryCount).toBe(2);
  });

  it(`converges to terminal ungradeable:docker_unavailable at count=${MAX_TRANSIENT_PASSES}; a subsequent pass then skips`, async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    // Seed a transient entry one below the convergence boundary.
    await store.record(
      'a__docker',
      {
        scorable: false,
        reason: 'transient:docker_unavailable',
        checkedAt: '2026-05-27T00:00:00Z',
        transientRetryCount: MAX_TRANSIENT_PASSES - 1,
        lastTransientAt: '2026-05-27T00:00:00Z',
      },
      EVAL_SEMANTICS_VERSION,
    );
    const fetcher = makeInfraFetcher();
    const runner = ungradeableRunner('docker_unavailable');
    await validatePoolInstances(
      [poolTask('a__docker')],
      { fetcher, runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    const converged = await store.getEntry('a__docker', EVAL_SEMANTICS_VERSION);
    // Final resting state is identical to today's immediate behaviour, just reached after bounded retries.
    expect(converged).toMatchObject({
      scorable: false,
      reason: 'ungradeable:docker_unavailable',
      transientRetryCount: MAX_TRANSIENT_PASSES,
    });
    expect(runner.runEval).toHaveBeenCalledTimes(1);
    // A subsequent non-force pass now skips it (terminal).
    const summary = await validatePoolInstances(
      [poolTask('a__docker')],
      { fetcher, runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary.checked).toBe(0);
    expect(runner.runEval).toHaveBeenCalledTimes(1);
  });

  it('install_build_failed stays terminal ungradeable:install_build_failed and a non-force pass skips it', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const fetcher = makeInfraFetcher();
    const runner = ungradeableRunner('install_build_failed');
    await validatePoolInstances(
      [poolTask('a__build')],
      { fetcher, runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    const entry = await store.getEntry('a__build', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({ scorable: false, reason: 'ungradeable:install_build_failed' });
    expect(entry?.transientRetryCount).toBeUndefined();
    expect(runner.runEval).toHaveBeenCalledTimes(1);
    // Second non-force pass skips it — terminal.
    const summary2 = await validatePoolInstances(
      [poolTask('a__build')],
      { fetcher, runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary2.checked).toBe(0);
    expect(runner.runEval).toHaveBeenCalledTimes(1);
  });

  it('pytest_missing stays terminal (guards the #493 bucket against accidental auto-retry)', async () => {
    const dir = tmpDir();
    const store = new ValidatedPoolStore({ stateDir: dir });
    const fetcher = makeInfraFetcher();
    const runner = ungradeableRunner('pytest_missing');
    await validatePoolInstances(
      [poolTask('a__pytest')],
      { fetcher, runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    const entry = await store.getEntry('a__pytest', EVAL_SEMANTICS_VERSION);
    expect(entry).toMatchObject({ scorable: false, reason: 'ungradeable:pytest_missing' });
    expect(entry?.transientRetryCount).toBeUndefined();
    const summary2 = await validatePoolInstances(
      [poolTask('a__pytest')],
      { fetcher, runner, store, semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir: '/fake/upstream', commandRunner },
    );
    expect(summary2.checked).toBe(0);
    expect(runner.runEval).toHaveBeenCalledTimes(1);
  });
});

describe('vettedPoolRefSemanticsMismatch (gh #300 solver-side ghost-task gate)', () => {
  function ref(evalSemanticsVersion: string): Record<string, unknown> {
    return {
      vettedPoolRef: {
        schemaVersion: SOLVERNET_ARTIFACT_REF_SCHEMA_VERSION,
        artifactType: SWE_REBENCH_V2_VETTED_POOL_ARTIFACT_TYPE,
        manifestCid: 'bafyManifest',
        artifactCid: 'bafyArtifact',
        artifactHash: `sha256:${'a'.repeat(64)}`,
        evalSemanticsVersion,
        publishedAt: '2026-05-29T00:00:00.000Z',
      },
    };
  }

  it('returns null when the ref semantics version matches the local constant', () => {
    expect(vettedPoolRefSemanticsMismatch(ref(EVAL_SEMANTICS_VERSION))).toBeNull();
  });

  it('returns a reason when the ref announces an older semantics version (the observed ghost class)', () => {
    const reason = vettedPoolRefSemanticsMismatch(ref('3'));
    expect(reason).not.toBeNull();
    expect(reason).toContain('evalSemanticsVersion=3');
    expect(reason).toContain(`EVAL_SEMANTICS_VERSION=${EVAL_SEMANTICS_VERSION}`);
  });

  it('fails open (returns null) when no vettedPoolRef is present', () => {
    expect(vettedPoolRefSemanticsMismatch(undefined)).toBeNull();
    expect(vettedPoolRefSemanticsMismatch({})).toBeNull();
    expect(vettedPoolRefSemanticsMismatch({ otherKey: 'x' })).toBeNull();
  });

  it('surfaces a malformed ref as a reason rather than throwing', () => {
    const reason = vettedPoolRefSemanticsMismatch({ vettedPoolRef: { schemaVersion: 'wrong' } });
    expect(reason).not.toBeNull();
    expect(reason).toContain('invalid');
  });
});
