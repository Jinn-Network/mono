import { describe, expect, it } from 'vitest';
import { DRILL_SPECS, drillSpec } from '../../src/native-drill/checkpoints.js';
import {
  DrillFailure,
  drillCheckpoint,
  runRestartDrill,
  type DrillEnvironment,
  type RoleHostLauncher,
  type RoleRunResult,
} from '../../src/native-drill/driver.js';
import {
  checkRequiredEffects,
  compareRuns,
  type RunObservation,
} from '../../src/native-drill/observation.js';
import type { RoleRunSpec } from '../../src/native-drill/role-host.js';

function observationFor(spec: RoleRunSpec, overrides: Partial<RunObservation> = {}): RunObservation {
  const required = drillSpec(spec.checkpoint).requiredEffects;
  return {
    checkpoint: spec.checkpoint,
    seed: spec.seed,
    mode: spec.mode === 'uninterrupted' ? 'uninterrupted' : 'recovered',
    finalState: 'settled',
    graphDigest: `sha256:${spec.seed.padStart(64, '0').replace(/[^0-9a-f]/gu, '0')}`,
    operationIds: [`op:${spec.checkpoint}`],
    transactionHashes: [],
    sourceHeads: [],
    effects: { ...required },
    invocations: { calls: spec.mode === 'resume' ? 2 : 1 },
    stateBefore: 'before',
    stateAfter: 'after',
    ...overrides,
  };
}

/** A launcher that behaves exactly as a healthy role host would, with per-lane overrides. */
function launcher(
  override: (spec: RoleRunSpec, killAtBoundary: boolean) => RoleRunResult | undefined = () => undefined,
): RoleHostLauncher & { readonly launched: RoleRunSpec[] } {
  const launched: RoleRunSpec[] = [];
  return {
    launched,
    async launch(spec, options) {
      launched.push(spec);
      const forced = override(spec, options.killAtBoundary);
      if (forced !== undefined) return forced;
      if (options.killAtBoundary) return { kind: 'killed-at-boundary' };
      return { kind: 'observed', observation: observationFor(spec) };
    },
  };
}

function environment(host: RoleHostLauncher): DrillEnvironment {
  let opened = 0;
  return {
    openChain: async (label) => {
      opened += 1;
      return { rpcUrl: `http://127.0.0.1:${8545 + opened}/${label}`, close: async () => {} };
    },
    chain: { chainId: 84532, mode: 'hermetic' },
    stateRoot: '/drill/state',
    launcher: host,
    now: () => new Date('2026-08-02T12:00:00.000Z'),
  };
}

describe('restart-drill driver', () => {
  it('runs three real launches per checkpoint and recovers into the crashed run own state dir', async () => {
    const host = launcher();
    const sealed = await drillCheckpoint(environment(host), drillSpec('posting'));
    expect(host.launched.map(({ mode }) => mode)).toEqual(['uninterrupted', 'crash', 'resume']);
    const [oracle, crash, resume] = host.launched;
    expect(crash!.stateDir).toBe(resume!.stateDir);
    expect(oracle!.stateDir).not.toBe(crash!.stateDir);
    expect(new Set(host.launched.map(({ runId }) => runId)).size).toBe(1);
    // The uninterrupted lane runs on its own chain; the crash and recovery lanes share one, so the
    // recovery reconciles the transaction the killed process actually left behind.
    expect(oracle!.rpcUrl).not.toBe(crash!.rpcUrl);
    expect(crash!.rpcUrl).toBe(resume!.rpcUrl);
    expect(sealed.report.injectedBoundary.injection).toBe('SIGKILL');
    expect(sealed.report.comparison.equalToUninterrupted).toBe(true);
  });

  it('fails when the crash run completes without reaching the boundary', async () => {
    const host = launcher((spec) => (spec.mode === 'crash'
      ? { kind: 'observed', observation: observationFor(spec) }
      : undefined));
    await expect(drillCheckpoint(environment(host), drillSpec('claim')))
      .rejects.toThrow(/without reaching the injected boundary/u);
  });

  it('fails when the recovered run diverges from the uninterrupted run', async () => {
    const host = launcher((spec) => (spec.mode === 'resume'
      ? { kind: 'observed', observation: observationFor(spec, { finalState: 'failed' }) }
      : undefined));
    const error = await drillCheckpoint(environment(host), drillSpec('claim')).catch((cause) => cause);
    expect(error).toBeInstanceOf(DrillFailure);
    expect(String(error)).toMatch(/finalState: uninterrupted=settled recovered=failed/u);
  });

  it('fails when a required no-duplicate effect is missing on both runs, rather than passing silently', async () => {
    // Both runs stop reporting the counter, so they still compare equal — a drill that stopped
    // counting duplicates must not read as clean just because it stopped counting consistently.
    const host = launcher((spec) => (spec.mode === 'crash'
      ? undefined
      : { kind: 'observed', observation: observationFor(spec, { effects: { posting: 1, signedSourceEntries: 1 } }) }));
    await expect(drillCheckpoint(environment(host), drillSpec('posting')))
      .rejects.toThrow(/effects\.duplicatePosts was not reported/u);
  });

  it('refuses a run that reports a checkpoint it was not asked to drill', async () => {
    const host = launcher((spec) => (spec.mode === 'resume'
      ? {
          kind: 'observed',
          observation: { ...observationFor(spec), checkpoint: 'posting' as const, seed: 'B810' },
        }
      : undefined));
    await expect(drillCheckpoint(environment(host), drillSpec('claim')))
      .rejects.toThrow(/reported posting\/B810\/recovered, expected claim\/B811\/recovered/u);
  });

  it('refuses a recovery run that reports itself as uninterrupted', async () => {
    const host = launcher((spec) => (spec.mode === 'resume'
      ? { kind: 'observed', observation: { ...observationFor(spec), mode: 'uninterrupted' as const } }
      : undefined));
    await expect(drillCheckpoint(environment(host), drillSpec('claim')))
      .rejects.toThrow(/expected claim\/B811\/recovered/u);
  });

  it('fails when a role host dies without an observation', async () => {
    const host = launcher((spec) => (spec.mode === 'uninterrupted'
      ? { kind: 'failed', reason: 'exited with code 1' }
      : undefined));
    await expect(drillCheckpoint(environment(host), drillSpec('evidence')))
      .rejects.toThrow(/uninterrupted run failed: exited with code 1/u);
  });

  it('drills every named checkpoint and returns distinct digests', async () => {
    const reports = await runRestartDrill(environment(launcher()));
    expect([...reports.keys()]).toEqual(DRILL_SPECS.map(({ checkpoint }) => checkpoint));
    expect(new Set([...reports.values()].map(({ digest }) => digest)).size).toBe(reports.size);
  });
});

describe('run comparison', () => {
  const base: RunObservation = {
    checkpoint: 'claim',
    seed: 'B811',
    mode: 'uninterrupted',
    finalState: 'claim-finalized',
    graphDigest: `sha256:${'3'.repeat(64)}`,
    operationIds: ['claim:1'],
    transactionHashes: [`0x${'b'.repeat(64)}`],
    sourceHeads: [`sha256:${'4'.repeat(64)}`],
    effects: { claims: 1, duplicateClaims: 0 },
    invocations: { broadcast: 1 },
    stateBefore: 'before',
    stateAfter: 'after',
  };

  it('ignores invocation counts, which a recovery legitimately raises', () => {
    expect(compareRuns(base, { ...base, mode: 'recovered', invocations: { broadcast: 3 } }).equal)
      .toBe(true);
  });

  it('is order-insensitive for operation ids and source heads', () => {
    const many = { ...base, operationIds: ['a', 'b'] };
    expect(compareRuns(many, { ...many, mode: 'recovered', operationIds: ['b', 'a'] }).equal).toBe(true);
  });

  it('reports an effect present on one side only', () => {
    const { duplicateClaims: _dropped, ...effects } = base.effects;
    const comparison = compareRuns(base, { ...base, mode: 'recovered', effects });
    expect(comparison.equal).toBe(false);
    expect(comparison.differences).toEqual(['effects.duplicateClaims: uninterrupted=0 recovered=absent']);
  });

  it('names an off-by-one duplicate effect', () => {
    expect(checkRequiredEffects(
      { ...base, effects: { claims: 1, claimOperations: 1, duplicateClaims: 1 } },
      drillSpec('claim').requiredEffects,
    )).toEqual(['effects.duplicateClaims=1, expected 0']);
  });
});
