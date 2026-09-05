// operator/src/native-drill/driver.ts
/**
 * The restart-drill driver (#2434): the parent that runs each checkpoint's three real processes,
 * kills one of them at the injected boundary, and turns the proven-equal pair into a sealed
 * recovery report.
 *
 * Process control is injected as a port so the driver is testable without a process table; the
 * concrete spawner lives in `operator/scripts/native-restart-drill.ts`.
 */
import { DRILL_SPECS, type DrillCheckpoint, type DrillCheckpointSpec } from './checkpoints.js';
import {
  RunObservationSchema,
  checkRequiredEffects,
  compareRuns,
  type RunObservation,
} from './observation.js';
import { buildDrillReport, type DrillRecoveryReport, type SealedDrillReport } from './report.js';
import { BOUNDARY_MARKER, OBSERVATION_MARKER, type RoleRunSpec } from './role-host.js';

/** What a launched role-host process reported back. */
export type RoleRunResult =
  /** The process completed and printed an observation. */
  | { readonly kind: 'observed'; readonly observation: RunObservation }
  /** The process reached the boundary and was killed by the parent. */
  | { readonly kind: 'killed-at-boundary' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface RoleHostLauncher {
  /**
   * Launch one role host. When `killAtBoundary` is set the launcher must SIGKILL the process the
   * moment it prints the boundary marker, and report `killed-at-boundary`.
   */
  launch(spec: RoleRunSpec, options: { readonly killAtBoundary: boolean }): Promise<RoleRunResult>;
}

export interface DrillEnvironment {
  readonly rpcUrl: string;
  readonly chain: DrillRecoveryReport['chain'];
  /** Absolute directory under which each run pair gets its own durable state directory. */
  readonly stateRoot: string;
  readonly launcher: RoleHostLauncher;
  readonly now: () => Date;
  /** Per-checkpoint progress line; the driver never writes to stdout itself. */
  readonly log?: (message: string) => void;
}

export class DrillFailure extends Error {
  constructor(readonly checkpoint: DrillCheckpoint, message: string) {
    super(`restart drill ${checkpoint}: ${message}`);
    this.name = 'DrillFailure';
  }
}

function stateDirFor(stateRoot: string, spec: DrillCheckpointSpec, lane: string): string {
  return `${stateRoot}/${spec.seed}-${lane}`;
}

function expectObservation(
  checkpoint: DrillCheckpoint,
  lane: string,
  result: RoleRunResult,
): RunObservation {
  if (result.kind === 'observed') return RunObservationSchema.parse(result.observation);
  if (result.kind === 'killed-at-boundary') {
    throw new DrillFailure(checkpoint, `${lane} run was killed at the boundary but should have completed`);
  }
  throw new DrillFailure(checkpoint, `${lane} run failed: ${result.reason}`);
}

/**
 * Drill one checkpoint. Three real processes: an uninterrupted oracle, a run killed at the
 * boundary, and a resume against that run's own durable state directory with the identical run id.
 */
export async function drillCheckpoint(
  environment: DrillEnvironment,
  spec: DrillCheckpointSpec,
): Promise<SealedDrillReport> {
  const { checkpoint, seed } = spec;
  const runId = `${seed}-${checkpoint}`;
  const base = {
    checkpoint,
    seed,
    runId,
    rpcUrl: environment.rpcUrl,
  } as const;

  environment.log?.(`${checkpoint}: uninterrupted run`);
  const uninterrupted = expectObservation(checkpoint, 'uninterrupted', await environment.launcher.launch(
    { ...base, mode: 'uninterrupted', stateDir: stateDirFor(environment.stateRoot, spec, 'oracle') },
    { killAtBoundary: false },
  ));

  const recoveryStateDir = stateDirFor(environment.stateRoot, spec, 'recovery');
  environment.log?.(`${checkpoint}: crash run (SIGKILL at ${spec.boundary})`);
  const crashed = await environment.launcher.launch(
    { ...base, mode: 'crash', stateDir: recoveryStateDir },
    { killAtBoundary: true },
  );
  if (crashed.kind !== 'killed-at-boundary') {
    throw new DrillFailure(
      checkpoint,
      crashed.kind === 'observed'
        ? 'the crash run completed without reaching the injected boundary'
        : `the crash run failed before the boundary: ${crashed.reason}`,
    );
  }

  environment.log?.(`${checkpoint}: recovery run (same run id, same state directory)`);
  const recovered = expectObservation(checkpoint, 'recovery', await environment.launcher.launch(
    { ...base, mode: 'resume', stateDir: recoveryStateDir },
    { killAtBoundary: false },
  ));

  const comparison = compareRuns(uninterrupted, recovered);
  if (!comparison.equal) {
    throw new DrillFailure(
      checkpoint,
      `recovered run diverged from the uninterrupted run — ${comparison.differences.join('; ')}`,
    );
  }
  for (const observation of [uninterrupted, recovered]) {
    const failures = checkRequiredEffects(observation, spec.requiredEffects);
    if (failures.length > 0) {
      throw new DrillFailure(checkpoint, `${observation.mode} run: ${failures.join('; ')}`);
    }
  }

  return buildDrillReport({
    runId,
    createdAt: environment.now().toISOString(),
    chain: environment.chain,
    boundary: {
      role: spec.role,
      injection: 'SIGKILL',
      description: spec.boundary,
      proof: spec.proof,
    },
    uninterrupted,
    recovered,
    comparison,
    requiredEffects: spec.requiredEffects,
  });
}

/**
 * Drill every named checkpoint. All six must pass: the closure manifest requires the exact set,
 * so a partial result is not a smaller success, it is a failure.
 */
export async function runRestartDrill(
  environment: DrillEnvironment,
): Promise<ReadonlyMap<DrillCheckpoint, SealedDrillReport>> {
  const reports = new Map<DrillCheckpoint, SealedDrillReport>();
  for (const spec of DRILL_SPECS) {
    reports.set(spec.checkpoint, await drillCheckpoint(environment, spec));
  }
  const digests = new Set([...reports.values()].map(({ digest }) => digest));
  if (digests.size !== reports.size) {
    throw new Error('restart drill produced duplicate report digests across distinct checkpoints');
  }
  return reports;
}

export { BOUNDARY_MARKER, OBSERVATION_MARKER };
