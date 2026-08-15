import { describe, expect, it, vi } from 'vitest';
import {
  AutopilotEvaluationContextSchema,
  type AutopilotEvaluationContext,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import {
  ExactHeadMechanicalRunner,
  type ImmutableMechanicalVerifier,
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
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
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
        targetBaseOid: '3'.repeat(40),
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
  reviewDiff?: string;
  rename?: { source: string; destination: string };
  reject?: (args: string[]) => unknown;
} = {}): RepositoryCommandRunner & ReturnType<typeof vi.fn> {
  return vi.fn(async (_command: string, args: string[]) => {
    const rejection = overrides.reject?.(args);
    if (rejection) throw rejection;
    if (args.includes('rev-parse')) {
      return { stdout: `${overrides.head ?? '4'.repeat(40)}\n`, stderr: '' };
    }
    if (args.includes('merge-base')) {
      return { stdout: `${'9'.repeat(40)}\n`, stderr: '' };
    }
    if (args.includes('--name-only')) {
      if (overrides.rename) {
        return {
          stdout: args.includes('--no-renames')
            ? `${overrides.rename.source}\0${overrides.rename.destination}\0`
            : `${overrides.rename.destination}\0`,
          stderr: '',
        };
      }
      return {
        stdout: overrides.changedFiles
          ?? 'packages/sdk/src/autopilot-session.ts\0client/src/harnesses/engine/engine.ts\0',
        stderr: '',
      };
    }
    if (args.includes('--binary')) {
      return {
        stdout: overrides.reviewDiff
          ?? 'diff --git a/client/src/a.ts b/client/src/a.ts\n+trusted change\n',
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  }) as RepositoryCommandRunner & ReturnType<typeof vi.fn>;
}

function passingVerifier(): ImmutableMechanicalVerifier {
  return {
    verify: vi.fn().mockResolvedValue({
      kind: 'passed',
      checks: ['trusted-verifier'],
    }),
  };
}

function runner(
  command: RepositoryCommandRunner,
  immutableVerifier: ImmutableMechanicalVerifier = passingVerifier(),
) {
  return new ExactHeadMechanicalRunner({
    command,
    immutableVerifier,
    makeTempDir: vi.fn().mockResolvedValue('/tmp/eval-root'),
    remove: vi.fn().mockResolvedValue(undefined),
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
        'operator/src/harnesses/engine/engine.ts',
      ],
      reviewDiff: 'diff --git a/client/src/a.ts b/client/src/a.ts\n+trusted change\n',
      checks: ['repository', 'exact-head', 'policy', 'trusted-verifier'],
    });
    expect(command).toHaveBeenCalledWith('git', [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      'https://github.com/Jinn-Network/mono.git',
      '/tmp/eval-root/repo',
    ], expect.objectContaining({
      env: expect.objectContaining({
        HOME: '/tmp/eval-root',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      }),
    }));
    expect(command).toHaveBeenCalledWith('git', [
      '-C',
      '/tmp/eval-root/repo',
      'checkout',
      '--detach',
      '4'.repeat(40),
    ], expect.objectContaining({ env: expect.any(Object) }));
    expect(command).toHaveBeenCalledWith('git', [
      '-C',
      '/tmp/eval-root/repo',
      'merge-base',
      '3'.repeat(40),
      '4'.repeat(40),
    ], expect.objectContaining({ env: expect.any(Object) }));
    expect(command).not.toHaveBeenCalledWith('git', expect.arrayContaining([
      '--is-ancestor',
    ]), expect.anything());
    expect(command).toHaveBeenCalledWith('git', [
      '-C',
      '/tmp/eval-root/repo',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      `${'3'.repeat(40)}...${'4'.repeat(40)}`,
    ], expect.objectContaining({ env: expect.any(Object) }));
    expect(command).toHaveBeenCalledWith('git', [
      '-C',
      '/tmp/eval-root/repo',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      '--full-index',
      `${'3'.repeat(40)}...${'4'.repeat(40)}`,
      '--',
    ], expect.objectContaining({ env: expect.any(Object) }));
    expect(command.mock.calls.some(([commandName]) =>
      commandName === 'yarn' || commandName === 'corepack'
    )).toBe(false);
  });

  it('never exposes ambient daemon credentials to repository commands', async () => {
    process.env['GH_TOKEN'] = 'must-not-leak';
    process.env['JINN_PASSWORD'] = 'must-not-leak';
    process.env['ANTHROPIC_API_KEY'] = 'must-not-leak';
    try {
      const command = commandRunner();
      await runner(command).run(context());

      for (const [, , options] of command.mock.calls) {
        expect(options.env).not.toHaveProperty('GH_TOKEN');
        expect(options.env).not.toHaveProperty('JINN_PASSWORD');
        expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      }
    } finally {
      delete process.env['GH_TOKEN'];
      delete process.env['JINN_PASSWORD'];
      delete process.env['ANTHROPIC_API_KEY'];
    }
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
      changedFiles: 'docs/unsupported.md\0',
    });
    const result = await runner(command).run(context());
    expect(result).toEqual({
      kind: 'unscorable',
      detail: 'unsupported-diff-scope: no deterministic checks cover docs/unsupported.md',
    });
    expect(command.mock.calls.some(([, args]) => args[0] === 'yarn')).toBe(false);
  });

  it('admits a non-client jinn-mono workspace to immutable verification', async () => {
    const immutableVerifier = passingVerifier();
    const result = await runner(commandRunner({
      changedFiles: 'packages/core/src/index.ts\0',
    }), immutableVerifier).run(context());

    expect(result).toMatchObject({
      kind: 'passed',
      changedFiles: ['packages/core/src/index.ts'],
    });
    expect(immutableVerifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFiles: ['packages/core/src/index.ts'],
      }),
    );
  });

  it('rejects unsupported paths hidden inside an otherwise supported mixed diff', async () => {
    const command = commandRunner({
      changedFiles: 'operator/src/main.ts\0.claude/settings.json\0',
    });
    const immutableVerifier = passingVerifier();
    const result = await runner(command, immutableVerifier).run(context());

    expect(result).toEqual({
      kind: 'unscorable',
      detail: 'unsupported-diff-scope: no deterministic checks cover .claude/settings.json',
    });
    expect(immutableVerifier.verify).not.toHaveBeenCalled();
  });

  it('validates both sides when an unsupported path is renamed into a supported package', async () => {
    const immutableVerifier = passingVerifier();
    const result = await runner(commandRunner({
      rename: {
        source: '.claude/settings.json',
        destination: 'operator/src/moved.ts',
      },
    }), immutableVerifier).run(context());

    expect(result).toEqual({
      kind: 'unscorable',
      detail: 'unsupported-diff-scope: no deterministic checks cover .claude/settings.json',
    });
    expect(immutableVerifier.verify).not.toHaveBeenCalled();
  });

  it('fails closed when no immutable verifier is configured', async () => {
    const command = commandRunner({
      changedFiles: 'operator/src/harnesses/engine/engine.ts\0',
    });
    const exactHeadRunner = new ExactHeadMechanicalRunner({
      command,
      makeTempDir: vi.fn().mockResolvedValue('/tmp/eval-root'),
      remove: vi.fn().mockResolvedValue(undefined),
    });

    await expect(exactHeadRunner.run(context())).resolves.toEqual({
      kind: 'unscorable',
      detail: 'immutable-verifier-unavailable',
    });
    expect(command.mock.calls.some(([commandName]) =>
      commandName === 'yarn' || commandName === 'corepack'
    )).toBe(false);
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

  it('returns a deterministic immutable-verifier failure without executing candidate tests', async () => {
    const command = commandRunner({
      changedFiles: 'operator/src/harnesses/engine/engine.ts\0',
    });
    const result = await runner(command, {
      verify: vi.fn().mockResolvedValue({
        kind: 'failed',
        check: 'trusted-tests',
        detail: 'TS2322',
      }),
    }).run(context());
    expect(result).toMatchObject({
      kind: 'failed',
      check: 'trusted-tests',
      detail: expect.stringContaining('TS2322'),
    });
    expect(command.mock.calls.some(([commandName]) =>
      commandName === 'yarn' || commandName === 'corepack'
    )).toBe(false);
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
    const command = commandRunner({ changedFiles: '../outside.ts\0' });
    const result = await runner(command).run(context());
    expect(result).toMatchObject({
      kind: 'unscorable',
      detail: expect.stringContaining('prohibited-path'),
    });
    expect(command.mock.calls.some(([, args]) => args[0] === 'typecheck')).toBe(false);
  });

  it.each([
    ['package scripts', 'operator/package.json'],
    ['TypeScript control', 'operator/tsconfig.json'],
    ['Vitest control', 'operator/vitest.config.ts'],
    ['existing test', 'operator/test/security.test.ts'],
    ['co-located test', 'operator/src/security.test.ts'],
    ['test snapshot', 'operator/src/__snapshots__/security.test.ts.snap'],
  ])('rejects changed trusted %s before immutable verification', async (
    _name,
    changedFile,
  ) => {
    const immutableVerifier = passingVerifier();
    const result = await runner(
      commandRunner({ changedFiles: `${changedFile}\0` }),
      immutableVerifier,
    ).run(context());

    expect(result).toMatchObject({
      kind: 'unscorable',
      detail: expect.stringContaining('prohibited-path'),
    });
    expect(immutableVerifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['leading whitespace', ' operator/src/main.ts\0'],
    ['control character', 'operator/src/main.ts\ninjected.ts\0'],
  ])('rejects raw Git paths containing %s without normalization', async (_name, changedFiles) => {
    const immutableVerifier = passingVerifier();
    const result = await runner(
      commandRunner({ changedFiles }),
      immutableVerifier,
    ).run(context());

    expect(result).toMatchObject({
      kind: 'unscorable',
      detail: expect.stringContaining('prohibited-path'),
    });
    expect(immutableVerifier.verify).not.toHaveBeenCalled();
  });

  it('rejects an oversized trusted full diff before semantic review', async () => {
    const result = await runner(commandRunner({
      changedFiles: 'operator/src/main.ts\0',
      reviewDiff: 'x'.repeat(8 * 1024 * 1024 + 1),
    })).run(context());

    expect(result).toMatchObject({
      kind: 'unscorable',
      detail: expect.stringContaining('review-diff-too-large'),
    });
  });
});
