/**
 * Tests for the `jinn tasks watch` subverb (stage-3 W1).
 *
 * `runTasksWatch` takes injectable deps (discovery factory, sleep, clock) so the
 * poll loop runs synchronously in-test. Routing through `tasksCommand.run` is
 * covered separately by the argument-validation cases.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import tasksCommand, {
  runTasksWatch,
  type TasksWatchDeps,
} from '../../../src/cli/commands/tasks.js';
import { makeCommandCtx } from '../../_support/cli.js';

const SAFE = `0x${'11'.repeat(20)}`;
const REQUEST_ID = `0x${'33'.repeat(32)}`;

const tempDirs: string[] = [];

function withConfig(argv: string[], config: Record<string, unknown>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-tasks-watch-config-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  return [...argv, '--config', configPath];
}

const HTTP_DISCOVERY_CONFIG = {
  network: 'testnet',
  pollIntervalMs: 1000,
  discovery: { mode: 'http', url: 'https://indexer.example' },
};
const ONCHAIN_DISCOVERY_CONFIG = {
  network: 'testnet',
  discovery: { mode: 'onchain' },
};

const READY_LOOKUP = {
  status: 'ready' as const,
  role: 'solution' as const,
  task: {
    taskId: '42',
    taskCidDigest: `0x${'11'.repeat(32)}`,
    createdAtBlock: 10,
    createdAtTx: `0x${'22'.repeat(32)}`,
  },
  attempt: {
    taskId: '42',
    attemptIndex: 0,
    requestId: REQUEST_ID,
    operator: SAFE as `0x${string}`,
    createdAtBlock: 11,
  },
  solutionOperator: SAFE as `0x${string}`,
  envelope: {
    requestId: REQUEST_ID,
    manifestCid: 'bafy-envelope-001',
    publisherAgentId: '7',
    manifestHash: `0x${'44'.repeat(32)}`,
    enrichedAtBlock: 12,
  },
};

function pending(reason: string) {
  return { status: 'pending' as const, reason, taskId: '42', role: 'solution' as const };
}

/**
 * Deps whose fake clock only advances when the loop sleeps, so the timeout is
 * driven by poll count rather than wall time.
 */
function makeDeps(
  lookups: unknown[],
): { deps: TasksWatchDeps; getCandidates: ReturnType<typeof vi.fn>; slept: number[] } {
  let clock = 0;
  const slept: number[] = [];
  const getCandidates = vi.fn(async () => {
    const next = lookups.shift();
    return (next ?? pending('attempt-not-indexed')) as never;
  });
  const deps: TasksWatchDeps = {
    createDiscovery: () => ({ getAutopilotDeliveryCandidates: getCandidates }),
    sleep: async (ms: number) => { slept.push(ms); clock += ms; },
    now: () => clock,
  };
  return { deps, getCandidates, slept };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('tasks watch', () => {
  it('requires a task id', async () => {
    const made = makeCommandCtx({ argv: ['watch'] });
    await tasksCommand.run(made.ctx);
    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      message: 'A task id is required',
    });
    expect(made.exits).toEqual([11]);
  });

  it('rejects a non-positive --timeout', async () => {
    const made = makeCommandCtx({ argv: ['watch', '42', '--timeout', '0'] });
    await tasksCommand.run(made.ctx);
    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      details: { field: '--timeout' },
    });
    expect(made.exits).toEqual([11]);
  });

  it('names the config key and env var when HTTP discovery is not configured', async () => {
    const made = makeCommandCtx({
      argv: withConfig(['watch', '42'], ONCHAIN_DISCOVERY_CONFIG),
    });
    await tasksCommand.run(made.ctx);
    const envelope = JSON.parse(made.writes.at(-1)!);
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.details).toMatchObject({
      field: 'discovery.mode',
      expected: 'http',
      actual: 'onchain',
      configKeys: ['discovery.mode', 'discovery.url'],
      envVars: ['JINN_DISCOVERY_MODE', 'JINN_DISCOVERY_URL'],
    });
    expect(envelope.hint).toMatch(/JINN_DISCOVERY_URL/);
    expect(made.exits).toEqual([11]);
  });

  it('emits progress envelopes and reaches the delivered terminal state', async () => {
    const { deps, getCandidates, slept } = makeDeps([
      pending('attempt-not-indexed'),
      READY_LOOKUP,
    ]);
    const made = makeCommandCtx({
      argv: withConfig(['42', '--timeout', '60'], HTTP_DISCOVERY_CONFIG),
    });

    await runTasksWatch(made.ctx, deps);

    const lines = made.writes.join('').trim().split('\n').map((l) => JSON.parse(l));
    const progress = lines.filter((l) => l.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({
      type: 'progress',
      phase: 'watch',
      step: 'polling_discovery',
      attempt: 1,
    });
    expect(progress[0].estimatedWaitMs).toBeGreaterThan(0);
    expect(progress.some((p) => p.step === 'awaiting_delivery:attempt-not-indexed')).toBe(true);

    const terminal = lines.at(-1);
    expect(terminal).toMatchObject({
      verb: 'tasks watch',
      taskId: '42',
      status: 'delivered',
      envelopeCid: 'bafy-envelope-001',
      publisherAgentId: '7',
      requestId: REQUEST_ID,
      operator: SAFE,
      attempts: 2,
    });
    expect(made.exits).toEqual([]);
    expect(getCandidates).toHaveBeenCalledTimes(2);
    expect(getCandidates).toHaveBeenCalledWith({
      chainId: 84532,
      taskId: '42',
      role: 'solution',
    });
    expect(slept).toEqual([1000]);
  });

  it('reaches the timeout terminal state without changing the exit code', async () => {
    const { deps, getCandidates } = makeDeps([]);
    const made = makeCommandCtx({
      argv: withConfig(['42', '--timeout', '3'], HTTP_DISCOVERY_CONFIG),
    });

    await runTasksWatch(made.ctx, deps);

    const lines = made.writes.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({
      verb: 'tasks watch',
      taskId: '42',
      status: 'timeout',
      lastReason: 'attempt-not-indexed',
      waitedMs: 3000,
      attempts: 4,
    });
    expect(made.exits).toEqual([]);
    expect(getCandidates).toHaveBeenCalledTimes(4);
  });

  it('stops on an indexer contradiction rather than polling forever', async () => {
    const { deps } = makeDeps([
      { status: 'contradiction', reason: 'multiple-attempts', taskId: '42', role: 'solution' },
    ]);
    const made = makeCommandCtx({
      argv: withConfig(['42', '--timeout', '60'], HTTP_DISCOVERY_CONFIG),
    });

    await runTasksWatch(made.ctx, deps);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'transient_error',
      details: { reason: 'multiple-attempts', taskId: '42' },
    });
    expect(made.exits).toEqual([40]);
  });

  it('emits a transient_error when the indexer is unreachable', async () => {
    const made = makeCommandCtx({
      argv: withConfig(['42'], HTTP_DISCOVERY_CONFIG),
    });
    const deps: TasksWatchDeps = {
      createDiscovery: () => ({
        getAutopilotDeliveryCandidates: vi.fn(async () => {
          throw new Error('indexer not ready: 503');
        }) as never,
      }),
      sleep: async () => {},
      now: () => 0,
    };

    await runTasksWatch(made.ctx, deps);

    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'transient_error',
      message: expect.stringContaining('indexer not ready: 503'),
    });
    expect(made.exits).toEqual([40]);
  });

  // `observe-autopilot-delivery` is a published external boundary
  // (`Jinn-Network/autopilot` shells out to it). One-swap R3b (issue #2494)
  // RELOCATES its indexer read onto `discovery-client/` rather than retiring
  // the verb, so routing here must stay exactly as it was — reaching the verb's
  // own argument validation, and exiting 11 on a missing expectation file.
  it('leaves observe-autopilot-delivery routing untouched', async () => {
    const made = makeCommandCtx({ argv: ['observe-autopilot-delivery', '--json'] });
    await tasksCommand.run(made.ctx);
    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation',
      message: '--expectation-file is required',
    });
    expect(made.exits).toEqual([11]);
  });
});
