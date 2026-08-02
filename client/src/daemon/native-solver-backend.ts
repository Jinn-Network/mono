import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  makeLocalTaskExecutionBackend,
  type EvidenceBindingPorts,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from '@jinn-network/task-execution-backend-local';
import {
  predictionV1BaselineLauncher,
  type LauncherContract,
} from '@jinn-network/task-execution-launchers';
import {
  buildPredictionForecastProfile,
  PREDICTION_FORECAST_PROFILE_URI,
  sealTaskProfile,
  type ProfileStore,
} from '@jinn-network/task-execution-profiles';
import {
  makeDirProvisioner,
  type WorkspaceRuntimePorts,
} from '@jinn-network/task-execution-workspace';
import type { NativeLauncherCapabilityPort } from './native-claim-policy.js';
import type { RoleIdentitySet } from './role-identities.js';

const META_RESERVE_BYTES = 65_536;

export interface NativeSolverBackend {
  readonly backend: LocalTaskExecutionBackend;
  readonly launcher: NativeLauncherCapabilityPort;
  readonly executable: { readonly path: string; readonly digest: `sha256:${string}` };
  close(): Promise<void>;
}

export interface NativeSolverBackendInput {
  readonly roles: RoleIdentitySet;
  readonly stateRoot: string;
  readonly evidence: EvidenceBindingPorts;
  readonly maxConcurrentAttempts?: number;
  readonly maxArtifactBytes?: number;
  readonly quotaBytes?: number;
  readonly workTtlMs?: number;
  readonly diskFloorBytes?: number;
}

export class NativeSolverBackendError extends Error {
  override readonly name = 'NativeSolverBackendError';
}

export function buildNativeWorkspaceRuntime(): WorkspaceRuntimePorts {
  return {
    async assertHarnessGroupEmpty(paths) {
      const children = await readdir(paths.harnessState).catch(() => []);
      if (children.length !== 0) throw new NativeSolverBackendError('prediction harness left a live harness-state group');
    },
    async ensureMetaReserve(paths) {
      await mkdir(paths.meta, { recursive: true });
      await writeFile(join(paths.meta, '.reserve'), Buffer.alloc(META_RESERVE_BYTES));
    },
  };
}

export async function buildPinnedNodeLauncherDeployment(): Promise<{
  readonly executable: { readonly path: string; readonly digest: string };
  probe(): Promise<{ readonly ready: boolean; readonly executable: { readonly path: string; readonly digest: string } }>;
}> {
  const bytes = await readFile(process.execPath);
  const executable = {
    path: process.execPath,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
  return {
    executable,
    async probe() {
      try {
        await access(executable.path, constants.X_OK);
        const current = createHash('sha256').update(await readFile(executable.path)).digest('hex');
        return { ready: current === executable.digest, executable };
      } catch {
        return { ready: false, executable };
      }
    },
  };
}

function profileStore(): ProfileStore {
  const profile = buildPredictionForecastProfile();
  const digest = sealTaskProfile(profile).digest;
  return { get: (candidate) => candidate === digest ? profile : undefined };
}

function claimLauncherPort(
  launcher: LauncherContract,
  deployment: Awaited<ReturnType<typeof buildPinnedNodeLauncherDeployment>>,
): NativeLauncherCapabilityPort {
  return {
    async inspect({ profileUri }) {
      if (!launcher.capabilities().taskProfiles.includes(profileUri)) {
        throw new NativeSolverBackendError(`prediction launcher does not support ${profileUri}`);
      }
      const [deployed, probed] = await Promise.all([
        deployment.probe(),
        launcher.probe?.() ?? Promise.resolve({ ready: false, detail: 'launcher has no probe' }),
      ]);
      return {
        launcherId: launcher.id,
        taskProfiles: launcher.capabilities().taskProfiles,
        executable: deployment.executable,
        probe: {
          ready: deployed.ready && probed.ready,
          executable: deployed.executable,
          ...(!deployed.ready
            ? { detail: 'pinned Node executable changed or is not executable' }
            : probed.detail === undefined ? {} : { detail: probed.detail }),
        },
      };
    },
  };
}

/**
 * Bridge-free solver assembly for the Phase B prediction profile. It imports no compatibility
 * composition and installs no Delivery extension, model credential, or requester grant path.
 */
export async function buildNativeSolverBackend(input: NativeSolverBackendInput): Promise<NativeSolverBackend> {
  const deployment = await buildPinnedNodeLauncherDeployment();
  if (!(await deployment.probe()).ready) throw new NativeSolverBackendError('pinned Node launcher is not ready');
  const runtime = buildNativeWorkspaceRuntime();
  const launcher = predictionV1BaselineLauncher;
  const config: LocalTaskExecutionBackendConfig = {
    stateRoot: input.stateRoot,
    source: input.roles.agent,
    executor: input.roles.agent,
    profileStore: profileStore(),
    launchers: [launcher],
    launcherDeployments: { [launcher.id]: deployment },
    provisioner: (attempt) => ({
      id: 'native-prediction-dir-v1',
      contract: makeDirProvisioner({
        sealedTaskBytes: attempt.sealedTaskBytes,
        dispatchContextBytes: attempt.dispatchContextBytes,
        runtime,
        ...(input.quotaBytes === undefined ? {} : { quotaBytes: input.quotaBytes }),
        ...(input.workTtlMs === undefined ? {} : { workTtlMs: input.workTtlMs }),
        ...(input.diskFloorBytes === undefined ? {} : { diskFloorBytes: input.diskFloorBytes }),
      }),
    }),
    provisionerCapabilities: {
      taskProfiles: [PREDICTION_FORECAST_PROFILE_URI],
      workspaceKinds: ['dir'],
      inputMediaTypes: ['application/json'],
      outputMediaTypes: ['application/json'],
      isolation: ['process'],
      ...(input.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: input.maxArtifactBytes }),
    },
    maxConcurrentAttempts: input.maxConcurrentAttempts ?? 1,
    recorderAvailability: 'always',
    trustKeys: {
      observationSigningKeyConfigured: true,
      deliverySigningKey: input.roles.get('solver-delivery'),
    },
    evidence: input.evidence,
    capabilityGrants(grants) {
      if (Object.keys(grants).length !== 0) {
        throw new NativeSolverBackendError('Phase B prediction Submission must not carry capability grants');
      }
      return [];
    },
    cancellationGraceMs: 30_000,
    heartbeatIntervalMs: 10_000,
  };
  const backend = makeLocalTaskExecutionBackend(config);
  return {
    backend,
    launcher: claimLauncherPort(launcher, deployment),
    executable: {
      path: deployment.executable.path,
      digest: `sha256:${deployment.executable.digest}`,
    },
    async close() {
      await backend.shutdown();
    },
  };
}
