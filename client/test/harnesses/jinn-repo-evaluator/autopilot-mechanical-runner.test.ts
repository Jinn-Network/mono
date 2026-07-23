import { describe, expect, it, vi } from 'vitest';
import {
  AutopilotEvaluationContextSchema,
  type AutopilotEvaluationContext,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import {
  ExactHeadMechanicalRunner,
  type RepositoryCommandRunner,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/autopilot-mechanical-runner.js';

function context(): AutopilotEvaluationContext {
  return AutopilotEvaluationContextSchema.parse({
    schemaVersion: 'jinn-autopilot-evaluation-context.v1',
    operators: {
      solutionSafe: `0x${'a'.repeat(40)}`,
      evaluatorSafe: `0x${'b'.repeat(40)}`,
    },
    reviewTarget: {
      repository: 'Jinn-Network/mono',
      issueNumber: 2001,
      prNumber: 2101,
      targetBase: 'next',
      baseOid: '3'.repeat(40),
      headRef: 'codex/issue-2001',
      resultingHead: '4'.repeat(40),
      reviewGeneration: '123e4567-e89b-42d3-a456-426614174010',
      reviewRefOid: '5'.repeat(40),
    },
    session: {
      schemaVersion: 'jinn-autopilot-session.v1',
      workflow: 'implement',
      repository: 'Jinn-Network/mono',
      issueNumber: 2001,
      prNumber: 2101,
      targetBase: 'next',
      branch: 'codex/issue-2001',
      claimOid: '1'.repeat(40),
      expectedHead: '2'.repeat(40),
      v2AttemptId: '123e4567-e89b-42d3-a456-426614174001',
      runnerId: 'runner-1',
      taskSnapshot: {
        title: 'Implement exact review',
        body: 'Review full head.',
        prBody: 'PR.',
        baseSha: '3'.repeat(40),
      },
      workflowContract: {
        skill: 'implement-issue',
        version: 'v2',
        resultSchema: 'jinn-autopilot-mutation-result.v1',
      },
      deadline: '2026-07-25T00:00:00.000Z',
      receiptAuthors: ['trusted-host'],
    },
    correlation: {
      taskId: '501',
      attemptIndex: 0,
      requestId: '0xsolution',
      deliveryEnvelopeCid: 'bafy-solution',
      v2AttemptId: '123e4567-e89b-42d3-a456-426614174001',
      claimOid: '1'.repeat(40),
      prNumber: 2101,
      expectedHead: '2'.repeat(40),
      resultingHead: '4'.repeat(40),
      reviewedHead: '4'.repeat(40),
      reviewGeneration: '123e4567-e89b-42d3-a456-426614174010',
      reviewRefOid: '5'.repeat(40),
    },
    solution: {
      summary: 'Implemented.',
      evidence: { commands: ['yarn typecheck'], tests: ['yarn test'] },
      adoptionReceipt: {
        schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
        disposition: 'accepted',
        role: 'solution',
        operation: 'implementation-complete',
        taskId: '501',
        attemptIndex: 0,
        requestId: '0xsolution',
        deliveryEnvelopeCid: 'bafy-solution',
        v2AttemptId: '123e4567-e89b-42d3-a456-426614174001',
        prNumber: 2101,
        claimOid: '1'.repeat(40),
        expectedHead: '2'.repeat(40),
        resultingHead: '4'.repeat(40),
        reviewGeneration: '123e4567-e89b-42d3-a456-426614174010',
        reviewRefOid: '5'.repeat(40),
        recordedAt: '2026-07-24T22:00:00.000Z',
      },
    },
  });
}

function commandRunner(overrides: {
  head?: string;
  changedFiles?: string;
  reject?: (args: string[]) => unknown;
} = {}): RepositoryCommandRunner & ReturnType<typeof vi.fn> {
  return vi.fn(async (_command: string, args: string[]) => {
    const rejection = overrides.reject?.(args);
    if (rejection) throw rejection;
    if (args.includes('rev-parse')) {
      return { stdout: `${overrides.head ?? '4'.repeat(40)}\n`, stderr: '' };
    }
    if (args.includes('--name-only')) {
      return {
        stdout: overrides.changedFiles
          ?? 'packages/sdk/src/autopilot-session.ts\nclient/src/harnesses/engine/engine.ts\n',
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  }) as RepositoryCommandRunner & ReturnType<typeof vi.fn>;
}

function runner(command: RepositoryCommandRunner) {
  return new ExactHeadMechanicalRunner({
    command,
    makeTempDir: vi.fn().mockResolvedValue('/tmp/eval-root'),
    remove: vi.fn().mockResolvedValue(undefined),
    pathExists: vi.fn().mockResolvedValue(true),
  });
}

describe('ExactHeadMechanicalRunner', () => {
  it('checks out and verifies the complete exact head, then gates the full base...head diff', async () => {
    const command = commandRunner();
    const result = await runner(command).run(context());

    expect(result).toMatchObject({
      kind: 'passed',
      checkoutDir: '/tmp/eval-root/repo',
      changedFiles: [
        'packages/sdk/src/autopilot-session.ts',
        'client/src/harnesses/engine/engine.ts',
      ],
      checks: ['repository', 'exact-head', 'policy', 'typecheck', 'tests'],
    });
    expect(command).toHaveBeenCalledWith('git', [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      'https://github.com/Jinn-Network/mono.git',
      '/tmp/eval-root/repo',
    ], {});
    expect(command).toHaveBeenCalledWith('git', [
      '-C',
      '/tmp/eval-root/repo',
      'checkout',
      '--detach',
      '4'.repeat(40),
    ], {});
    expect(command).toHaveBeenCalledWith('git', [
      '-C',
      '/tmp/eval-root/repo',
      'diff',
      '--name-only',
      `${'3'.repeat(40)}...${'4'.repeat(40)}`,
    ], {});
    expect(command).toHaveBeenCalledWith(
      'yarn',
      ['typecheck'],
      { cwd: '/tmp/eval-root/repo/packages/sdk' },
    );
    expect(command).toHaveBeenCalledWith(
      'yarn',
      ['typecheck'],
      { cwd: '/tmp/eval-root/repo/client' },
    );
  });

  it('rejects a stale checkout before typecheck or agent execution can occur', async () => {
    const command = commandRunner({ head: '9'.repeat(40) });
    const result = await runner(command).run(context());
    expect(result).toEqual({
      kind: 'unscorable',
      detail: `exact-head-mismatch: expected ${'4'.repeat(40)}, got ${'9'.repeat(40)}`,
    });
    expect(command.mock.calls.some(([, args]) => args[0] === 'yarn')).toBe(false);
  });

  it('marks a non-empty diff outside every supported package unscorable', async () => {
    const command = commandRunner({
      changedFiles: 'contracts/src/Autopilot.sol\n',
    });
    const result = await runner(command).run(context());
    expect(result).toEqual({
      kind: 'unscorable',
      detail: 'unsupported-diff-scope: no deterministic checks cover contracts/src/Autopilot.sol',
    });
    expect(command.mock.calls.some(([, args]) => args[0] === 'yarn')).toBe(false);
  });

  it('propagates cancellation to an in-flight repository command', async () => {
    const controller = new AbortController();
    const command = vi.fn((
      _command: string,
      _args: string[],
      options: { signal?: AbortSignal },
    ) => new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
      expect(options.signal).toBe(controller.signal);
      options.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    })) as RepositoryCommandRunner & ReturnType<typeof vi.fn>;

    const pending = runner(command).run(context(), controller.signal);
    while (command.mock.calls.length === 0) {
      await Promise.resolve();
    }
    controller.abort();

    await expect(pending).resolves.toEqual({
      kind: 'unscorable',
      detail: 'evaluation-cancelled',
    });
  });

  it('returns a deterministic typecheck failure instead of continuing to tests', async () => {
    const failure = Object.assign(new Error('typecheck red'), { code: 1, stderr: 'TS2322' });
    const command = commandRunner({
      changedFiles: 'client/src/harnesses/engine/engine.ts\n',
      reject: (args) => args[0] === 'typecheck' ? failure : undefined,
    });
    const result = await runner(command).run(context());
    expect(result).toMatchObject({
      kind: 'failed',
      check: 'typecheck',
      detail: expect.stringContaining('TS2322'),
    });
    expect(command.mock.calls.some(([, args]) => args[0] === 'test')).toBe(false);
  });

  it('classifies clone/spawn infrastructure errors as unscorable, never a graded failure', async () => {
    const command = commandRunner({
      reject: (args) => args[0] === 'clone'
        ? Object.assign(new Error('git unavailable'), { code: 'ENOENT' })
        : undefined,
    });
    const result = await runner(command).run(context());
    expect(result).toMatchObject({
      kind: 'unscorable',
      detail: expect.stringContaining('git unavailable'),
    });
  });

  it('rejects prohibited traversal paths from the full diff before package commands', async () => {
    const command = commandRunner({ changedFiles: '../outside.ts\n' });
    const result = await runner(command).run(context());
    expect(result).toMatchObject({
      kind: 'unscorable',
      detail: expect.stringContaining('prohibited-path'),
    });
    expect(command.mock.calls.some(([, args]) => args[0] === 'typecheck')).toBe(false);
  });
});
