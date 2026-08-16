import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadHeldOutSlate,
  hashHeldOutSlateArtifact,
  parseHeldOutSlateArtifact,
  excludeHeldOutSlate,
  loadActiveHeldOutSlateIds,
  ACTIVE_HELD_OUT_SLATE_VERSIONS,
  HELD_OUT_SLATE_SCHEMA_VERSION,
  type HeldOutSlateArtifact,
} from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';

function poolTask(id: string): PoolTask {
  return {
    instance_id: id,
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: '2025_01',
    repo: 'acme/widget',
    base_commit: 'deadbeef',
    language: 'python',
    patch: 'diff --git a/x.py b/x.py\n',
    test_patch: 'diff --git a/t.py b/t.py\n',
  };
}

// The shipped v1 slate lives next to the loader source.
const SLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'solver-types',
  'slates',
);
const V1_FILE = join(SLATE_DIR, 'held-out-slate.swe-rebench-v2.v1.json');

describe('held-out slate loader (#817 AC#1)', () => {
  it('loads the shipped v1 slate, returning the expected instanceIds set + hash', () => {
    const slate = loadHeldOutSlate('swe-rebench-v2.v1', 'v1');
    expect(slate.version).toBe('v1');
    expect(slate.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // a small fixed N reserved from the pool
    expect(slate.instanceIds.size).toBeGreaterThanOrEqual(5);
    expect(slate.instanceIds.size).toBeLessThanOrEqual(20);
    // a known reserved instance is present, and these are real ids
    expect(slate.instanceIds.has('pandas-dev__pandas-60736')).toBe(true);

    // hash is the content hash of the on-disk artifact
    const raw = JSON.parse(readFileSync(V1_FILE, 'utf8')) as Record<string, unknown>;
    expect(slate.hash).toBe(hashHeldOutSlateArtifact(parseHeldOutSlateArtifact(raw)));
    // the declared `hash` field matches the recomputed hash
    expect(raw['hash']).toBe(slate.hash);
  });
});

describe('validated clean v3 pilot slate', () => {
  it('ships 24 unique content-addressed tasks and activates them for train exclusion', () => {
    expect(ACTIVE_HELD_OUT_SLATE_VERSIONS).toEqual(['v1', 'v2', 'v3']);
    const slate = loadHeldOutSlate('swe-rebench-v2.v1', 'v3');
    expect(slate.instanceIds.size).toBe(24);
    const active = loadActiveHeldOutSlateIds(
      'swe-rebench-v2.v1',
      ACTIVE_HELD_OUT_SLATE_VERSIONS,
    );
    expect(active.has([...slate.instanceIds][0]!)).toBe(true);
  });
});

describe('held-out slate content-addressing (#817 AC#1)', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Drive the real loader against a temp slates dir (via opts.dir) so the
  // fail-loud throw inside loadHeldOutSlate is exercised, not re-implemented
  // inline. This guards against accidental edit-without-rehash drift, not
  // adversarial tampering — the declared hash lives in the same file (see the
  // module header).
  it('recomputed hash diverges when instanceIds are mutated without re-deriving', () => {
    const raw = JSON.parse(readFileSync(V1_FILE, 'utf8')) as Record<string, unknown>;
    const artifact = parseHeldOutSlateArtifact(raw);
    const declared = raw['hash'] as string;
    const tampered: HeldOutSlateArtifact = {
      ...artifact,
      instanceIds: [...artifact.instanceIds, 'attacker__injected-9999'],
    };
    expect(hashHeldOutSlateArtifact(tampered)).not.toBe(declared);
  });

  it('throws when an on-disk artifact was edited without rehashing', () => {
    // Stand up a throwaway slate file with a stale declared hash, then point the
    // real loader at it via opts.dir so its hash-mismatch throw is executed.
    const dir = mkdtempSync(join(tmpdir(), 'slate-tamper-'));
    tmps.push(dir);
    const artifact: HeldOutSlateArtifact = {
      schemaVersion: HELD_OUT_SLATE_SCHEMA_VERSION,
      solverType: 'swe-rebench-v2.v1',
      version: 'v9',
      generatedAt: '2026-05-28T00:00:00.000Z',
      instanceIds: ['a__b-1', 'c__d-2'],
    };
    const goodHash = hashHeldOutSlateArtifact(artifact);
    const file = join(dir, 'held-out-slate.swe-rebench-v2.v9.json');
    // edited: extra instance id but the old (now-stale) declared hash
    writeFileSync(
      file,
      JSON.stringify({ ...artifact, hash: goodHash, instanceIds: [...artifact.instanceIds, 'x__y-3'] }),
    );
    expect(() => loadHeldOutSlate('swe-rebench-v2.v1', 'v9', { dir })).toThrow('hash mismatch');
  });
});

describe('held-out slate version discipline (#817 AC#3)', () => {
  it('surfaces the slate version as the comparison key', () => {
    expect(loadHeldOutSlate('swe-rebench-v2.v1', 'v1').version).toBe('v1');
  });

  it('throws for a non-existent version (scores compared only within a version)', () => {
    expect(() => loadHeldOutSlate('swe-rebench-v2.v1', 'v999')).toThrow();
  });
});

describe('held-out slate loader hardening (#817 L2)', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('rejects a free-form version that is not /^v\\d+$/', () => {
    // Closes a latent path-traversal-shaped concern: a future orchestrator that
    // forwards a free-form version must not be able to escape the slates dir.
    expect(() => loadHeldOutSlate('swe-rebench-v2.v1', '../etc')).toThrow('version must match');
    expect(() => loadHeldOutSlate('swe-rebench-v2.v1', 'latest')).toThrow('version must match');
  });

  it('throws when the on-disk solverType does not match the requested one', () => {
    // Stand up a throwaway slate file whose basename matches a `wrong-solver`
    // request but whose declared solverType is something else, then point the
    // real loader at it via opts.dir so its solverType-mismatch throw runs.
    const dir = mkdtempSync(join(tmpdir(), 'slate-solvertype-'));
    tmps.push(dir);
    const artifact: HeldOutSlateArtifact = {
      schemaVersion: HELD_OUT_SLATE_SCHEMA_VERSION,
      solverType: 'swe-rebench-v2.v1',
      version: 'v1',
      generatedAt: '2026-05-28T00:00:00.000Z',
      instanceIds: ['a__b-1'],
    };
    // File basename derives from the requested solverType ('wrong-solver.v1'),
    // so the loader finds it — but the declared solverType inside is different.
    const file = join(dir, 'held-out-slate.wrong-solver.v1.json');
    writeFileSync(file, JSON.stringify({ ...artifact, hash: hashHeldOutSlateArtifact(artifact) }));
    expect(() => loadHeldOutSlate('wrong-solver.v1', 'v1', { dir })).toThrow(
      'solverType mismatch',
    );
  });
});

describe('held-out slate generator exclusion (#817 AC#2)', () => {
  it('drops slate instance_ids from the eligible pool while non-slate ids survive', () => {
    const slate = loadHeldOutSlate('swe-rebench-v2.v1', 'v1');
    const slateId = [...slate.instanceIds][0]!;
    const pool = [poolTask(slateId), poolTask('not-in__slate-1')];

    const eligible = excludeHeldOutSlate(pool, slate.instanceIds);

    expect(eligible.map((t) => t.instance_id)).toEqual(['not-in__slate-1']);
    expect(eligible.some((t) => slate.instanceIds.has(t.instance_id))).toBe(false);
  });

  it('passes through unchanged when the slate is empty', () => {
    const pool = [poolTask('a__b-1'), poolTask('c__d-2')];
    expect(excludeHeldOutSlate(pool, new Set())).toEqual(pool);
  });
});
