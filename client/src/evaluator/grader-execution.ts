import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { link, chmod, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalProvisionerInput } from '@jinn-network/task-execution-backend-local';
import type {
  DeterministicProcessBlock,
  EvaluationSpec,
} from '@jinn-network/task-execution-profiles';
import {
  makeDirProvisioner,
  type CapabilityGrant,
  type ProvisionerContract,
  type WorkspacePaths,
} from '@jinn-network/task-execution-workspace';
import { readEvaluationSpecFromInput } from './launcher.js';

const GRADER_RESULT_NAME = 'grader-output.json';
const EVALUATION_CONTEXT_NAME = 'evaluation-context.json';

export interface ContainerRunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface ContainerRuntime {
  run(input: {
    readonly image: string;
    readonly workdir?: string;
  }): Promise<ContainerRunResult>;
}

const noopRuntime = {
  async assertHarnessGroupEmpty() {},
  async ensureMetaReserve() {},
};

async function atomicWriteJson(
  directory: string,
  name: string,
  value: unknown,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const target = join(directory, name);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  try {
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function graderImageUri(spec: EvaluationSpec): string {
  if (spec.family !== 'deterministic-process') {
    throw new TypeError('grader execution supports deterministic-process specifications only');
  }
  const block = spec.familyBlock as DeterministicProcessBlock;
  const image = block.image;
  if (typeof image.uri === 'string' && image.uri.length > 0) return image.uri;
  if (typeof image.name === 'string' && image.name.length > 0) return image.name;
  throw new TypeError('deterministic-process specification is missing a grader image reference');
}

function subjectResultsCarryGraderOutput(inputDir: string): boolean {
  const path = join(inputDir, GRADER_RESULT_NAME);
  return existsSync(path) && readFileSync(path, 'utf8').trim().length > 0;
}

function parseContainerOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error('grader container produced no output');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('grader container produced no output');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('grader container produced no output');
  }
  return parsed as Record<string, unknown>;
}

function wrapProvisioner(
  base: ProvisionerContract,
  containerRuntime: ContainerRuntime,
): ProvisionerContract {
  return {
    workspaceKind: base.workspaceKind,
    async setup(view, paths, grants) {
      await base.setup(view, paths, grants);
      const specification = await readEvaluationSpecFromInput(paths.input);
      if (specification.family !== 'deterministic-process') return;
      if (existsSync(join(paths.input, EVALUATION_CONTEXT_NAME))) return;
      if (subjectResultsCarryGraderOutput(paths.input)) return;

      const result = await containerRuntime.run({
        image: graderImageUri(specification),
        workdir: (specification.familyBlock as DeterministicProcessBlock).workspace?.root,
      });
      if (result.exitCode !== 0) {
        throw new Error('grader container produced no output');
      }
      const context = parseContainerOutput(result.stdout);
      await chmod(paths.input, 0o700);
      try {
        await atomicWriteJson(paths.input, EVALUATION_CONTEXT_NAME, context);
        await chmod(join(paths.input, EVALUATION_CONTEXT_NAME), 0o400);
      } finally {
        await chmod(paths.input, 0o500);
      }
    },
    executionEnv: base.executionEnv,
    harvest: base.harvest,
  };
}

export function graderExecutionProvisioner(input: {
  readonly containerRuntime: ContainerRuntime;
}): (provision: LocalProvisionerInput) => {
  readonly id: string;
  readonly contract: ProvisionerContract;
} {
  return (provisionInput) => {
    const base = makeDirProvisioner({
      sealedTaskBytes: provisionInput.sealedTaskBytes,
      dispatchContextBytes: provisionInput.dispatchContextBytes,
      runtime: noopRuntime,
    });
    return {
      id: 'grader-execution-v1',
      contract: wrapProvisioner(base, input.containerRuntime),
    };
  };
}

export { GRADER_RESULT_NAME, EVALUATION_CONTEXT_NAME };
