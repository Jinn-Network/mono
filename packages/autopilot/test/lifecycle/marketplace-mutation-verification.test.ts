import { describe, expect, it } from 'vitest';
import {
  JINN_MONO_VERIFICATION_PROFILE,
  MarketplaceVerificationPlanError,
  buildJinnMonoV1VerificationPlan,
  makeJinnMonoV1VerificationPort,
  type VerificationCommand,
} from '../../src/lifecycle/marketplace-mutation-verification.js';

const REPOSITORY = '/trusted/jinn-mono';

describe('buildJinnMonoV1VerificationPlan', () => {
  it('maps an SDK patch to the deterministic affected-workspace closure', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPOSITORY,
      touchedPaths: ['packages/sdk/src/autopilot-session.ts'],
    });

    expect(plan.profile).toBe('jinn-mono.v1');
    expect(plan.workspaces).toEqual([
      'packages/sdk',
      'packages/indexer',
      'packages/indexer-enrichment',
      'operator',
      'packages/autopilot',
    ]);
    expect(plan.commands).toEqual([
      {
        command: 'corepack',
        args: ['yarn', 'install', '--immutable'],
        cwd: `${REPOSITORY}/packages/sdk`,
        label: 'packages/sdk:install',
      },
      {
        command: 'corepack',
        args: ['yarn', 'typecheck'],
        cwd: `${REPOSITORY}/packages/sdk`,
        label: 'packages/sdk:typecheck',
      },
      {
        command: 'corepack',
        args: ['yarn', 'test'],
        cwd: `${REPOSITORY}/packages/sdk`,
        label: 'packages/sdk:test',
      },
      {
        command: 'corepack',
        args: ['yarn', 'install', '--immutable'],
        cwd: `${REPOSITORY}/packages/indexer`,
        label: 'packages/indexer:install',
      },
      {
        command: 'corepack',
        args: ['yarn', 'typecheck'],
        cwd: `${REPOSITORY}/packages/indexer`,
        label: 'packages/indexer:typecheck',
      },
      {
        command: 'corepack',
        args: ['yarn', 'test'],
        cwd: `${REPOSITORY}/packages/indexer`,
        label: 'packages/indexer:test',
      },
      {
        command: 'corepack',
        args: ['yarn', 'install', '--immutable'],
        cwd: `${REPOSITORY}/packages/indexer-enrichment`,
        label: 'packages/indexer-enrichment:install',
      },
      {
        command: 'corepack',
        args: ['yarn', 'typecheck'],
        cwd: `${REPOSITORY}/packages/indexer-enrichment`,
        label: 'packages/indexer-enrichment:typecheck',
      },
      {
        command: 'corepack',
        args: ['yarn', 'test'],
        cwd: `${REPOSITORY}/packages/indexer-enrichment`,
        label: 'packages/indexer-enrichment:test',
      },
      {
        command: 'corepack',
        args: ['yarn', 'install', '--immutable'],
        cwd: `${REPOSITORY}/client`,
        label: 'client:install',
      },
      {
        command: 'corepack',
        args: ['yarn', 'typecheck'],
        cwd: `${REPOSITORY}/client`,
        label: 'client:typecheck',
      },
      {
        command: 'corepack',
        args: ['yarn', 'test'],
        cwd: `${REPOSITORY}/client`,
        label: 'client:test',
      },
      {
        command: 'corepack',
        args: ['yarn', 'install', '--immutable'],
        cwd: `${REPOSITORY}/packages/autopilot`,
        label: 'packages/autopilot:install',
      },
      {
        command: 'corepack',
        args: ['yarn', 'typecheck'],
        cwd: `${REPOSITORY}/packages/autopilot`,
        label: 'packages/autopilot:typecheck',
      },
      {
        command: 'corepack',
        args: ['yarn', 'test'],
        cwd: `${REPOSITORY}/packages/autopilot`,
        label: 'packages/autopilot:test',
      },
    ] satisfies VerificationCommand[]);
    expect(JINN_MONO_VERIFICATION_PROFILE).toBe('jinn-mono.v1');
  });

  it('deduplicates overlapping dependency closures in policy order', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPOSITORY,
      touchedPaths: [
        'packages/core/src/index.ts',
        'packages/plugin/src/index.ts',
        'operator/src/index.ts',
      ],
    });

    expect(plan.workspaces).toEqual([
      'packages/plugin',
      'packages/core',
      'packages/layer',
      'operator',
    ]);
  });

  it.each([
    '/absolute.ts',
    '../outside.ts',
    'packages/sdk/../autopilot/src/index.ts',
    'packages\\sdk\\src\\index.ts',
    'packages/sdk//src/index.ts',
  ])('rejects a non-normalized path before planning: %s', (path) => {
    expect(() => buildJinnMonoV1VerificationPlan({
      repositoryPath: REPOSITORY,
      touchedPaths: [path],
    })).toThrow(expect.objectContaining({
      code: 'invalid-path',
    }) satisfies Partial<MarketplaceVerificationPlanError>);
  });

  it('fails closed for a path outside the bounded workspace policy', () => {
    expect(() => buildJinnMonoV1VerificationPlan({
      repositoryPath: REPOSITORY,
      touchedPaths: ['README.md'],
    })).toThrow(expect.objectContaining({
      code: 'unsupported-path',
    }) satisfies Partial<MarketplaceVerificationPlanError>);
  });
});

describe('makeJinnMonoV1VerificationPort', () => {
  it('runs argument-array commands sequentially and returns stable evidence', async () => {
    const calls: VerificationCommand[] = [];
    const port = makeJinnMonoV1VerificationPort({
      run: async (command) => {
        calls.push(command);
        return { status: 'passed' };
      },
    });

    const result = await port.verify({
      profile: 'jinn-mono.v1',
      repositoryPath: REPOSITORY,
      touchedPaths: ['packages/autopilot/src/lifecycle/index.ts'],
    });

    expect(result).toEqual({
      profile: 'jinn-mono.v1',
      status: 'passed',
      workspaces: ['packages/autopilot'],
      commands: [
        'packages/autopilot:install',
        'packages/autopilot:typecheck',
        'packages/autopilot:test',
      ],
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => Array.isArray(call.args))).toBe(true);
  });

  it('stops on the first command failure and returns a typed failed result', async () => {
    const calls: string[] = [];
    const port = makeJinnMonoV1VerificationPort({
      run: async (command) => {
        calls.push(command.label);
        if (command.label.endsWith(':typecheck')) {
          return { status: 'failed', detail: 'type errors' };
        }
        return { status: 'passed' };
      },
    });

    await expect(port.verify({
      profile: 'jinn-mono.v1',
      repositoryPath: REPOSITORY,
      touchedPaths: ['contracts/src/Router.sol'],
    })).resolves.toEqual({
      profile: 'jinn-mono.v1',
      status: 'failed',
      workspaces: ['contracts'],
      commands: ['contracts:install', 'contracts:typecheck'],
      failedCommand: 'contracts:typecheck',
      detail: 'type errors',
    });
    expect(calls).toEqual(['contracts:install', 'contracts:typecheck']);
  });
});
