import { isAbsolute, join } from 'node:path';

export const JINN_MONO_VERIFICATION_PROFILE = 'jinn-mono.v1' as const;

export type JinnMonoVerificationProfile =
  typeof JINN_MONO_VERIFICATION_PROFILE;

type Workspace =
  | 'apps/broadcast-bot'
  | 'operator'
  | 'contracts'
  | 'packages/autopilot'
  | 'packages/core'
  | 'packages/indexer'
  | 'packages/indexer-enrichment'
  | 'packages/layer'
  | 'packages/plugin'
  | 'packages/sdk';

export interface VerificationCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly label: string;
}

export interface JinnMonoVerificationPlan {
  readonly profile: JinnMonoVerificationProfile;
  readonly workspaces: readonly Workspace[];
  readonly commands: readonly VerificationCommand[];
}

export type MarketplaceVerificationPlanErrorCode =
  | 'invalid-repository-path'
  | 'invalid-path'
  | 'unsupported-path';

export class MarketplaceVerificationPlanError extends Error {
  constructor(
    readonly code: MarketplaceVerificationPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceVerificationPlanError';
  }
}

export type VerificationCommandResult =
  | { readonly status: 'passed' }
  | { readonly status: 'failed'; readonly detail: string };

export type VerificationCommandRunner = (
  command: VerificationCommand,
) => Promise<VerificationCommandResult>;

export interface MarketplaceMutationVerificationInput {
  readonly profile: JinnMonoVerificationProfile;
  readonly repositoryPath: string;
  readonly touchedPaths: readonly string[];
  /** End-to-end Solution adoption cutoff; verification must finish before it. */
  readonly deadline?: string;
}

export type MarketplaceMutationVerificationResult =
  | {
      readonly profile: JinnMonoVerificationProfile;
      readonly status: 'passed';
      readonly workspaces: readonly Workspace[];
      readonly commands: readonly string[];
    }
  | {
      readonly profile: JinnMonoVerificationProfile;
      readonly status: 'failed';
      readonly workspaces: readonly Workspace[];
      readonly commands: readonly string[];
      readonly failedCommand: string;
      readonly detail: string;
    };

export interface MarketplaceMutationVerificationPort {
  preflight?(): Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  verify(
    input: MarketplaceMutationVerificationInput,
  ): Promise<MarketplaceMutationVerificationResult>;
}

interface WorkspacePolicy {
  readonly root: Workspace;
  readonly affected: readonly Workspace[];
  readonly typecheckArgs: readonly string[];
}

const WORKSPACE_POLICY: readonly WorkspacePolicy[] = [
  {
    root: 'packages/plugin',
    affected: ['packages/plugin', 'packages/core', 'packages/layer', 'operator'],
    typecheckArgs: ['yarn', 'typecheck'],
  },
  {
    root: 'packages/core',
    affected: ['packages/core', 'packages/layer', 'operator'],
    typecheckArgs: ['yarn', 'typecheck'],
  },
  {
    root: 'packages/sdk',
    affected: [
      'packages/sdk',
      'packages/indexer',
      'packages/indexer-enrichment',
      'operator',
      'packages/autopilot',
    ],
    typecheckArgs: ['yarn', 'typecheck'],
  },
  {
    root: 'packages/indexer',
    affected: ['packages/indexer', 'packages/indexer-enrichment'],
    typecheckArgs: ['yarn', 'typecheck'],
  },
  {
    root: 'packages/indexer-enrichment',
    affected: ['packages/indexer-enrichment'],
    typecheckArgs: ['yarn', 'typecheck'],
  },
  {
    root: 'packages/layer',
    affected: ['packages/layer', 'operator'],
    typecheckArgs: ['yarn', 'typecheck'],
  },
  {
    root: 'operator',
    affected: ['operator'],
    typecheckArgs: ['yarn', 'typecheck'],
  },
  {
    root: 'contracts',
    affected: ['contracts'],
    typecheckArgs: ['yarn', 'hardhat', 'compile'],
  },
  {
    root: 'packages/autopilot',
    affected: ['packages/autopilot'],
    typecheckArgs: ['yarn', 'typecheck'],
  },
  {
    root: 'apps/broadcast-bot',
    affected: ['apps/broadcast-bot'],
    typecheckArgs: ['yarn', 'typecheck'],
  },
];

const WORKSPACE_ORDER = WORKSPACE_POLICY.map(({ root }) => root);
const POLICY_BY_ROOT = new Map(
  WORKSPACE_POLICY.map((policy) => [policy.root, policy] as const),
);

function planError(
  code: MarketplaceVerificationPlanErrorCode,
  message: string,
): never {
  throw new MarketplaceVerificationPlanError(code, message);
}

function validateTouchedPath(path: string): void {
  const segments = path.split('/');
  if (
    path.length === 0
    || isAbsolute(path)
    || path.includes('\\')
    || path.includes('\u0000')
    || path.includes('\r')
    || path.includes('\n')
    || segments.some((segment) => segment.length === 0 || segment === '..' || segment === '.')
  ) {
    planError('invalid-path', `Verification path is not normalized: ${path}`);
  }
}

function policyForPath(path: string): WorkspacePolicy {
  const policy = WORKSPACE_POLICY.find(
    ({ root }) => path === root || path.startsWith(`${root}/`),
  );
  if (policy === undefined) {
    return planError(
      'unsupported-path',
      `No jinn-mono.v1 verification workspace owns path: ${path}`,
    );
  }
  return policy;
}

function commandsForWorkspace(
  repositoryPath: string,
  workspace: Workspace,
): readonly VerificationCommand[] {
  const policy = POLICY_BY_ROOT.get(workspace);
  if (policy === undefined) {
    throw new Error(`Missing verification policy for workspace: ${workspace}`);
  }
  const cwd = join(repositoryPath, workspace);
  return [
    {
      command: 'corepack',
      args: ['yarn', 'install', '--immutable'],
      cwd,
      label: `${workspace}:install`,
    },
    {
      command: 'corepack',
      args: policy.typecheckArgs,
      cwd,
      label: `${workspace}:typecheck`,
    },
    {
      command: 'corepack',
      args: ['yarn', 'test'],
      cwd,
      label: `${workspace}:test`,
    },
  ];
}

export function buildJinnMonoV1VerificationPlan(input: {
  readonly repositoryPath: string;
  readonly touchedPaths: readonly string[];
}): JinnMonoVerificationPlan {
  if (
    !isAbsolute(input.repositoryPath)
    || input.repositoryPath.length === 0
    || /[\u0000\r\n]/.test(input.repositoryPath)
  ) {
    return planError(
      'invalid-repository-path',
      'Verification repository path must be absolute',
    );
  }
  if (input.touchedPaths.length === 0) {
    return planError('invalid-path', 'Verification requires at least one touched path');
  }

  const affected = new Set<Workspace>();
  for (const path of input.touchedPaths) {
    validateTouchedPath(path);
    for (const workspace of policyForPath(path).affected) {
      affected.add(workspace);
    }
  }
  const workspaces = WORKSPACE_ORDER.filter((workspace) => affected.has(workspace));
  return {
    profile: JINN_MONO_VERIFICATION_PROFILE,
    workspaces,
    commands: workspaces.flatMap(
      (workspace) => commandsForWorkspace(input.repositoryPath, workspace),
    ),
  };
}

export function makeJinnMonoV1VerificationPort(options: {
  readonly run: VerificationCommandRunner;
}): MarketplaceMutationVerificationPort {
  return {
    async verify(input) {
      const plan = buildJinnMonoV1VerificationPlan(input);
      const commands: string[] = [];
      for (const command of plan.commands) {
        commands.push(command.label);
        const result = await options.run(command);
        if (result.status === 'failed') {
          return {
            profile: plan.profile,
            status: 'failed',
            workspaces: plan.workspaces,
            commands,
            failedCommand: command.label,
            detail: result.detail,
          };
        }
      }
      return {
        profile: plan.profile,
        status: 'passed',
        workspaces: plan.workspaces,
        commands,
      };
    },
  };
}
