import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import solverNetsCommand from '../../src/cli/commands/solver-nets.js';
import { makeCommandCtx } from '../_support/cli.js';
import { EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';

const tmps: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'validate-pool-report-cli-'));
  tmps.push(d);
  return d;
}

function seedValidatedPool(dir: string, entries: Record<string, { scorable: boolean; reason: string }>): void {
  writeFileSync(join(dir, 'validated-pool.json'), JSON.stringify({
    schemaVersion: 'swe-rebench-v2-validated-pool.v1',
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
    updatedAt: '2026-05-25T00:00:00Z',
    entries: Object.fromEntries(
      Object.entries(entries).map(([id, e]) => [id, { ...e, checkedAt: '2026-05-25T00:00:00Z' }]),
    ),
  }));
}

/**
 * `solver-nets` falls back to `~/.jinn-operator/config.json` when no `--config` is passed, and
 * hands that path to `loadConfig` as an EXPLICIT path — which throws when the file is absent.
 * These tests exercise that fallback, so they used to pass only because the developer running
 * them happened to have a real operator config in their home directory; on a clean machine
 * they failed. Home is now isolated per worker (test/_support/isolate-home.ts), so the
 * fallback config is seeded there deterministically instead.
 */
beforeAll(() => {
  mkdirSync(join(homedir(), '.jinn-operator'), { recursive: true });
  writeFileSync(
    join(homedir(), '.jinn-operator', 'config.json'),
    JSON.stringify({ network: 'testnet' }),
  );
});

/** loadConfig reads process.env for JINN_SWE_REBENCH_V2_STATE_DIR (#1000). */
function withSweStateDirEnv(dir: string): () => void {
  const prev = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'];
  process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] = dir;
  return () => {
    if (prev === undefined) delete process.env['JINN_SWE_REBENCH_V2_STATE_DIR'];
    else process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] = prev;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('solver-nets validate-pool-report', () => {
  it('emits a JSON envelope with totalEntries/scorable/unscorable and a descending-sorted byReason histogram', async () => {
    const dir = tmpDir();
    seedValidatedPool(dir, {
      'a__1': { scorable: true, reason: 'gold-patch-resolves' },
      'a__2': { scorable: true, reason: 'gold-patch-resolves' },
      'a__3': { scorable: false, reason: 'ungradeable:pytest_missing' },
      'a__4': { scorable: false, reason: 'ungradeable:pytest_missing' },
      'a__5': { scorable: false, reason: 'ungradeable:pytest_missing' },
      'a__6': { scorable: false, reason: 'gold-patch-not-resolved (f2p 1, p2p_broke 0)' },
    });
    const restore = withSweStateDirEnv(dir);
    try {
      const made = makeCommandCtx({
        argv: ['validate-pool-report', 'swe-rebench-v2', '--json'],
      });
      await solverNetsCommand.run(made.ctx);
      expect(made.exits).toEqual([]);
      const envelope = JSON.parse(made.writes.join('').trim()) as Record<string, unknown>;
      expect(envelope['verb']).toBe('solver-nets validate-pool-report');
      expect(envelope['solverNet']).toBe('swe-rebench-v2');
      expect(envelope['evalSemanticsVersion']).toBe(EVAL_SEMANTICS_VERSION);
      expect(envelope['totalEntries']).toBe(6);
      expect(envelope['scorable']).toBe(2);
      expect(envelope['unscorable']).toBe(4);
      expect(envelope['byReason']).toEqual([
        { reason: 'ungradeable:pytest_missing', count: 3 },
        { reason: 'gold-patch-not-resolved', count: 1 },
        { reason: 'gold-patch-resolves', count: 2 },
      ].sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason)));
    } finally {
      restore();
    }
  });

  it('--human renders a histogram and names the highest-yield unscorable blocker', async () => {
    const dir = tmpDir();
    seedValidatedPool(dir, {
      'a__1': { scorable: true, reason: 'gold-patch-resolves' },
      'a__2': { scorable: false, reason: 'ungradeable:pytest_missing' },
      'a__3': { scorable: false, reason: 'ungradeable:pytest_missing' },
      'a__4': { scorable: false, reason: 'ungradeable:pytest_missing' },
      'a__5': { scorable: false, reason: 'gold-patch-not-resolved (f2p 1, p2p_broke 0)' },
    });
    const restore = withSweStateDirEnv(dir);
    try {
      const made = makeCommandCtx({
        argv: ['validate-pool-report', 'swe-rebench-v2', '--human'],
      });
      await solverNetsCommand.run(made.ctx);
      expect(made.exits).toEqual([]);
      const out = made.writes.join('');
      expect(out).toMatch(/total entries:\s*5/i);
      expect(out).toMatch(/scorable:\s*1/i);
      expect(out).toMatch(/unscorable:\s*4/i);
      // The histogram lines name each bucket with its count.
      expect(out).toContain('ungradeable:pytest_missing');
      expect(out).toContain('gold-patch-not-resolved');
      expect(out).toContain('gold-patch-resolves');
      // The highest-yield unscorable blocker is called out by name.
      expect(out).toMatch(/highest[- ]yield.*ungradeable:pytest_missing/i);
    } finally {
      restore();
    }
  });

  it('--human surfaces the p2p-broke split and names it as a candidate capacity blocker (#806)', async () => {
    const dir = tmpDir();
    seedValidatedPool(dir, {
      'a__1': { scorable: true, reason: 'gold-patch-resolves' },
      // p2p intact — genuinely-hard / mislabeled, leave alone.
      'a__2': { scorable: false, reason: 'gold-patch-not-resolved (f2p 1, p2p_broke 0)' },
      // p2p broke — environment problem, chase-able capacity blocker.
      'a__3': { scorable: false, reason: 'gold-patch-not-resolved (f2p 0, p2p_broke 53)' },
      'a__4': { scorable: false, reason: 'gold-patch-not-resolved (f2p 0, p2p_broke 7)' },
    });
    const restore = withSweStateDirEnv(dir);
    try {
      const made = makeCommandCtx({
        argv: ['validate-pool-report', 'swe-rebench-v2', '--human'],
      });
      await solverNetsCommand.run(made.ctx);
      expect(made.exits).toEqual([]);
      const out = made.writes.join('');
      // The two shapes appear in distinct histogram buckets.
      expect(out).toContain('gold-patch-not-resolved:p2p-broke');
      expect(out).toContain('gold-patch-not-resolved');
      // The p2p-broke count is called out as a candidate (recoverable) capacity blocker.
      expect(out).toMatch(/capacity blocker/i);
      expect(out).toMatch(/2\b/); // the 2 p2p-broke entries
      expect(out).toMatch(/environment/i);
    } finally {
      restore();
    }
  });

  it('--human omits the p2p-broke capacity-blocker callout when no entries broke PASS_TO_PASS (#806)', async () => {
    const dir = tmpDir();
    seedValidatedPool(dir, {
      'a__1': { scorable: true, reason: 'gold-patch-resolves' },
      'a__2': { scorable: false, reason: 'gold-patch-not-resolved (f2p 1, p2p_broke 0)' },
    });
    const restore = withSweStateDirEnv(dir);
    try {
      const made = makeCommandCtx({
        argv: ['validate-pool-report', 'swe-rebench-v2', '--human'],
      });
      await solverNetsCommand.run(made.ctx);
      expect(made.exits).toEqual([]);
      const out = made.writes.join('');
      expect(out).not.toContain('gold-patch-not-resolved:p2p-broke');
      expect(out).not.toMatch(/capacity blocker/i);
    } finally {
      restore();
    }
  });

  it('uses seeded cache membership without calling a live loader that would succeed', async () => {
    const dir = tmpDir();
    seedValidatedPool(dir, {
      'in-pool__1': { scorable: true, reason: 'gold-patch-resolves' },
      'orphan__1': { scorable: true, reason: 'gold-patch-resolves' },
    });
    writeFileSync(join(dir, 'pool-cache.json'), JSON.stringify({
      schemaVersion: 'swe-rebench-v2-pool-cache.v1',
      savedAt: '2026-05-25T00:00:00Z',
      tasks: [{
        instance_id: 'in-pool__1',
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: 'test',
        repo: 'acme/widget',
        patch: 'gold',
        test_patch: 'test',
        language: 'python',
      }],
    }));
    const liveFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/splits?')) {
        return new Response(JSON.stringify({ splits: [{ split: '2026_01' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        rows: [{
          row: {
            instance_id: 'live-only__1',
            repo: 'live/repo',
            base_commit: 'abc123',
            language: 'python',
            patch: 'live gold',
            test_patch: 'live test',
          },
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', liveFetch);
    const restore = withSweStateDirEnv(dir);
    try {
      const made = makeCommandCtx({
        argv: ['validate-pool-report', 'swe-rebench-v2', '--json'],
      });
      await solverNetsCommand.run(made.ctx);
      expect(made.exits).toEqual([]);
      const envelope = JSON.parse(made.writes.join('').trim()) as Record<string, unknown>;
      const weakSuite = envelope['weakSuite'] as { unchecked: { backlog: number; orphaned: number } };
      expect(weakSuite.unchecked).toEqual({ backlog: 1, orphaned: 1 });
      expect(liveFetch).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('fails cleanly with a "stale" / "absent" message when validated-pool.json is missing', async () => {
    const dir = tmpDir(); // empty
    const restore = withSweStateDirEnv(dir);
    try {
      const made = makeCommandCtx({
        argv: ['validate-pool-report', 'swe-rebench-v2', '--json'],
      });
      await solverNetsCommand.run(made.ctx);
      expect(made.exits).toEqual([1]);
      const envelope = JSON.parse(made.writes.join('').trim()) as Record<string, unknown>;
      const error = envelope['error'] as { message?: string } | undefined;
      expect(error?.message).toMatch(/absent|stale/i);
    } finally {
      restore();
    }
  });

  it('rejects an unknown solver-type positional', async () => {
    const made = makeCommandCtx({
      argv: ['validate-pool-report', 'prediction.v1', '--json'],
      env: {},
    });
    await solverNetsCommand.run(made.ctx);
    expect(made.exits).toEqual([1]);
    const envelope = JSON.parse(made.writes.join('').trim()) as Record<string, unknown>;
    const error = envelope['error'] as { message?: string } | undefined;
    expect(error?.message).toMatch(/swe-rebench-v2/);
  });
});
