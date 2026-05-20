/**
 * Tests for the env-gated StubHarness (T2.2 producer/evaluator gate).
 *
 * The harness must:
 * - Support swe-rebench-v2.v1 restoration role only.
 * - Load a canned patch from <fixturesDir>/<instanceMatcher>.patch.
 * - Return a valid swe-rebench-v2-solution.v1 solutionPayload.
 * - Throw when task.spec.instance_id does not match the configured instanceMatcher.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StubHarness } from '../../src/harnesses/impls/stub.js';
import type { HarnessContext } from '../../src/harnesses/types.js';
import { TrajectoryCollector } from '../../src/trajectory/collector.js';

const INSTANCE = 'psf__requests-1234';
const CANNED_PATCH = [
  'diff --git a/foo.py b/foo.py',
  '--- a/foo.py',
  '+++ b/foo.py',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

function makeMinimalContext(opts: { instanceId: string }): HarnessContext {
  return {
    task: {
      id: 'test-task-id',
      description: 'stub harness test task',
      solverType: 'swe-rebench-v2.v1',
      spec: { instance_id: opts.instanceId },
    },
    implStateDir: os.tmpdir(),
    workingDir: os.tmpdir(),
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: new TrajectoryCollector({ taskCid: '', runId: 'test-run' }),
    mode: 'frozen',
  };
}

describe('StubHarness', () => {
  let fixturesDir: string;

  beforeEach(async () => {
    fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stub-fixtures-'));
    await fs.writeFile(path.join(fixturesDir, `${INSTANCE}.patch`), CANNED_PATCH, 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(fixturesDir, { recursive: true, force: true });
  });

  it('has the expected name and version', () => {
    const harness = new StubHarness({ fixturesDir, instanceMatcher: INSTANCE });
    expect(harness.name).toBe('harness:stub');
    expect(harness.version).toMatch(/stub/);
  });

  it('reports ready', async () => {
    const harness = new StubHarness({ fixturesDir, instanceMatcher: INSTANCE });
    const ready = await harness.isReady?.();
    expect(ready?.ready).toBe(true);
  });

  it('supports swe-rebench-v2.v1 restoration role', () => {
    const harness = new StubHarness({ fixturesDir, instanceMatcher: INSTANCE });
    expect(harness.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
    expect(harness.supports({ solverType: 'swe-rebench-v2.v1' })).toBe(true);
  });

  it('does not support evaluation role', () => {
    const harness = new StubHarness({ fixturesDir, instanceMatcher: INSTANCE });
    expect(harness.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(false);
  });

  it('does not support other solverTypes', () => {
    const harness = new StubHarness({ fixturesDir, instanceMatcher: INSTANCE });
    expect(harness.supports({ solverType: 'prediction.v1' })).toBe(false);
    expect(harness.supports({ solverType: 'something-else' })).toBe(false);
  });

  it('returns the canned patch with correct schemaVersion when instance matches', async () => {
    const harness = new StubHarness({ fixturesDir, instanceMatcher: INSTANCE });
    const ctx = makeMinimalContext({ instanceId: INSTANCE });
    const result = await harness.run(ctx);

    expect(result.venueRef.name).toBe('harness:stub');
    expect(result.gating).toBeDefined();
    expect(result.solutionPayload).toBeDefined();

    const payload = result.solutionPayload as { schemaVersion: string; patch: string };
    expect(payload.schemaVersion).toBe('swe-rebench-v2-solution.v1');
    expect(payload.patch).toContain('diff --git a/foo.py');
    expect(payload.patch).toContain('+new');
  });

  it('throws when task.spec.instance_id does not match instanceMatcher', async () => {
    const harness = new StubHarness({ fixturesDir, instanceMatcher: INSTANCE });
    const ctx = makeMinimalContext({ instanceId: 'other-instance' });
    await expect(harness.run(ctx)).rejects.toThrow(/does not match/);
  });

  it('throws when task.spec is missing instance_id', async () => {
    const harness = new StubHarness({ fixturesDir, instanceMatcher: INSTANCE });
    const ctx: HarnessContext = {
      ...makeMinimalContext({ instanceId: INSTANCE }),
      task: {
        id: 'test-task-id',
        description: 'missing spec',
        solverType: 'swe-rebench-v2.v1',
        spec: {},
      },
    };
    await expect(harness.run(ctx)).rejects.toThrow(/does not match/);
  });
});

describe('StubHarness.maybeCreateStubHarnessFromEnv', () => {
  it('returns null when JINN_HARNESS_STUB_INSTANCE is not set', async () => {
    const { maybeCreateStubHarnessFromEnv } = await import('../../src/harnesses/impls/stub.js');
    delete process.env['JINN_HARNESS_STUB_INSTANCE'];
    const result = maybeCreateStubHarnessFromEnv();
    expect(result).toBeNull();
  });

  it('returns a StubHarness when JINN_HARNESS_STUB_INSTANCE and JINN_TEST_MODE=1 are set', async () => {
    const { maybeCreateStubHarnessFromEnv, StubHarness: StubHarnessClass } = await import(
      '../../src/harnesses/impls/stub.js'
    );
    const savedInstance = process.env['JINN_HARNESS_STUB_INSTANCE'];
    const savedDir = process.env['JINN_HARNESS_STUB_FIXTURES_DIR'];
    const savedTestMode = process.env['JINN_TEST_MODE'];
    try {
      process.env['JINN_HARNESS_STUB_INSTANCE'] = 'test-instance';
      process.env['JINN_HARNESS_STUB_FIXTURES_DIR'] = os.tmpdir();
      process.env['JINN_TEST_MODE'] = '1';
      const result = maybeCreateStubHarnessFromEnv();
      expect(result).toBeInstanceOf(StubHarnessClass);
      expect(result?.name).toBe('harness:stub');
    } finally {
      if (savedInstance === undefined) delete process.env['JINN_HARNESS_STUB_INSTANCE'];
      else process.env['JINN_HARNESS_STUB_INSTANCE'] = savedInstance;
      if (savedDir === undefined) delete process.env['JINN_HARNESS_STUB_FIXTURES_DIR'];
      else process.env['JINN_HARNESS_STUB_FIXTURES_DIR'] = savedDir;
      if (savedTestMode === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = savedTestMode;
    }
  });

  it('throws when JINN_HARNESS_STUB_INSTANCE is set but JINN_TEST_MODE is not "1"', async () => {
    const { maybeCreateStubHarnessFromEnv } = await import('../../src/harnesses/impls/stub.js');
    const savedInstance = process.env['JINN_HARNESS_STUB_INSTANCE'];
    const savedTestMode = process.env['JINN_TEST_MODE'];
    try {
      process.env['JINN_HARNESS_STUB_INSTANCE'] = 'test-instance';
      delete process.env['JINN_TEST_MODE'];
      expect(() => maybeCreateStubHarnessFromEnv()).toThrow(
        /stub harness must never activate in a real operator run/,
      );
      // A non-'1' value must also throw.
      process.env['JINN_TEST_MODE'] = 'true';
      expect(() => maybeCreateStubHarnessFromEnv()).toThrow(/JINN_TEST_MODE/);
    } finally {
      if (savedInstance === undefined) delete process.env['JINN_HARNESS_STUB_INSTANCE'];
      else process.env['JINN_HARNESS_STUB_INSTANCE'] = savedInstance;
      if (savedTestMode === undefined) delete process.env['JINN_TEST_MODE'];
      else process.env['JINN_TEST_MODE'] = savedTestMode;
    }
  });
});
