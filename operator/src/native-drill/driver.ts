// operator/src/native-drill/driver.ts
/**
 * The restart-drill driver (#2434): the parent that runs each checkpoint's three real processes,
 * kills one of them at the injected boundary, and turns the proven-equal pair into a sealed
 * recovery report.
 *
 * Process control is injected as a port so the driver is testable without a process table; the
 * concrete spawner lives in `operator/scripts/native-restart-drill.ts`.
 */
import { join } from 'node:path';
import { DRILL_SPECS, type DrillCheckpoint, type DrillCheckpointSpec } from './checkpoints.js';
import {
  RunObservationSchema,
  checkRequiredEffects,
  compareRuns,
  type RunObservation,
} from './observation.js';
import { buildDrillReport, type DrillRecoveryReport, type SealedDrillReport } from './report.js';
import type { RoleRunSpec } from './role-host.js';

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

/** One Anvil node, owned by the caller that opened it. */
export interface DrillChainNode {
  readonly rpcUrl: string;
  close(): Promise<void>;
}

export interface DrillEnvironment {
  /**
   * Open a node for one lane. Every lane gets its own chain: the uninterrupted run and the
   * recovered run are two independent universes, and on a shared node the uninterrupted run's own
   * transactions would show up in the recovered run's canonical history as duplicates. Separate
   * chains also make the two lanes' transactions byte-identical — same nonce, same fees, same
   * deterministic signature — so the recovered record graph can be compared to the oracle's
   * exactly, including the signed source entries that commit to the transaction hash.
   */
  readonly openChain: (label: string) => Promise<DrillChainNode>;
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
  return join(stateRoot, `${spec.seed}-${lane}`);
}

/**
 * Accept a completed run only when it is the run that was asked for. The checkpoint name is what
 * the closure manifest keys its `recoveryReports` on, so a scenario that reported the wrong
 * checkpoint, seed, or mode must fail here rather than be filed under a name it did not drill.
 */
function expectObservation(
  spec: DrillCheckpointSpec,
  lane: 'uninterrupted' | 'recovery',
  result: RoleRunResult,
): RunObservation {
  const { checkpoint } = spec;
  if (result.kind === 'killed-at-boundary') {
    throw new DrillFailure(checkpoint, `${lane} run was killed at the boundary but should have completed`);
  }
  if (result.kind === 'failed') {
    throw new DrillFailure(checkpoint, `${lane} run failed: ${result.reason}`);
  }
  const observation = RunObservationSchema.parse(result.observation);
  const expectedMode = lane === 'uninterrupted' ? 'uninterrupted' : 'recovered';
  if (observation.checkpoint !== checkpoint
    || observation.seed !== spec.seed
    || observation.mode !== expectedMode) {
    throw new DrillFailure(
      checkpoint,
      `${lane} run reported ${observation.checkpoint}/${observation.seed}/${observation.mode}, `
      + `expected ${checkpoint}/${spec.seed}/${expectedMode}`,
    );
  }
  return observation;
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

  environment.log?.(`${checkpoint}: uninterrupted run`);
  const oracleNode = await environment.openChain(`${seed}-oracle`);
  let uninterrupted: RunObservation;
  try {
    uninterrupted = expectObservation(spec, 'uninterrupted', await environment.launcher.launch(
      {
        checkpoint,
        seed,
        runId,
        rpcUrl: oracleNode.rpcUrl,
        mode: 'uninterrupted',
        stateDir: stateDirFor(environment.stateRoot, spec, 'oracle'),
      },
      { killAtBoundary: false },
    ));
  } finally {
    await oracleNode.close();
  }

  const recoveryStateDir = stateDirFor(environment.stateRoot, spec, 'recovery');
  // The crash and the recovery run share one node: the recovery must reconcile the transaction the
  // killed process actually left on chain.
  const recoveryNode = await environment.openChain(`${seed}-recovery`);
  let recovered: RunObservation;
  try {
    const recoveryBase = { checkpoint, seed, runId, rpcUrl: recoveryNode.rpcUrl, stateDir: recoveryStateDir } as const;
    environment.log?.(`${checkpoint}: crash run (SIGKILL at ${spec.boundary})`);
    const crashed = await environment.launcher.launch(
      { ...recoveryBase, mode: 'crash' },
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
    recovered = expectObservation(spec, 'recovery', await environment.launcher.launch(
      { ...recoveryBase, mode: 'resume' },
      { killAtBoundary: false },
    ));
  } finally {
    await recoveryNode.close();
  }

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
