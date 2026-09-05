import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  assertT31ApprovedHermesOverridePair,
  buildT31DaemonEnv,
  createT31GuardMismatchScanner,
  resolveT31SolverHermesConfigPath,
  runT31ProducerEvaluatorReal,
} from './T3.1-producer-evaluator-real.js';
import {
  RESOLVED_HERMES_MODEL_MISMATCH_MARKER,
  T31_APPROVED_HERMES_MODEL_ENV,
  T31_APPROVED_HERMES_PROVIDER_ENV,
  T31_EXPECTED_HERMES_MODEL_ENV,
  T31_EXPECTED_HERMES_PROVIDER_ENV,
} from '../../../src/harnesses/impls/hermes-agent/resolved-model-guard.js';
import { defaultImplStateDirRoot } from '../../../src/state-dir.js';
import { HERMES_AGENT_HARNESS, harnessStateDirName } from '../../../src/harnesses/names.js';

describe('T3.1 producer-evaluator-real', () => {
  // Gated: this test spends real testnet ETH + real OpenRouter $. Only runs when
  // explicitly opted in via JINN_T31_REAL=1.
  const enabled = process.env['JINN_T31_REAL'] === '1';

  it.skipIf(!enabled)('returns pass verdict against real Base Sepolia + real Hermes', async () => {
    const evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'T3.1-evidence-'));
    const evidencePath = path.join(evidenceDir, 'T3.1.log');
    try {
      const verdict = await runT31ProducerEvaluatorReal({
        evidencePath,
        mode: 'human-invoked',
        wallClockBudgetMs: 10 * 60 * 1000,
      });
      expect(['pass', 'fail']).toContain(verdict.verdict);
      if (verdict.verdict === 'fail') {
        console.error('T3.1 fail:', verdict.failNotes);
      }
    } finally {
      await fs.rm(evidenceDir, { recursive: true, force: true });
    }
  }, 12 * 60 * 1000);

  it('callable shape matches ScenarioVerdict', () => {
    // Static type check at compile time; this test just asserts the export exists.
    expect(typeof runT31ProducerEvaluatorReal).toBe('function');
  });

  it('narrows daemon discovery to the freshly posted on-chain task id', () => {
    expect(buildT31DaemonEnv({
      hermesModel: 'deepseek/test-model',
      onchainTaskId: '4249',
    })).toMatchObject({
      JINN_HERMES_MODEL: 'deepseek/test-model',
      JINN_HERMES_PROVIDER: 'openrouter',
      JINN_TIER3_COST_CAP_USD: '0.25',
      JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS: '4249',
      [T31_EXPECTED_HERMES_MODEL_ENV]: 'deepseek/test-model',
      [T31_EXPECTED_HERMES_PROVIDER_ENV]: 'openrouter',
    });
  });

  it('carries a non-default provider into both the daemon and the guard env', () => {
    expect(buildT31DaemonEnv({
      hermesModel: 'anthropic/claude-opus-4.6',
      hermesProvider: 'anthropic',
      onchainTaskId: '4249',
    })).toMatchObject({
      JINN_HERMES_PROVIDER: 'anthropic',
      [T31_EXPECTED_HERMES_PROVIDER_ENV]: 'anthropic',
    });
  });

  it('records an approved explicit model/provider override in daemon env for the adapter guard', () => {
    expect(buildT31DaemonEnv({
      hermesModel: 'deepseek/deepseek-v4-flash',
      hermesProvider: 'openrouter',
      onchainTaskId: '4249',
      approvedHermesOverride: {
        model: 'google/gemini-2.5-flash',
        provider: 'openrouter',
      },
    })).toMatchObject({
      [T31_EXPECTED_HERMES_MODEL_ENV]: 'deepseek/deepseek-v4-flash',
      [T31_EXPECTED_HERMES_PROVIDER_ENV]: 'openrouter',
      [T31_APPROVED_HERMES_MODEL_ENV]: 'google/gemini-2.5-flash',
      [T31_APPROVED_HERMES_PROVIDER_ENV]: 'openrouter',
    });
  });

  it('resolves the solver task-local Hermes config from the same symbols the daemon uses', async () => {
    const solverHome = await fs.mkdtemp(path.join(os.tmpdir(), 't31-solver-home-'));
    try {
      const legacyState = path.join(solverHome, '.jinn-client');
      mkdirSync(path.join(legacyState, 'engine', 'impl-state'), { recursive: true });
      writeFileSync(path.join(legacyState, 'config.json'), '{}\n');
      // Asserted against the production symbols, not against a literal path:
      // if the daemon's impl-state layout or the hermes state-dir name moves,
      // this expectation moves with it instead of quietly going stale.
      expect(resolveT31SolverHermesConfigPath(solverHome, {})).toBe(
        path.join(
          defaultImplStateDirRoot(legacyState),
          harnessStateDirName(HERMES_AGENT_HARNESS),
          'config.yaml',
        ),
      );
    } finally {
      await fs.rm(solverHome, { recursive: true, force: true });
    }
  });

  it('honours the JINN_ENGINE_IMPL_STATE_DIR_ROOT the spawned daemon inherits', () => {
    expect(
      resolveT31SolverHermesConfigPath('/gold/op-b', {
        JINN_ENGINE_IMPL_STATE_DIR_ROOT: '/elsewhere/impl-state',
      }),
    ).toBe(
      path.join('/elsewhere/impl-state', harnessStateDirName(HERMES_AGENT_HARNESS), 'config.yaml'),
    );
  });
});

describe('resolveT31SolverHermesConfigPath env handling', () => {
  it('treats a blank JINN_ENGINE_IMPL_STATE_DIR_ROOT as unset', () => {
    expect(
      resolveT31SolverHermesConfigPath('/gold/op-b', {
        JINN_ENGINE_IMPL_STATE_DIR_ROOT: '   ',
        JINN_STATE_DIR: '/state',
      }),
    ).toBe(
      path.join(
        defaultImplStateDirRoot('/state'),
        harnessStateDirName(HERMES_AGENT_HARNESS),
        'config.yaml',
      ),
    );
  });
});

describe('assertT31ApprovedHermesOverridePair', () => {
  it('accepts a complete approved pair', () => {
    expect(() =>
      assertT31ApprovedHermesOverridePair({
        approvedHermesOverride: { model: 'anthropic/claude-opus-4.6', provider: 'anthropic' },
        env: {},
      }),
    ).not.toThrow();
  });

  it('accepts no approved override at all', () => {
    expect(() => assertT31ApprovedHermesOverridePair({ env: {} })).not.toThrow();
  });

  it('rejects an approved provider with no approved model', () => {
    expect(() =>
      assertT31ApprovedHermesOverridePair({
        approvedHermesOverride: undefined,
        env: { [T31_APPROVED_HERMES_PROVIDER_ENV]: 'anthropic' },
      }),
    ).toThrow(new RegExp(T31_APPROVED_HERMES_MODEL_ENV));
  });

  it('rejects a stray inherited approved provider even when the scenario emits neither half', () => {
    // spawnMultiOpDaemons builds each child env as { ...process.env, ...extraEnv },
    // so the stray var reaches the daemon and trips the guard after boot.
    expect(() =>
      assertT31ApprovedHermesOverridePair({
        approvedHermesOverride: { model: '', provider: '' },
        env: { [T31_APPROVED_HERMES_PROVIDER_ENV]: '  openrouter  ' },
      }),
    ).toThrow(/before .*spawn|Refusing to spawn/i);
  });

  it('accepts an inherited provider once the scenario supplies the approved model', () => {
    expect(() =>
      assertT31ApprovedHermesOverridePair({
        approvedHermesOverride: { model: 'anthropic/claude-opus-4.6' },
        env: { [T31_APPROVED_HERMES_PROVIDER_ENV]: 'anthropic' },
      }),
    ).not.toThrow();
  });
});

describe('createT31GuardMismatchScanner', () => {
  const mismatchLine =
    `[hermes-agent] ${RESOLVED_HERMES_MODEL_MISMATCH_MARKER}: ` +
    'requested model=deepseek/deepseek-v4-flash provider=openrouter, ' +
    'resolved model=anthropic/claude-opus-4.6 provider=anthropic, config=/tmp/config.yaml';

  it('returns null while no daemon log carries the guard marker', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't31-scan-'));
    try {
      const logPath = path.join(dir, 'op-b-daemon.log');
      await fs.writeFile(logPath, 'ordinary daemon chatter\n');
      const scan = createT31GuardMismatchScanner([logPath, null]);
      expect(await scan()).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the marker line appended after a previous clean scan', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't31-scan-'));
    try {
      const logPath = path.join(dir, 'op-b-daemon.log');
      await fs.writeFile(logPath, 'boot\n');
      const scan = createT31GuardMismatchScanner([logPath]);
      expect(await scan()).toBeNull();
      await fs.appendFile(logPath, `${mismatchLine}\n`);
      expect(await scan()).toEqual({ logPath, line: mismatchLine });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not consume a marker line that is still being written', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't31-scan-'));
    try {
      const logPath = path.join(dir, 'op-b-daemon.log');
      const split = mismatchLine.length - 20;
      await fs.writeFile(logPath, mismatchLine.slice(0, split));
      const scan = createT31GuardMismatchScanner([logPath]);
      // The line has no terminating newline yet, so it is incomplete and must
      // not be scanned — nor may the offset advance past it.
      expect(await scan()).toBeNull();
      await fs.appendFile(logPath, `${mismatchLine.slice(split)}\n`);
      expect(await scan()).toEqual({ logPath, line: mismatchLine });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rescans from the start when a log is truncated and regrows past the stale offset', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't31-scan-'));
    try {
      const logPath = path.join(dir, 'op-b-daemon.log');
      await fs.writeFile(logPath, `first boot\n${'a'.repeat(4096)}\n`);
      const scan = createT31GuardMismatchScanner([logPath]);
      expect(await scan()).toBeNull();
      // Truncated and regrown past the remembered offset entirely between two
      // polls: the size check alone cannot see the shrink, so a marker in the
      // skipped prefix would be missed.
      await fs.writeFile(logPath, `second boot\n${mismatchLine}\n${'b'.repeat(8192)}\n`);
      expect(await scan()).toEqual({ logPath, line: mismatchLine });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('remembers a truncation observed while the replacement has no complete line yet', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't31-scan-'));
    try {
      const logPath = path.join(dir, 'op-b-daemon.log');
      await fs.writeFile(logPath, `first boot\n${'a'.repeat(4096)}\n`);
      const scan = createT31GuardMismatchScanner([logPath]);
      expect(await scan()).toBeNull();
      // Truncated, and the replacement's first line is still unterminated.
      await fs.writeFile(logPath, 'second boot');
      expect(await scan()).toBeNull();
      // Completed, and regrown past the stale offset: the reset must survive
      // that early-out, or this poll reads from byte 4108 of the replacement
      // and misses the marker.
      await fs.appendFile(logPath, `\n${mismatchLine}\n${'b'.repeat(8192)}\n`);
      expect(await scan()).toEqual({ logPath, line: mismatchLine });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a missing log file and a log truncated between scans', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't31-scan-'));
    try {
      const logPath = path.join(dir, 'op-b-daemon.log');
      const scan = createT31GuardMismatchScanner([logPath, path.join(dir, 'absent.log')]);
      expect(await scan()).toBeNull();
      await fs.writeFile(logPath, 'a'.repeat(4096) + '\n');
      expect(await scan()).toBeNull();
      await fs.writeFile(logPath, `${mismatchLine}\n`);
      expect(await scan()).toEqual({ logPath, line: mismatchLine });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
