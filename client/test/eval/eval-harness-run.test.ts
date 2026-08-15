import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveRuntimePluginsForSolverType,
  runHarnessForEval,
} from '@/eval/eval-harness-run.js';
import type { Harness, HarnessContext } from '@/harnesses/types.js';
import type { Task } from '@/types/task.js';
import type { ExecutionWiringConfigEntry } from '@/config/shape-v2.js';
import { resolveSweLearnerPluginRoots } from '../e2e/fixtures/swe-rebench-v2-learner-e2e.js';

/** Real impl-state dir — the freeze-fence hashes it even in train mode. */
const implStateDirs: string[] = [];
function freshImplStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-test-impl-'));
  implStateDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of implStateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JOINED_SWE: ExecutionWiringConfigEntry[] = [{
  workKind: 'swe-rebench-v2.v1',
  harness: 'claude-code',
  model: 'claude-haiku-4-5-20251001',
  plugins: [],
  credentialRef: 'claude-code-default',
  isolationPolicy: 'process',
}];

const TASK: Task = {
  id: 'swe-task-1',
  description: 'fix the bug',
  role: 'restoration',
  solverType: 'swe-rebench-v2.v1',
  spec: {},
  window: { startTs: 0, endTs: Date.now() + 3_600_000 },
};

describe('resolveRuntimePluginsForSolverType', () => {
  it('resolves the SolverNet runtime plugins for a joined swe-rebench-v2 net', async () => {
    const plugins = await resolveRuntimePluginsForSolverType('swe-rebench-v2.v1', JOINED_SWE);
    const names = plugins.map((p) => p.name);
    expect(names).toContain('swe-rebench-v2-runtime');
    expect(plugins.every((p) => typeof p.root === 'string' && p.root.length > 0)).toBe(true);
  });

  it('fails loud (actionable message) when no SolverNet matches the solverType', async () => {
    await expect(resolveRuntimePluginsForSolverType('swe-rebench-v2.v1', [])).rejects.toThrow(
      /executionWiring|jinn harnesses enable|no SolverNet/i,
    );
  });
});

describe('runHarnessForEval', () => {
  /** Capture ctx; return a stub solution payload through the freeze-fence's train path. */
  function fakeHarness(): { harness: Harness; captured: { ctx?: HarnessContext } } {
    const captured: { ctx?: HarnessContext } = {};
    const harness: Harness = {
      name: 'fake-learner',
      version: '0.0.0',
      supports: () => true,
      async run(ctx) {
        captured.ctx = ctx;
        return {
          venueRef: { name: 'legacy' },
          gating: {},
          solutionPayload: { schemaVersion: 'swe-rebench-v2-solution.v1', patch: 'diff --git a b' },
        };
      },
    };
    return { harness, captured };
  }

  it('builds a full daemon-equivalent context: solverPluginRoots includes the swe runtime plugin', async () => {
    const { harness, captured } = fakeHarness();
    const { roots } = await resolveSweLearnerPluginRoots();
    const runtimePlugins = await resolveRuntimePluginsForSolverType('swe-rebench-v2.v1', JOINED_SWE);

    const out = await runHarnessForEval({
      harness,
      task: TASK,
      solverType: 'swe-rebench-v2.v1',
      runtimePlugins,
      implStateDir: freshImplStateDir(),
      mode: 'train',
      solverNetName: 'SWE-rebench v2',
    });

    expect(captured.ctx).toBeDefined();
    expect(captured.ctx!.solverPluginRoots).toBeDefined();
    expect(captured.ctx!.solverPluginRoots!.length).toBeGreaterThan(0);
    // The bundled swe-rebench-v2-runtime plugin root MUST be passed so the agent
    // gets submit_typed_payload — the regression this refactor exists to fix.
    const sweRoot = roots.find((r) => r.includes('swe-rebench-v2-runtime') || r.includes('swe'));
    expect(captured.ctx!.solverPluginRoots).toEqual(runtimePlugins.map((p) => p.root));
    expect(sweRoot && captured.ctx!.solverPluginRoots!.includes(sweRoot)).toBe(true);

    expect(captured.ctx!.runtimePlugins).toEqual(runtimePlugins);
    expect(captured.ctx!.solverNet).toEqual({ name: 'SWE-rebench v2', solverType: 'swe-rebench-v2.v1' });
    expect(captured.ctx!.mode).toBe('train');
    expect(out.solution?.patch).toBe('diff --git a b');
    expect(out.envelope?.executor.mode).toBe('train');
    expect(out.envelope?.executor.codeDigest).toMatch(/^sha256:/);
  });

  it('returns a violation when the freeze-fence trips (frozen-mode mutation)', async () => {
    // A harness that mutates implStateDir under frozen mode trips the fence.
    const { writeFileSync } = await import('node:fs');
    const implStateDir = freshImplStateDir();
    const harness: Harness = {
      name: 'mutating-learner',
      version: '0.0.0',
      supports: () => true,
      async run() {
        writeFileSync(join(implStateDir, 'leak.txt'), 'mutated');
        return { venueRef: { name: 'legacy' }, gating: {} };
      },
    };
    const runtimePlugins = await resolveRuntimePluginsForSolverType('swe-rebench-v2.v1', JOINED_SWE);
    const out = await runHarnessForEval({
      harness,
      task: TASK,
      solverType: 'swe-rebench-v2.v1',
      runtimePlugins,
      implStateDir,
      mode: 'frozen',
    });
    expect(out.violation).toEqual({ taskId: TASK.id });
  });

  it('throws a clear "no patch" error when the harness emits no patch', async () => {
    const harness: Harness = {
      name: 'no-patch-learner',
      version: '0.0.0',
      supports: () => true,
      async run() {
        return { venueRef: { name: 'legacy' }, gating: {} };
      },
    };
    const runtimePlugins = await resolveRuntimePluginsForSolverType('swe-rebench-v2.v1', JOINED_SWE);
    await expect(
      runHarnessForEval({
        harness,
        task: TASK,
        solverType: 'swe-rebench-v2.v1',
        runtimePlugins,
        implStateDir: freshImplStateDir(),
        mode: 'train',
      }),
    ).rejects.toThrow(/no.*patch|produced no/i);
  });

  it('reclaims the ephemeral working dir (success and throw paths)', async () => {
    const seen: string[] = [];
    const harness: Harness = {
      name: 'wd-learner',
      version: '0.0.0',
      supports: () => true,
      async run(ctx) {
        seen.push(ctx.workingDir);
        return {
          venueRef: { name: 'legacy' },
          gating: {},
          solutionPayload: { schemaVersion: 'swe-rebench-v2-solution.v1', patch: 'p' },
        };
      },
    };
    const runtimePlugins = await resolveRuntimePluginsForSolverType('swe-rebench-v2.v1', JOINED_SWE);
    await runHarnessForEval({
      harness,
      task: TASK,
      solverType: 'swe-rebench-v2.v1',
      runtimePlugins,
      implStateDir: freshImplStateDir(),
      mode: 'train',
    });
    expect(seen.length).toBe(1);
    // workingDir must be gone after the run — no leaked clone dirs across a slate.
    expect(existsSync(seen[0]!)).toBe(false);
  });
});
