import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarnessWithFreezeFence } from '../../src/daemon/freeze-fence.js';
import type { Harness, HarnessContext, Solution } from '../../src/harnesses/types.js';

function makeCtx(implStateDir: string, mode: 'train' | 'frozen'): HarnessContext {
  return {
    task: { id: 't1', solverType: 'prediction.v1' } as any,
    implStateDir,
    workingDir: implStateDir,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    trajectory: { addSpan: () => {} } as any,
    mode,
  };
}

function noOpHarness(): Harness {
  return {
    name: 'noop',
    version: '0.1.0',
    supports: () => true,
    async run(): Promise<Solution> {
      return { artifact: {} as any, rationale: [] } as any;
    },
  };
}

function writingHarness(filename: string, content: string): Harness {
  return {
    name: 'writer',
    version: '0.1.0',
    supports: () => true,
    async run(ctx): Promise<Solution> {
      await writeFile(join(ctx.implStateDir, filename), content);
      return { artifact: {} as any, rationale: [] } as any;
    },
  };
}

function throwingHarness(): Harness {
  return {
    name: 'thrower',
    version: '0.1.0',
    supports: () => true,
    async run(ctx): Promise<Solution> {
      await writeFile(join(ctx.implStateDir, 'partial.txt'), 'partial');
      throw new Error('harness exploded');
    },
  };
}

describe('runHarnessWithFreezeFence', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'fence-test-'));
    await writeFile(join(stateDir, 'baseline.txt'), 'baseline');
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('train mode passes through with no fence overhead', async () => {
    const result = await runHarnessWithFreezeFence(noOpHarness(), makeCtx(stateDir, 'train'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.codeDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('train mode allows the harness to write to implStateDir', async () => {
    const result = await runHarnessWithFreezeFence(
      writingHarness('new.txt', 'wrote'),
      makeCtx(stateDir, 'train'),
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(stateDir, 'new.txt'), 'utf8')).toBe('wrote');
  });

  it('frozen mode + non-writing harness succeeds with stable codeDigest', async () => {
    const r1 = await runHarnessWithFreezeFence(noOpHarness(), makeCtx(stateDir, 'frozen'));
    const r2 = await runHarnessWithFreezeFence(noOpHarness(), makeCtx(stateDir, 'frozen'));
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.codeDigest).toBe(r2.codeDigest);
    }
  });

  it('frozen mode + writing harness DETECTS violation and rolls back', async () => {
    const result = await runHarnessWithFreezeFence(
      writingHarness('forbidden.txt', 'should not persist'),
      makeCtx(stateDir, 'frozen'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation.taskId).toBe('t1');
      expect(result.violation.harnessName).toBe('writer');
      expect(result.violation.stateHashBefore).not.toBe(result.violation.stateHashAfter);
    }
    const filesAfter = await readdir(stateDir);
    expect(filesAfter).toEqual(['baseline.txt']);
  });

  it('frozen mode + harness throw rolls back partial writes', async () => {
    await expect(
      runHarnessWithFreezeFence(throwingHarness(), makeCtx(stateDir, 'frozen')),
    ).rejects.toThrow('harness exploded');
    const filesAfter = await readdir(stateDir);
    expect(filesAfter).toEqual(['baseline.txt']);
  });

  it('frozen mode allows ephemeral writes that net to zero', async () => {
    const ephemeralHarness: Harness = {
      name: 'ephemeral',
      version: '0.1.0',
      supports: () => true,
      async run(ctx): Promise<Solution> {
        const path = join(ctx.implStateDir, 'temp.txt');
        await writeFile(path, 'transient');
        await rm(path);
        return { artifact: {} as any, rationale: [] } as any;
      },
    };
    const result = await runHarnessWithFreezeFence(ephemeralHarness, makeCtx(stateDir, 'frozen'));
    expect(result.ok).toBe(true);
  });

  it('frozen mode excludes harness-declared runtime-only state from the digest', async () => {
    const runtimeHarness: Harness = {
      name: 'runtime-writer',
      version: '0.1.0',
      freezeStateHashIgnore: ['runtime', 'runtime.json'],
      supports: () => true,
      async run(ctx): Promise<Solution> {
        await mkdir(join(ctx.implStateDir, 'runtime'));
        await writeFile(join(ctx.implStateDir, 'runtime', 'token.json'), '{"access":"refreshed"}');
        await writeFile(join(ctx.implStateDir, 'runtime.json'), '{"pid":1}');
        return { artifact: {} as any, rationale: [] } as any;
      },
    };

    const result = await runHarnessWithFreezeFence(runtimeHarness, makeCtx(stateDir, 'frozen'));

    expect(result.ok).toBe(true);
    expect(await readFile(join(stateDir, 'runtime', 'token.json'), 'utf8')).toBe('{"access":"refreshed"}');
    expect(await readFile(join(stateDir, 'runtime.json'), 'utf8')).toBe('{"pid":1}');
  });
});
