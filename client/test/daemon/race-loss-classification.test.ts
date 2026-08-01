import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Hex } from 'viem';
import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';
import { Store } from '../../src/store/store.js';
import { SafeInnerRevertError } from '../../src/adapters/mech/safe-revert.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Regression test for #574: the daemon's engine-watcher catch sites must
 * downgrade known non-recoverable race-loss inner reverts to
 * `kind: 'race_lost'` / `outcome: 'ok'` / `level: 'info'`. Genuine errors
 * (RPC failures, unknown reverts) must continue to emit
 * `kind: 'tick_error'` / `outcome: 'failed'` / `level: 'error'`.
 *
 * Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
 * Task 16): the solution path retired — `_runEngineWatcherLoop` now skips any
 * announcement whose task.role isn't 'evaluation' before it ever reaches
 * `adapter.claimTask()`. Every posted task below now carries role: 'evaluation'
 * so the announcement still reaches the claim path this suite classifies
 * reverts on; the revert-classification logic itself is role-agnostic.
 */

function minimalEngineConfig(): DaemonConfig['restorationEngine'] {
  const root = mkdtempSync(join(tmpdir(), 'jinn-race-loss-test-'));
  const implRegistry = new HarnessRegistry({ default: 'legacy-claude' });
  return {
    implRegistry,
    paths: {
      workingDirRoot: join(root, 'work'),
      implStateDirRoot: join(root, 'impl-state'),
    },
  };
}

/**
 * Wraps LocalAdapter so a test can configure `claimTask` to throw a
 * specific error. Every claim throws — the daemon should keep running,
 * not crash.
 */
class FailingClaimAdapter extends LocalAdapter {
  override readonly name = 'failing-claim';

  constructor(private readonly errorFactory: () => Error) {
    super();
  }

  override async claimTask(_taskId: string): Promise<never> {
    throw this.errorFactory();
  }
}

/**
 * Build a SafeInnerRevertError shaped like the race-loss reverts the daemon
 * sees in production (decoded name + args populated, no tx hash). Keeps the
 * three race-loss test bodies focused on assertions instead of constructor
 * arg shapes.
 */
function raceLossRevert(name: string, args: readonly unknown[]): SafeInnerRevertError {
  const formatted = args
    .map((a) => (typeof a === 'bigint' ? a.toString() : String(a)))
    .join(', ');
  return new SafeInnerRevertError(
    `Safe execTransaction inner revert (estimate): ${name}(${formatted})`,
    '0x00000000' as Hex,
    null,
    name,
    args,
    null,
  );
}

/**
 * Assert that at least one JSON log line whose `kind` matches the given kind
 * is present, and that every matching line carries the expected `level`.
 */
function assertLogLinesLevel(chunks: string[], kind: string, level: 'info' | 'error'): void {
  const lines = chunks
    .join('')
    .split('\n')
    .filter((l) => l.includes(`"kind":"${kind}"`));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toContain(`"level":"${level}"`);
  }
}

async function waitForActivityEvent(
  store: Store,
  predicate: (row: { kind: string; outcome: string | null; detail: string | null }) => boolean,
  timeoutMs = 2000,
): Promise<{ kind: string; outcome: string | null; detail: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = store.getRecentActivityEvents(50);
    const match = rows.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for activity event');
}

interface Harness {
  daemon: Daemon;
  store: Store;
  adapter: LocalAdapter;
  stderrChunks: string[];
  restoreStderr: () => void;
}

async function startHarness(adapter: LocalAdapter): Promise<Harness> {
  const store = new Store(':memory:');

  // Capture stderr writes so we can assert on the JSON log line shape.
  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  // @ts-expect-error: patching for test isolation
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  const restoreStderr = () => {
    process.stderr.write = originalWrite;
  };

  const daemon = new Daemon({
    adapter,
    runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
    taskSources: [],
    dbPath: ':memory:',
    store,
    // Random ephemeral port — avoids collisions when daemon-tests run in
    // parallel vitest workers (each Daemon starts its own HTTP API server).
    apiPort: 0,
    restorationEngine: minimalEngineConfig(),
  });

  await daemon.start();
  return { daemon, store, adapter, stderrChunks, restoreStderr };
}

async function stopHarness(h: Harness): Promise<void> {
  try {
    await h.daemon.stop();
  } finally {
    h.restoreStderr();
  }
}

describe('daemon race-loss revert classification', () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    harness = null;
  });

  afterEach(async () => {
    if (harness) {
      await stopHarness(harness);
      harness = null;
    }
  });

  it('emits race_lost (level=info, outcome=ok) when claimTask reverts with TCMaxVerdictsReached', async () => {
    const adapter = new FailingClaimAdapter(() => raceLossRevert('TCMaxVerdictsReached', [232n, 0]));

    harness = await startHarness(adapter);
    await adapter.postTask({ id: 'race-1', description: 'lost-race task', role: 'evaluation' });

    const event = await waitForActivityEvent(harness.store, (r) => r.kind === 'race_lost');
    expect(event.kind).toBe('race_lost');
    expect(event.outcome).toBe('ok');
    expect(event.detail).toBe('TCMaxVerdictsReached(232, 0)');

    // No tick_error row for the same window.
    const recent = harness.store.getRecentActivityEvents(50);
    expect(recent.find((r) => r.kind === 'tick_error')).toBeUndefined();

    // The JSON log line carries level=info / kind=race_lost.
    assertLogLinesLevel(harness.stderrChunks, 'race_lost', 'info');
  });

  it('emits race_lost for TCAttemptAlreadyFinalized', async () => {
    const adapter = new FailingClaimAdapter(() => raceLossRevert('TCAttemptAlreadyFinalized', [99n, 1]));

    harness = await startHarness(adapter);
    await adapter.postTask({ id: 'race-2', description: 'finalized-attempt task', role: 'evaluation' });

    const event = await waitForActivityEvent(harness.store, (r) => r.kind === 'race_lost');
    expect(event.kind).toBe('race_lost');
    expect(event.outcome).toBe('ok');
    expect(event.detail).toBe('TCAttemptAlreadyFinalized(99, 1)');
    expect(harness.store.getRecentActivityEvents(50).find((r) => r.kind === 'tick_error')).toBeUndefined();
  });

  it('emits race_lost for TCEvaluationDeadlinePassed', async () => {
    const adapter = new FailingClaimAdapter(() => raceLossRevert('TCEvaluationDeadlinePassed', [7n]));

    harness = await startHarness(adapter);
    await adapter.postTask({ id: 'race-3', description: 'past-deadline task', role: 'evaluation' });

    const event = await waitForActivityEvent(harness.store, (r) => r.kind === 'race_lost');
    expect(event.kind).toBe('race_lost');
    expect(event.outcome).toBe('ok');
    expect(event.detail).toBe('TCEvaluationDeadlinePassed(7)');
    expect(harness.store.getRecentActivityEvents(50).find((r) => r.kind === 'tick_error')).toBeUndefined();
  });

  it('still emits tick_error (level=error, outcome=failed) for an unexpected RPC failure', async () => {
    const adapter = new FailingClaimAdapter(() => new Error('ECONNREFUSED'));
    harness = await startHarness(adapter);
    await adapter.postTask({ id: 'rpc-fail', description: 'genuine error task', role: 'evaluation' });

    const event = await waitForActivityEvent(harness.store, (r) => r.kind === 'tick_error');
    expect(event.kind).toBe('tick_error');
    expect(event.outcome).toBe('failed');
    expect(event.detail).toContain('ECONNREFUSED');

    expect(harness.store.getRecentActivityEvents(50).find((r) => r.kind === 'race_lost')).toBeUndefined();

    // stderr log line should be level=error.
    assertLogLinesLevel(harness.stderrChunks, 'tick_error', 'error');
  });

  it('still emits tick_error for SafeInnerRevertError whose decodedName is not in the non-recoverable set', async () => {
    // Sub-case A: decodedName is null (selector unknown).
    const adapterUnknown = new FailingClaimAdapter(() =>
      new SafeInnerRevertError(
        'Safe execTransaction inner revert (estimate): unknown selector',
        '0xdeadbeef' as Hex,
        '0xdeadbeef' as Hex,
        null,
        null,
        null,
      ),
    );
    harness = await startHarness(adapterUnknown);
    await adapterUnknown.postTask({ id: 'unknown-revert', description: 'unknown revert task', role: 'evaluation' });

    const event = await waitForActivityEvent(harness.store, (r) => r.kind === 'tick_error');
    expect(event.kind).toBe('tick_error');
    expect(event.outcome).toBe('failed');
    expect(harness.store.getRecentActivityEvents(50).find((r) => r.kind === 'race_lost')).toBeUndefined();
    await stopHarness(harness);
    harness = null;

    // Sub-case B: decodedName is a name that isn't in the non-recoverable set.
    const adapterOther = new FailingClaimAdapter(() =>
      new SafeInnerRevertError(
        'Safe execTransaction inner revert (estimate): SomeOtherError()',
        '0x12345678' as Hex,
        '0x12345678' as Hex,
        'SomeOtherError',
        [],
        null,
      ),
    );
    harness = await startHarness(adapterOther);
    await adapterOther.postTask({ id: 'other-revert', description: 'unknown-name revert task', role: 'evaluation' });

    const event2 = await waitForActivityEvent(harness.store, (r) => r.kind === 'tick_error');
    expect(event2.kind).toBe('tick_error');
    expect(event2.outcome).toBe('failed');
    expect(harness.store.getRecentActivityEvents(50).find((r) => r.kind === 'race_lost')).toBeUndefined();
  });
});
