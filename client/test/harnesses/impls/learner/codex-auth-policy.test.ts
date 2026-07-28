import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../../../src/store/store.js';
import {
  TaskEngine,
  type TaskEngineOptions,
} from '../../../../src/harnesses/engine/engine.js';
import {
  TaskRunPersistence,
  type PersistedTaskRun,
} from '../../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../../src/harnesses/engine/state.js';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/harness.js';
import type {
  HarnessAdapter,
  TaskSessionInputs,
} from '../../../../src/harnesses/impls/learner/types.js';
import * as harvestModule from '../../../../src/harnesses/impls/learner/harvest.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import {
  SolverNetRegistry,
  type LoadedSolverNet,
} from '../../../../src/solver-nets/registry.js';
import { getSolverNetContract } from '../../../../src/solver-nets/contracts.js';
import type { Task } from '../../../../src/types/task.js';

const CANONICAL_CID = 'bafkreihvpooczub6s7c3yuraotwe43xbu4dliowmnkymegct66ddgrlaoa';

class CapturingAdapter implements HarnessAdapter {
  readonly name = 'capturing-codex';
  readonly allowsHarnessSelfModification = false;
  lastInputs: TaskSessionInputs | undefined;

  async runTask(inputs: TaskSessionInputs): Promise<void> {
    this.lastInputs = inputs;
  }
}

function exactSolverNet(): LoadedSolverNet {
  const contract = getSolverNetContract({ id: 'jinn-repo', version: 'v1' });
  if (!contract) throw new Error('jinn-repo.v1 contract fixture is unavailable');
  return {
    name: 'jinn-repo.v1',
    manifestCid: CANONICAL_CID,
    enabled: true,
    solverType: 'jinn-repo.v1',
    roles: ['solving', 'evaluating'],
    contract,
    harness: 'codex',
    model: 'gpt-5.4-mini',
    semanticEvaluator: {
      runtime: 'codex',
      model: 'gpt-5.4-mini',
      auth: 'chatgpt-oauth-only',
    },
    runtimePlugins: [],
    taskGenerator: { enabled: false },
  };
}

function exactTask(): Task {
  return {
    id: 'task-codex-auth-policy',
    description: 'Apply the accepted Autopilot change',
    solverType: 'jinn-repo.v1',
    contractId: 'jinn-repo',
    contractVersion: 'v1',
    solverNetManifestCid: CANONICAL_CID,
    role: 'restoration',
    spec: {},
    window: { startTs: 0, endTs: Date.now() + 60_000 },
  };
}

function directContext(
  solverNet: LoadedSolverNet = exactSolverNet(),
  task: Task = exactTask(),
): HarnessContext {
  return {
    task,
    solverNet,
    implStateDir: '/tmp/jinn-codex-auth-policy-state',
    workingDir: '/tmp/jinn-codex-auth-policy-work',
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => undefined } as unknown as HarnessContext['trajectory'],
    mode: 'train',
  };
}

function invalidSolverNet(
  overrides: Record<string, unknown>,
): LoadedSolverNet {
  return {
    ...exactSolverNet(),
    ...overrides,
  } as unknown as LoadedSolverNet;
}

function invalidTask(overrides: Partial<Task>): Task {
  return { ...exactTask(), ...overrides };
}

function legacyTask(overrides: Partial<Task>): Task {
  const task = { ...exactTask(), ...overrides };
  delete task.contractId;
  delete task.contractVersion;
  return task;
}

function taskMissingCanonicalField(
  field: 'contractId' | 'contractVersion',
): Task {
  const task = exactTask();
  delete task[field];
  return task;
}

class BridgeEngine extends TaskEngine {
  get testPersistence(): TaskRunPersistence {
    return this.persistence;
  }

  async runPersisted(intent: PersistedTaskRun): Promise<void> {
    await super.runImpl(intent);
  }
}

let harvestSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  harvestSpy = vi.spyOn(harvestModule, 'harvestOutput').mockResolvedValue({
    venueRef: { name: 'codex' },
    gating: {},
  } as Awaited<ReturnType<typeof harvestModule.harvestOutput>>);
});

afterEach(() => {
  harvestSpy.mockRestore();
});

describe('LearnerHarness task-scoped Codex auth policy', () => {
  async function capture(
    solverNet: LoadedSolverNet = exactSolverNet(),
    task: Task = exactTask(),
  ): Promise<TaskSessionInputs | undefined> {
    const adapter = new CapturingAdapter();
    const harness = new LearnerHarness({
      name: 'codex',
      adapter,
      pluginRoot: '/tmp/jinn-codex-auth-policy-plugin',
    });
    await harness.run(directContext(solverNet, task));
    return adapter.lastInputs;
  }

  it('attaches OAuth-only policy to the exact persisted canonical restoration profile', async () => {
    await expect(capture()).resolves.toMatchObject({
      codexAuthPolicy: 'chatgpt-oauth-only',
    });
  });

  it('uses canonical task contract fields when the deprecated solverType alias is absent', async () => {
    const task = exactTask();
    delete task.solverType;
    await expect(capture(exactSolverNet(), task)).resolves.toMatchObject({
      solverType: 'jinn-repo.v1',
      codexAuthPolicy: 'chatgpt-oauth-only',
      taskWorkspaceDir: '/tmp/jinn-codex-auth-policy-work/repo',
    });
  });

  it.each([
    ['manifest CID', invalidSolverNet({ manifestCid: 'bafy-wrong-manifest' }), exactTask()],
    [
      'task manifest binding',
      exactSolverNet(),
      invalidTask({ solverNetManifestCid: 'bafy-wrong-manifest' }),
    ],
    ['loaded solver type', invalidSolverNet({ solverType: 'jinn-repo.v2' }), exactTask()],
    [
      'legacy task solver type',
      exactSolverNet(),
      legacyTask({ solverType: 'jinn-repo.v2' }),
    ],
    [
      'task contract id',
      exactSolverNet(),
      invalidTask({ contractId: 'other-repo' }),
    ],
    [
      'missing task contract id',
      exactSolverNet(),
      taskMissingCanonicalField('contractId'),
    ],
    [
      'task contract version',
      exactSolverNet(),
      invalidTask({ contractVersion: 'v2' }),
    ],
    [
      'missing task contract version',
      exactSolverNet(),
      taskMissingCanonicalField('contractVersion'),
    ],
    [
      'contract id',
      invalidSolverNet({ contract: { ...exactSolverNet().contract, id: 'other' } }),
      exactTask(),
    ],
    [
      'contract version',
      invalidSolverNet({ contract: { ...exactSolverNet().contract, version: 'v2' } }),
      exactTask(),
    ],
    ['solver role', invalidSolverNet({ roles: ['evaluating'] }), exactTask()],
    ['evaluator role', invalidSolverNet({ roles: ['solving'] }), exactTask()],
    ['root harness', invalidSolverNet({ harness: 'claude-code' }), exactTask()],
    ['root model', invalidSolverNet({ model: 'gpt-5.4' }), exactTask()],
    ['root provider', invalidSolverNet({ provider: 'openrouter' }), exactTask()],
    [
      'semantic runtime',
      invalidSolverNet({
        semanticEvaluator: {
          runtime: 'claude',
          model: 'gpt-5.4-mini',
          auth: 'chatgpt-oauth-only',
        },
      }),
      exactTask(),
    ],
    [
      'semantic model',
      invalidSolverNet({
        semanticEvaluator: {
          runtime: 'codex',
          model: 'gpt-5.4',
          auth: 'chatgpt-oauth-only',
        },
      }),
      exactTask(),
    ],
    [
      'semantic auth mode',
      invalidSolverNet({
        semanticEvaluator: {
          runtime: 'codex',
          model: 'gpt-5.4-mini',
          auth: 'api-key',
        },
      }),
      exactTask(),
    ],
    ['legacy profile omission', invalidSolverNet({ semanticEvaluator: undefined }), exactTask()],
    ['task role', exactSolverNet(), invalidTask({ role: 'evaluation' })],
  ] as const)(
    'omits the policy for a one-field %s mismatch',
    async (_name, solverNet, task) => {
      const inputs = await capture(solverNet, task);
      expect(inputs).not.toHaveProperty('codexAuthPolicy');
    },
  );

  it('propagates the real loaded SolverNet profile through TaskEngine before deriving policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-codex-policy-engine-'));
    const workingDir = join(root, 'work');
    const implStateDir = join(root, 'state');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(implStateDir, { recursive: true });
    const store = new Store(':memory:');
    try {
      const adapter = new CapturingAdapter();
      const learner = new LearnerHarness({
        name: 'codex',
        adapter,
        pluginRoot: '/tmp/jinn-codex-auth-policy-plugin',
      });
      const registry = new SolverNetRegistry();
      registry.register(exactSolverNet());
      const options: TaskEngineOptions = {
        store,
        paths: {
          workingDirRoot: join(root, 'working-root'),
          implStateDirRoot: join(root, 'state-root'),
        },
        solverNetRegistry: registry,
        implRegistry: {
          findFor: ({ harnessName }) => {
            expect(harnessName).toBe('codex');
            return learner;
          },
        },
        harnessMode: 'train',
        knowledge: { enabled: false },
      };
      const engine = new BridgeEngine(options);
      const task = exactTask();
      delete task.solverType;
      await engine.observe({
        requestId: 'request-codex-policy-bridge',
        taskCid: 'bafy-task-codex-policy',
        onchainCreationTx: '0xbridge',
        onchainCreationBlock: 1,
        solverType: 'jinn-repo.v1',
        windowStartTs: 0,
        windowEndTs: Date.now() + 60_000,
        task,
      });
      engine.testPersistence.transition(
        'request-codex-policy-bridge',
        TaskRunState.CLAIMED,
      );
      engine.testPersistence.transition(
        'request-codex-policy-bridge',
        TaskRunState.WAITING,
      );
      engine.testPersistence.transition(
        'request-codex-policy-bridge',
        TaskRunState.PRE_SNAPSHOT,
      );
      engine.testPersistence.transition(
        'request-codex-policy-bridge',
        TaskRunState.RUNNING,
        {
          workingDir,
          implStateDir,
          preSnapshotCapturedAt: Date.now(),
          preSnapshotPayload: { provisioned: true, workingDir },
        },
      );

      await engine.runPersisted(
        engine.testPersistence.getByRequestId('request-codex-policy-bridge')!,
      );

      expect(adapter.lastInputs).toMatchObject({
        solverType: 'jinn-repo.v1',
        model: 'gpt-5.4-mini',
        codexAuthPolicy: 'chatgpt-oauth-only',
        taskWorkspaceDir: join(workingDir, 'repo'),
      });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
