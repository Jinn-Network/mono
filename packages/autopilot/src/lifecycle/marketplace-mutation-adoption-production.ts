import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import type {
  AutopilotCorrelation,
  AutopilotSessionCapsule,
} from '../../../sdk/src/autopilot-session.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import {
  readAttemptManifest,
  type AttemptManifest,
} from './attempt-workspace.js';
import {
  readAttemptTokenFile,
  sanitizedGitHubCommandOverlay,
} from './credentials.js';
import {
  IMPLEMENTATION_SUMMARY_END,
  IMPLEMENTATION_SUMMARY_START,
  makeImplementationSessionProtocol,
} from './implementation-session.js';
import {
  makeProductionImplementationSessionPort,
} from './implementation-session-production.js';
import type {
  AdoptionReceiptComment,
  AdoptionReceiptPorts,
} from './marketplace-adoption-receipt.js';
import {
  makeMarketplaceMutationAdoptionCoordinator,
  type ConfirmedMarketplaceReviewClaim,
  type MarketplaceMutationAuthority,
  type MarketplaceMutationAuthorityPort,
  type MarketplaceMutationAdoptionCoordinator,
  type MarketplaceReviewClaimPort,
  type VerifiedMarketplaceSolutionDelivery,
} from './marketplace-mutation-adoption.js';
import {
  defaultMarketplaceMutationGitRunner,
  makeMarketplaceMutationGitPort,
} from './marketplace-mutation-git.js';
import {
  makeMarketplaceMutationManifestReceiptPort,
} from './marketplace-mutation-manifest.js';
import {
  buildJinnMonoV1VerificationPlan,
  type MarketplaceMutationVerificationInput,
  type MarketplaceMutationVerificationPort,
  type VerificationCommand,
  type VerificationCommandResult,
} from './marketplace-mutation-verification.js';
import {
  makeProductionReviewActionPort,
} from './review-executor-production.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import { gitOid } from './types.js';

const GITHUB_PAGE_SIZE = 100;
const VERIFICATION_TIMEOUT_MS = 15 * 60_000;
const VERIFICATION_OUTPUT_LIMIT = 1024 * 1024;
const VERIFICATION_IMAGE =
  'node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732';

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed ${name}`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Malformed ${name}`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Malformed ${name}`);
  }
  return value;
}

function pageNumber(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  if (!/^[1-9][0-9]*$/.test(cursor)) {
    throw new Error('Malformed GitHub adoption comment cursor');
  }
  return Number(cursor);
}

function parseComment(value: unknown): AdoptionReceiptComment {
  const comment = record(value, 'GitHub adoption comment');
  const user = record(comment.user, 'GitHub adoption comment author');
  return {
    id: positiveInteger(comment.id, 'GitHub adoption comment ID'),
    authorLogin: stringField(user.login, 'GitHub adoption comment login'),
    body: stringField(comment.body, 'GitHub adoption comment body'),
    createdAt: stringField(comment.created_at, 'GitHub adoption comment creation'),
    updatedAt: stringField(comment.updated_at, 'GitHub adoption comment update'),
  };
}

function exactHead(raw: string): string {
  const value = record(JSON.parse(raw) as unknown, 'GitHub pull request');
  return gitOid(stringField(value.headRefOid, 'GitHub pull request head'));
}

function secureGitHubRunner(
  manifestPath: string,
  runner: CommandRunner,
  ambient: NodeJS.ProcessEnv,
): CommandRunner {
  const manifest = readAttemptManifest(manifestPath);
  const token = readAttemptTokenFile(manifest.paths.tokenFile);
  if (token === undefined) {
    throw new Error('Marketplace adoption GitHub credential is unavailable');
  }
  const environment = sanitizedGitHubCommandOverlay(ambient, {
    GH_TOKEN: token,
  });
  return (command, args) => runner(command, args, { env: environment });
}

/**
 * Authenticated GitHub comment/readback surface for one immutable attempt.
 * A head race after comment creation is detected on readback; the resulting
 * comment cannot validate as an accepted receipt at Router-claim time.
 */
export function makeProductionMarketplaceAdoptionReceiptPorts(options: {
  readonly manifestPath: string;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
}): AdoptionReceiptPorts {
  const run = secureGitHubRunner(
    options.manifestPath,
    options.runner ?? defaultRunner,
    options.environment ?? process.env,
  );
  const readHead = async (prNumber: number): Promise<string> =>
    exactHead(await run('gh', [
      'pr', 'view', String(prNumber),
      '--repo', REPO,
      '--json', 'headRefOid',
    ]));
  return {
    async listPrIssueComments({ prNumber, cursor }) {
      const page = pageNumber(cursor);
      const raw = JSON.parse(await run('gh', [
        'api', '--method', 'GET',
        `repos/${REPO}/issues/${prNumber}/comments`,
        '-f', `per_page=${GITHUB_PAGE_SIZE}`,
        '-f', `page=${page}`,
      ])) as unknown;
      if (!Array.isArray(raw)) throw new Error('Malformed GitHub adoption comments');
      const comments = raw.map(parseComment);
      return {
        comments,
        ...(comments.length === GITHUB_PAGE_SIZE
          ? { nextCursor: String(page + 1) }
          : {}),
      };
    },
    async verifyReceiptFacts({ exactFacts }) {
      return await readHead(exactFacts.correlation.prNumber)
        === exactFacts.prHead;
    },
    readCurrentPrHead: readHead,
    async createPrComment({ prNumber, expectedHead, body }) {
      if (await readHead(prNumber) !== expectedHead) {
        throw new Error('Marketplace adoption receipt lost exact-head authority');
      }
      const created = record(JSON.parse(await run('gh', [
        'api', '--method', 'POST',
        `repos/${REPO}/issues/${prNumber}/comments`,
        '-f', `body=${body}`,
      ])) as unknown, 'created GitHub adoption comment');
      const commentId = positiveInteger(
        created.id,
        'created GitHub adoption comment ID',
      );
      if (await readHead(prNumber) !== expectedHead) {
        throw new Error(
          'Marketplace adoption receipt head changed during publication',
        );
      }
      return { commentId };
    },
  };
}

function dockerEnvironment(
  ambient: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allow = [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    if (ambient[key] !== undefined) environment[key] = ambient[key];
  }
  return environment;
}

function runDockerCommand(
  args: readonly string[],
  ambient: NodeJS.ProcessEnv,
): Promise<VerificationCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', [...args], {
      env: dockerEnvironment(ambient),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forcedKill: NodeJS.Timeout | undefined;
    let forcedFailure: string | undefined;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // The process may already have exited.
      }
    };
    const finish = (result: VerificationCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedKill !== undefined) clearTimeout(forcedKill);
      resolve(result);
    };
    const stop = (detail: string): void => {
      if (forcedFailure !== undefined) return;
      forcedFailure = detail;
      killGroup('SIGTERM');
      forcedKill = setTimeout(() => killGroup('SIGKILL'), 5_000);
      forcedKill.unref();
    };
    const retain = (chunk: Buffer): void => {
      if (outputBytes >= VERIFICATION_OUTPUT_LIMIT) {
        stop('verification output exceeded the safety limit');
        return;
      }
      const remaining = VERIFICATION_OUTPUT_LIMIT - outputBytes;
      output.push(chunk.subarray(0, remaining));
      outputBytes += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining) {
        stop('verification output exceeded the safety limit');
      }
    };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    child.on('error', (error) => {
      forcedFailure ??= error.message;
    });
    child.on('close', (code, signal) => finish(
      forcedFailure !== undefined
        ? { status: 'failed', detail: forcedFailure }
        : code === 0
        ? { status: 'passed' }
        : {
            status: 'failed',
            detail:
              Buffer.concat(output).toString('utf8').trim()
              || `exited with ${code ?? signal ?? 'unknown status'}`,
          },
    ));
    const timeout = setTimeout(() => {
      stop(`timed out after ${VERIFICATION_TIMEOUT_MS}ms`);
    }, VERIFICATION_TIMEOUT_MS);
    timeout.unref();
  });
}

export type VerificationDockerRunner = (
  args: readonly string[],
  label: string,
) => Promise<VerificationCommandResult>;

function dockerRunBase(input: {
  readonly name: string;
  readonly volume: string;
  readonly network: 'bridge' | 'none';
}): string[] {
  return [
    'run',
    '--rm',
    '--name', input.name,
    '--network', input.network,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '512',
    '--memory', '4g',
    '--cpus', '4',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864',
    '--mount', `type=volume,src=${input.volume},dst=/workspace`,
    '--env', 'HOME=/workspace/.jinn-home',
    '--env', 'XDG_CACHE_HOME=/workspace/.jinn-home/cache',
    '--env', 'COREPACK_HOME=/workspace/.jinn-corepack',
    '--env', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    '--env', 'CI=1',
  ];
}

function containerWorkingDirectory(
  repositoryPath: string,
  command: VerificationCommand,
): string {
  const workspace = relative(repositoryPath, command.cwd);
  if (
    workspace.length === 0
    || workspace === '..'
    || workspace.startsWith('../')
    || workspace.includes('\\')
  ) {
    throw new Error(
      `Verification command escaped the immutable repository snapshot: ${command.label}`,
    );
  }
  return `/workspace/${workspace}`;
}

export function makeProductionMarketplaceVerificationPort(
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    readonly runDocker?: VerificationDockerRunner;
    readonly volumeName?: () => string;
  } = {},
): MarketplaceMutationVerificationPort {
  const runDocker: VerificationDockerRunner =
    options.runDocker
    ?? ((args) => runDockerCommand(args, environment));
  const makeVolumeName =
    options.volumeName
    ?? (() => `jinn-autopilot-verify-${randomUUID()}`);
  return {
    async verify(input: MarketplaceMutationVerificationInput) {
      const plan = buildJinnMonoV1VerificationPlan(input);
      const volume = makeVolumeName();
      if (!/^jinn-autopilot-verify-[a-zA-Z0-9_.-]+$/.test(volume)) {
        throw new Error('Invalid marketplace verification volume name');
      }
      let volumeCreated = false;
      const create = await runDocker(
        ['volume', 'create', volume],
        'sandbox-volume-create',
      );
      if (create.status === 'failed') {
        throw new Error(`Docker verification volume creation failed: ${create.detail}`);
      }
      volumeCreated = true;
      let commandOrdinal = 0;
      try {
        const seedName = `${volume}-seed`;
        const seed = await runDocker([
          ...dockerRunBase({
            name: seedName,
            volume,
            network: 'none',
          }),
          '--mount',
          `type=bind,src=${input.repositoryPath},dst=/source,readonly`,
          VERIFICATION_IMAGE,
          'sh',
          '-ceu',
          'cp -a /source/. /workspace/',
        ], 'sandbox-source-copy');
        if (seed.status === 'failed') {
          await runDocker(
            ['rm', '-f', seedName],
            'sandbox-container-remove',
          );
          throw new Error(`Docker verification snapshot failed: ${seed.detail}`);
        }

        const commands: string[] = [];
        for (const command of plan.commands) {
          commandOrdinal += 1;
          commands.push(command.label);
          const isInstall = command.label.endsWith(':install');
          const containerName = `${volume}-${commandOrdinal}`;
          const commandArgs = isInstall
            ? [
                'yarn',
                'install',
                '--immutable',
                '--mode=skip-builds',
              ]
            : [...command.args];
          const result = await runDocker([
            ...dockerRunBase({
              name: containerName,
              volume,
              network: isInstall ? 'bridge' : 'none',
            }),
            '--workdir',
            containerWorkingDirectory(input.repositoryPath, command),
            VERIFICATION_IMAGE,
            command.command,
            ...commandArgs,
          ], command.label);
          if (result.status === 'failed') {
            await runDocker(
              ['rm', '-f', containerName],
              'sandbox-container-remove',
            );
            return {
              profile: plan.profile,
              status: 'failed' as const,
              workspaces: plan.workspaces,
              commands,
              failedCommand: command.label,
              detail: result.detail,
            };
          }
        }
        return {
          profile: plan.profile,
          status: 'passed' as const,
          workspaces: plan.workspaces,
          commands,
        };
      } finally {
        if (volumeCreated) {
          const removed = await runDocker(
            ['volume', 'rm', '-f', volume],
            'sandbox-volume-remove',
          );
          if (removed.status === 'failed') {
            throw new Error(
              `Docker verification volume cleanup failed: ${removed.detail}`,
            );
          }
        }
      }
    },
  };
}

function implementationSummary(body: string): string | undefined {
  const start = body.indexOf(IMPLEMENTATION_SUMMARY_START);
  const end = body.indexOf(IMPLEMENTATION_SUMMARY_END);
  if (start === -1 || end < start) return undefined;
  return body.slice(
    start + IMPLEMENTATION_SUMMARY_START.length,
    end,
  ).trim();
}

function confirmedReviewClaim(
  manifest: AttemptManifest,
): ConfirmedMarketplaceReviewClaim | undefined {
  if (
    manifest.phase !== 'review'
    || manifest.prNumber === undefined
    || manifest.reviewGeneration === undefined
    || manifest.reviewRefOid === undefined
    || manifest.reviewApprovalPolicy === undefined
  ) {
    return undefined;
  }
  return {
    head: gitOid(manifest.expectedHead),
    generation: manifest.reviewGeneration,
    refOid: gitOid(manifest.reviewRefOid),
    attemptId: manifest.attemptId,
    manifest,
    reviewer: manifest.selectedLogin,
    approvalPolicy: manifest.reviewApprovalPolicy,
    state: 'active',
  };
}

export function makeProductionMarketplaceMutationAuthorityPort(options: {
  readonly originManifestPath: string;
  readonly session: AutopilotSessionCapsule;
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
}): MarketplaceMutationAuthorityPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const sessionEnvironment = { ...ambient };
  delete sessionEnvironment.GH_TOKEN;
  delete sessionEnvironment.GITHUB_TOKEN;
  sessionEnvironment.JINN_AUTOPILOT_SESSION_MANIFEST =
    options.originManifestPath;
  const implementation = makeProductionImplementationSessionPort({
    runner,
    environment: sessionEnvironment,
  });
  const review = makeProductionReviewActionPort({
    repositoryPath: options.repositoryPath,
    worktreeBase: options.worktreeBase,
    runnerId: options.runnerId,
    readSnapshot: options.readSnapshot,
    runner,
    environment: ambient,
  });
  const gh = secureGitHubRunner(options.originManifestPath, runner, ambient);
  const receiptPorts = makeProductionMarketplaceAdoptionReceiptPorts({
    manifestPath: options.originManifestPath,
    runner,
    environment: ambient,
  });
  return {
    async readExactAuthority({ originManifestPath, reviewManifestPath }) {
      if (originManifestPath !== options.originManifestPath) {
        throw new Error('Marketplace authority requested a foreign manifest');
      }
      const manifest = readAttemptManifest(originManifestPath);
      const authority = await implementation.readAuthority(manifest);
      const pullRequest = await implementation.readPullRequest(
        options.session.prNumber,
        authority.remoteHead,
      );
      const candidate = await review.readCandidate(options.session.prNumber);
      if (
        candidate === null
        || candidate.head !== pullRequest.head
        || candidate.number !== pullRequest.number
      ) {
        throw new Error('Marketplace authority review facts did not converge');
      }
      let commentCursor: string | undefined;
      let humanComment = false;
      for (let page = 0; page < 100; page += 1) {
        const comments = await receiptPorts.listPrIssueComments({
          prNumber: options.session.prNumber,
          ...(commentCursor === undefined ? {} : { cursor: commentCursor }),
        });
        humanComment ||= comments.comments.some(({ body }) =>
          body.includes('<!-- jinn-autopilot:v2-human'));
        if (comments.nextCursor === undefined) break;
        commentCursor = comments.nextCursor;
        if (page === 99) {
          throw new Error('Marketplace authority comment pagination exceeded its bound');
        }
      }
      const humanLabel = pullRequest.labels.includes('review:needs-human');
      const humanActive = pullRequest.draft || humanLabel || humanComment;
      let child: MarketplaceMutationAuthority['child'];
      if (
        options.session.workflow !== 'implement'
        && options.session.childIssueNumber !== undefined
      ) {
        const raw = record(JSON.parse(await gh('gh', [
          'issue', 'view', String(options.session.childIssueNumber),
          '--repo', REPO,
          '--json', 'number,state',
        ])) as unknown, 'marketplace child issue');
        child = {
          number: positiveInteger(raw.number, 'marketplace child issue number'),
          parentPrNumber: options.session.parentPrNumber!,
          kind: options.session.workflow === 'fix-child'
            ? 'review-finding'
            : options.session.workflow === 'reconcile'
              ? 'reconcile'
              : 'ci-failure',
          open: stringField(raw.state, 'marketplace child issue state') === 'OPEN',
        };
      }
      let reviewClaim: ConfirmedMarketplaceReviewClaim | undefined;
      if (reviewManifestPath !== undefined) {
        reviewClaim = confirmedReviewClaim(
          readAttemptManifest(reviewManifestPath),
        );
        if (
          reviewClaim === undefined
          || reviewClaim.head !== candidate.head
          || candidate.reviewRef?.oid !== reviewClaim.refOid
          || candidate.reviewRef.record.generation !== reviewClaim.generation
          || candidate.reviewRef.record.attempt !== reviewClaim.attemptId
          || candidate.reviewRef.record.state !== 'active'
        ) {
          reviewClaim = undefined;
        }
      }
      return {
        manifest,
        latestClaimOid: authority.latestClaimOid,
        latestClaim: authority.latestClaim,
        remoteHead: authority.remoteHead,
        pullRequest: {
          number: pullRequest.number,
          head: pullRequest.head,
          headRefName: pullRequest.headRefName,
          baseRefName: pullRequest.baseRefName,
          open: candidate.open,
          draft: pullRequest.draft,
          labels: pullRequest.labels,
          body: pullRequest.body,
          ...(implementationSummary(pullRequest.body) === undefined
            ? {}
            : { implementationSummary: implementationSummary(pullRequest.body) }),
          human: {
            active: humanActive,
            draft: pullRequest.draft,
            label: humanLabel,
            comment: humanComment,
          },
          codeOwner: {
            required: candidate.approvalPolicy === 'human-codeowner',
            paths: candidate.approvalPolicy === 'human-codeowner'
              ? ['<current-head CODEOWNER surface>']
              : [],
          },
        },
        ...(child === undefined ? {} : { child }),
        ...(reviewClaim === undefined ? {} : { reviewClaim }),
        // The CLI observer has already authenticated the publisher's historical
        // Safe and exact Mech Deliver event inside the selected closed SolverNet.
        trustedOperatorIds: [],
        receiptAuthors: options.session.receiptAuthors,
        publisherLogin: manifest.selectedLogin,
      };
    },
  };
}

export interface ProductionMarketplaceMutationAdoptionOptions {
  readonly originManifestPath: string;
  readonly session: AutopilotSessionCapsule;
  readonly delivery: VerifiedMarketplaceSolutionDelivery;
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly reviewClaims: MarketplaceReviewClaimPort;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly onBoundary?: (
    boundary:
      | 'validated'
      | 'patch-applied'
      | 'verified'
      | 'committed'
      | 'checkpointed'
      | 'completed'
      | 'review-claimed'
      | 'receipt-published',
  ) => Promise<void> | void;
}

export function makeProductionMarketplaceMutationAdoptionCoordinator(
  options: ProductionMarketplaceMutationAdoptionOptions,
): MarketplaceMutationAdoptionCoordinator {
  const ambient = options.environment ?? process.env;
  const implementationEnvironment = { ...ambient };
  delete implementationEnvironment.GH_TOKEN;
  delete implementationEnvironment.GITHUB_TOKEN;
  implementationEnvironment.JINN_AUTOPILOT_SESSION_MANIFEST =
    options.originManifestPath;
  const implementation = makeImplementationSessionProtocol(
    makeProductionImplementationSessionPort({
      runner: options.runner ?? defaultRunner,
      environment: implementationEnvironment,
      now: options.now,
    }),
  );
  return makeMarketplaceMutationAdoptionCoordinator({
    deliveries: {
      async readVerifiedSolutionDelivery() {
        return options.delivery;
      },
    },
    authority: makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: options.originManifestPath,
      session: options.session,
      repositoryPath: options.repositoryPath,
      worktreeBase: options.worktreeBase,
      runnerId: options.runnerId,
      readSnapshot: options.readSnapshot,
      runner: options.runner,
      environment: ambient,
    }),
    git: makeMarketplaceMutationGitPort({
      runGit: defaultMarketplaceMutationGitRunner,
    }),
    verification: makeProductionMarketplaceVerificationPort(ambient),
    implementation,
    reviewClaims: options.reviewClaims,
    receipts: makeProductionMarketplaceAdoptionReceiptPorts({
      manifestPath: options.originManifestPath,
      runner: options.runner,
      environment: ambient,
    }),
    manifestReceipts: makeMarketplaceMutationManifestReceiptPort(),
    now: options.now,
    onBoundary: options.onBoundary,
  });
}

export function correlationForAnchoredReview(
  origin: AutopilotCorrelation,
  input: {
    readonly resultingHead: string;
    readonly reviewClaim: ConfirmedMarketplaceReviewClaim;
  },
): AutopilotCorrelation {
  return {
    ...origin,
    resultingHead: input.resultingHead,
    reviewedHead: input.resultingHead,
    reviewGeneration: input.reviewClaim.generation,
    reviewRefOid: input.reviewClaim.refOid,
  };
}
