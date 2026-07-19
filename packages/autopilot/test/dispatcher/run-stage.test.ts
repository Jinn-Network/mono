import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  runStageHeadless,
  type StageSpawnFn,
} from '../../src/dispatcher/run-stage.js';
import { HERMES_STATELESS_LAUNCHER } from '../../src/dispatcher/hermes-runtime.js';

// ---------------------------------------------------------------------------
// Fake stage-spawn. Mirrors the fake-SpawnFn style in dispatch.test.ts, but
// the stage runner reads stdout/stderr and awaits `close`, so the fake child
// is an EventEmitter-ish stub with `.stdout` / `.stderr` emitters, an `on`
// hook, and a `.kill()` (matching run-skill.ts's close/timer contract).
// ---------------------------------------------------------------------------

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };

interface FakeChild {
  stdout: EventEmitter;
  stderr: EventEmitter;
  on(event: string, cb: (arg?: unknown) => void): void;
  kill(sig?: string): void;
  __close(code: number): void;
  __killed: boolean;
}

/**
 * Build a fake StageSpawnFn.
 *
 * @param behaviour how the returned child behaves:
 *   - 'close-0': emit `emittedStdout` on stdout then close with code 0.
 *   - 'never-close': emit nothing and never close (drives the timeout path).
 */
function makeSpawn(
  behaviour: 'close-0' | 'never-close',
  emittedStdout = '',
): { spawn: StageSpawnFn; calls: SpawnCall[]; child: () => FakeChild } {
  const calls: SpawnCall[] = [];
  let built: FakeChild | undefined;
  const spawn: StageSpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts: opts as unknown as Record<string, unknown> });
    const closeListeners: Array<(code: number) => void> = [];
    const child: FakeChild = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      __killed: false,
      on(event, cb) {
        if (event === 'close') closeListeners.push(cb as (code: number) => void);
      },
      kill() {
        this.__killed = true;
        // A real SIGTERM'd process fires `close`; mirror that so the runner's
        // promise resolves on the timeout path.
        for (const cb of closeListeners) cb(-1);
      },
      __close(code) {
        for (const cb of closeListeners) cb(code);
      },
    };
    built = child;
    // Simulate async emission on the next tick.
    if (behaviour === 'close-0') {
      setImmediate(() => {
        if (emittedStdout) child.stdout.emit('data', Buffer.from(emittedStdout));
        child.__close(0);
      });
    }
    return child as unknown as ReturnType<StageSpawnFn>;
  };
  return { spawn, calls, child: () => built as FakeChild };
}

// The coordinator curates the whole stage prompt (stage task + issue body/ACs
// + prior-stage outputs) into `stageTask`; this fake mirrors that.
const BASE_OPTS = {
  stageTask: 'STAGE-3 IMPLEMENT MARKER\nISSUE-BODY-MARKER\nPLAN-MARKER',
  worktreePath: '/tmp/jinn-mono_worktrees/657',
};

const HERMES_ENV_KEYS = [
  'JINN_AUTOPILOT_RUNTIME',
  'JINN_DISPATCHER_HERMES_PYTHON',
  'JINN_DISPATCHER_HERMES_MODEL',
  'JINN_DISPATCHER_HERMES_PROVIDER',
] as const;

const originalHermesEnv = new Map(
  HERMES_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function clearHermesEnv(): void {
  for (const key of HERMES_ENV_KEYS) delete process.env[key];
}

function restoreHermesEnv(): void {
  for (const [key, value] of originalHermesEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  delete process.env.JINN_AUTOPILOT_RUNTIME;
});
afterEach(restoreHermesEnv);

describe('runStageHeadless', () => {
  it('(a) spawns a ROOT `claude -p` session, not an Agent-tool dispatch', async () => {
    const { spawn, calls } = makeSpawn('close-0', 'ok');
    await runStageHeadless(BASE_OPTS, spawn);

    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.cmd).toBe('claude');
    expect(c.args).toContain('-p');
  });

  it('(b) spawns with cwd === worktreePath (AC#5 worktree isolation)', async () => {
    const { spawn, calls } = makeSpawn('close-0', 'ok');
    await runStageHeadless(BASE_OPTS, spawn);

    expect(calls[0].opts.cwd).toBe(BASE_OPTS.worktreePath);
  });

  it('(c) prepends the headless-override block to the stage prompt', async () => {
    const { spawn, calls } = makeSpawn('close-0', 'ok');
    await runStageHeadless(BASE_OPTS, spawn);

    const pIdx = calls[0].args.indexOf('-p');
    const prompt = calls[0].args[pIdx + 1];
    // Distinctive phrase from headless-override.md (same token dispatch.test.ts uses).
    expect(prompt).toContain('non-interactive');
  });

  it('(c2) prepends canon (CLAUDE.md + handbook) — a stage `-p` session is canon-blind otherwise', async () => {
    const { spawn, calls } = makeSpawn('close-0', 'ok');
    await runStageHeadless(BASE_OPTS, spawn);

    const pIdx = calls[0].args.indexOf('-p');
    const prompt = calls[0].args[pIdx + 1];
    // Distinctive token from the real CLAUDE.md at the repo root.
    expect(prompt).toContain('Jinn Network monorepo');
    // Distinctive token from the engineering handbook heading loadCanon injects.
    expect(prompt).toContain('Engineering handbook');
  });

  it('(d) forwards the curated stageTask and the worktree line verbatim', async () => {
    const { spawn, calls } = makeSpawn('close-0', 'ok');
    await runStageHeadless(BASE_OPTS, spawn);

    const pIdx = calls[0].args.indexOf('-p');
    const prompt = calls[0].args[pIdx + 1];
    expect(prompt).toContain('STAGE-3 IMPLEMENT MARKER');
    expect(prompt).toContain('ISSUE-BODY-MARKER');
    expect(prompt).toContain('PLAN-MARKER');
    expect(prompt).toContain(BASE_OPTS.worktreePath);
  });

  it('passes --model <m> when a model is supplied', async () => {
    const { spawn, calls } = makeSpawn('close-0', 'ok');
    await runStageHeadless({ ...BASE_OPTS, model: 'opus' }, spawn);

    const modelIdx = calls[0].args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(calls[0].args[modelIdx + 1]).toBe('opus');
  });

  it('omits --model when no model is supplied', async () => {
    const { spawn, calls } = makeSpawn('close-0', 'ok');
    await runStageHeadless(BASE_OPTS, spawn);

    expect(calls[0].args).not.toContain('--model');
  });

  it('spawns a fresh stateless Hermes root with the subscription billing guard', async () => {
    process.env.JINN_DISPATCHER_HERMES_PYTHON = '/wrong/python';
    process.env.JINN_DISPATCHER_HERMES_MODEL = 'wrong-model';
    process.env.JINN_DISPATCHER_HERMES_PROVIDER = 'wrong-provider';
    process.env.JINN_AUTOPILOT_RUNTIME = 'hermes';
    const { spawn, calls } = makeSpawn('close-0', 'ok');

    await runStageHeadless({
      ...BASE_OPTS,
      hermesPythonPath: '/opt/hermes/python',
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
    }, spawn);

    expect(calls[0].cmd).toBe('/opt/hermes/python');
    expect(calls[0].args[0]).toBe(HERMES_STATELESS_LAUNCHER);
    expect(calls[0].args).toContain('chat');
    expect(calls[0].args).toContain('-q');
    expect(calls[0].args[calls[0].args.indexOf('--model') + 1])
      .toBe('gpt-5.6-sol');
    expect(calls[0].args[calls[0].args.indexOf('--provider') + 1])
      .toBe('openai-codex');
  });

  it('resolves Hermes Python, model, and provider from named environment variables', async () => {
    process.env.JINN_DISPATCHER_HERMES_PYTHON = '/env/hermes/python';
    process.env.JINN_DISPATCHER_HERMES_MODEL = 'gpt-5.6-sol';
    process.env.JINN_DISPATCHER_HERMES_PROVIDER = 'openai-codex';
    process.env.JINN_AUTOPILOT_RUNTIME = 'hermes';
    const { spawn, calls } = makeSpawn('close-0', 'ok');

    await runStageHeadless(BASE_OPTS, spawn);

    expect(calls[0].cmd).toBe('/env/hermes/python');
    expect(calls[0].args[calls[0].args.indexOf('--model') + 1])
      .toBe('gpt-5.6-sol');
    expect(calls[0].args[calls[0].args.indexOf('--provider') + 1])
      .toBe('openai-codex');
  });

  it('revalidates Hermes billing before an inherited or explicit stage spawn', () => {
    process.env.JINN_AUTOPILOT_RUNTIME = 'hermes';
    const { spawn, calls } = makeSpawn('close-0', 'ok');

    expect(() => runStageHeadless({
      ...BASE_OPTS,
      hermesPythonPath: '/opt/hermes/python',
      model: 'openai/gpt-5.6-sol',
      provider: 'openai-codex',
    }, spawn)).toThrow(/bare model id/i);
    expect(calls).toHaveLength(0);
  });

  it('reframes the root-stage headless block for Hermes', async () => {
    process.env.JINN_AUTOPILOT_RUNTIME = 'hermes';
    const { spawn, calls } = makeSpawn('close-0', 'ok');

    await runStageHeadless({
      ...BASE_OPTS,
      hermesPythonPath: '/opt/hermes/python',
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
    }, spawn);

    const qIdx = calls[0].args.indexOf('-q');
    const prompt = calls[0].args[qIdx + 1];
    expect(prompt).toContain('hermes chat -q');
    expect(prompt).not.toContain('`claude -p` / `--print`');
  });

  it.each([
    ['JINN_DISPATCHER_HERMES_PYTHON', { model: 'gpt-5.6-sol', provider: 'openai-codex' }],
    ['JINN_DISPATCHER_HERMES_MODEL', { hermesPythonPath: '/opt/hermes/python', provider: 'openai-codex' }],
    ['JINN_DISPATCHER_HERMES_PROVIDER', { hermesPythonPath: '/opt/hermes/python', model: 'gpt-5.6-sol' }],
  ] as const)('fails loudly when %s is missing', (missingName, supplied) => {
    clearHermesEnv();
    process.env.JINN_AUTOPILOT_RUNTIME = 'hermes';
    const { spawn, calls } = makeSpawn('close-0', 'ok');

    expect(() => runStageHeadless({
      ...BASE_OPTS,
      ...supplied,
    }, spawn)).toThrow(missingName);
    expect(calls).toHaveLength(0);
  });

  it('fails before spawn when the inherited global runtime is invalid', () => {
    process.env.JINN_AUTOPILOT_RUNTIME = 'codex';
    const { spawn, calls } = makeSpawn('close-0', 'ok');

    expect(() => runStageHeadless(BASE_OPTS, spawn))
      .toThrow(/JINN_AUTOPILOT_RUNTIME.*claude.*hermes/i);
    expect(calls).toHaveLength(0);
  });

  it('(e) resolves { exitCode:0, stdout, timedOut:false } on clean close', async () => {
    const { spawn } = makeSpawn('close-0', 'STAGE-REPORT-BODY');
    const result = await runStageHeadless(BASE_OPTS, spawn);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('STAGE-REPORT-BODY');
    expect(result.timedOut).toBe(false);
  });

  it('(e) resolves timedOut:true and kills the child when it never closes', async () => {
    const { spawn, child } = makeSpawn('never-close');
    const result = await runStageHeadless({ ...BASE_OPTS, timeoutMs: 5 }, spawn);

    expect(result.timedOut).toBe(true);
    expect(child().__killed).toBe(true);
  });
});
