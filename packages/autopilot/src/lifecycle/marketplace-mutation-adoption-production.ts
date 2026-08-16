import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import type {
  AutopilotAdoptionReceipt,
  AutopilotCorrelation,
  AutopilotSessionCapsule,
} from '@jinn-network/sdk/autopilot';
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
  decodeReviewClaimPayload,
  formatAutomatedReviewMarker,
} from './codecs.js';
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
import type { ReviewClaimRecord } from './types.js';
import {
  makeProductionReviewActionPort,
} from './review-executor-production.js';
import { assertReviewClaimTransition } from './review-session.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import { gitOid } from './types.js';

const GITHUB_PAGE_SIZE = 100;
const VERIFICATION_TIMEOUT_MS = 15 * 60_000;
const VERIFICATION_TOTAL_TIMEOUT_MS = 25 * 60_000;
const VERIFICATION_CLEANUP_TIMEOUT_MS = 30_000;
const VERIFICATION_PREFLIGHT_TIMEOUT_MS = 60_000;
const VERIFICATION_OUTPUT_LIMIT = 1024 * 1024;
const VERIFICATION_IMAGE =
  'node:22-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37';
const VERIFICATION_INSTALL_ORDER = [
  'packages/sdk',
  'packages/plugin',
  'packages/core',
  'packages/layer',
  'packages/indexer',
  'packages/indexer-enrichment',
  'operator',
  'contracts',
  'packages/autopilot',
  'apps/broadcast-bot',
] as const;
const VERIFICATION_BOOTSTRAP_ORDER = [
  'packages/sdk',
  'packages/plugin',
  'packages/core',
  'packages/layer',
] as const;

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

function parseComment(value: unknown): AdoptionReceiptComment | null {
  try {
    const comment = record(value, 'GitHub adoption comment');
    const user = record(comment.user, 'GitHub adoption comment author');
    return {
      id: positiveInteger(comment.id, 'GitHub adoption comment ID'),
      authorLogin: stringField(user.login, 'GitHub adoption comment login'),
      body: stringField(comment.body, 'GitHub adoption comment body'),
      createdAt: stringField(
        comment.created_at,
        'GitHub adoption comment creation',
      ),
      updatedAt: stringField(
        comment.updated_at,
        'GitHub adoption comment update',
      ),
    };
  } catch {
    // Deleted users and nullable legacy bodies cannot authenticate an
    // adoption receipt. Ignore those unrelated rows without degrading the
    // availability of a valid authorized receipt elsewhere on the page.
    return null;
  }
}

function pullRequestFacts(raw: string): {
  readonly head: string;
  readonly labels: readonly string[];
} {
  const value = record(JSON.parse(raw) as unknown, 'GitHub pull request');
  const rawLabels = value.labels;
  if (rawLabels !== undefined && !Array.isArray(rawLabels)) {
    throw new Error('Malformed GitHub pull request labels');
  }
  const labels = (rawLabels ?? []).map((entry) => {
    const label = record(entry, 'GitHub pull request label');
    return stringField(label.name, 'GitHub pull request label name');
  });
  return {
    head: gitOid(stringField(value.headRefOid, 'GitHub pull request head')),
    labels,
  };
}

async function verifyAcceptedReviewAuthority(input: {
  readonly receipt: Extract<
    AutopilotAdoptionReceipt,
    { readonly disposition: 'accepted' }
  >;
  readonly manifest: AttemptManifest;
  readonly run: CommandRunner;
  readonly prHead: string;
  readonly prLabels: readonly string[];
}): Promise<boolean> {
  const { receipt, manifest, run, prHead, prLabels } = input;
  if (
    receipt.reviewGeneration === undefined
    || receipt.reviewRefOid === undefined
  ) {
    return false;
  }
  const ref = `refs/jinn-autopilot/review-claims/v1/${receipt.prNumber}`;
  const lines = (await run('git', [
    '-C', manifest.paths.worktree,
    'ls-remote', manifest.repository.remoteName, ref,
  ])).trim().split('\n').filter(Boolean);
  if (lines.length !== 1) return false;
  const [currentOid, observedRef, extra] = lines[0]!.split('\t');
  if (
    currentOid === undefined
    || !/^[0-9a-f]{40}$/.test(currentOid)
    || observedRef !== ref
    || extra !== undefined
  ) {
    return false;
  }
  await run('git', [
    '-C', manifest.paths.worktree,
    'fetch', '--quiet', manifest.repository.remoteName, ref,
  ]);
  const historyOids = (await run('git', [
    '-C', manifest.paths.worktree,
    'rev-list', '--first-parent', '--max-count=64', currentOid,
  ])).trim().split('\n').filter(Boolean);
  if (
    historyOids.length === 0
    || historyOids[0] !== currentOid
    || !historyOids.every((oid) => /^[0-9a-f]{40}$/.test(oid))
  ) {
    return false;
  }
  const records: Array<{ oid: string; record: ReviewClaimRecord }> = [];
  for (const oid of historyOids) {
    records.push({
      oid,
      record: decodeReviewClaimPayload((await run('git', [
        '-C', manifest.paths.worktree,
        'show', `${oid}:jinn-autopilot-review.json`,
      ])).trim()),
    });
  }
  const currentEntry = records[0]!;
  const current = currentEntry.record;
  const exactHead = receipt.role === 'solution'
    ? receipt.resultingHead
    : receipt.reviewedHead;
  if (receipt.role === 'solution') {
    return currentOid === receipt.reviewRefOid
      && current.state === 'active'
      && current.prNumber === receipt.prNumber
      && current.generation === receipt.reviewGeneration
      && current.head === exactHead
      && prHead === exactHead;
  }
  const requiredState = receipt.operation === 'review-verdict'
    ? 'terminal-approved'
    : receipt.operation === 'review-findings'
      ? 'stale'
      : 'human';
  const rootIndex = records.findIndex(
    ({ oid }) => oid === receipt.reviewRefOid,
  );
  const root = records[rootIndex];
  if (
    root === undefined
    || root.record.state !== 'active'
    || root.record.prNumber !== receipt.prNumber
    || root.record.generation !== receipt.reviewGeneration
    || root.record.head !== exactHead
    || root.record.reviewer.toLowerCase()
      !== manifest.selectedLogin.toLowerCase()
  ) {
    return false;
  }
  try {
    for (let index = rootIndex - 1; index >= 0; index -= 1) {
      assertReviewClaimTransition(
        records[index]!.record,
        records[index + 1]!.record,
      );
    }
  } catch {
    return false;
  }
  const terminalIndex = records.findIndex(({ record }, index) =>
    index < rootIndex
    && record.generation === root.record.generation
    && record.attempt === root.record.attempt
    && record.reviewer.toLowerCase() === root.record.reviewer.toLowerCase()
    && record.head === root.record.head
    && record.state === requiredState);
  const terminal = records[terminalIndex];
  if (terminal === undefined) return false;
  const historical = terminal.oid !== currentEntry.oid;
  if (
    prHead !== exactHead
    && !(historical && current.head === prHead)
  ) {
    return false;
  }
  if (receipt.operation === 'human') {
    return historical || prLabels.includes('review:needs-human');
  }
  if (
    !historical
    && (
      receipt.operation === 'review-verdict'
        ? (
          !prLabels.includes('review:approved')
          || prLabels.includes('review:changes-requested')
          || prLabels.includes('review:needs-human')
        )
        : (
          !prLabels.includes('review:changes-requested')
          || prLabels.includes('review:approved')
          || prLabels.includes('review:needs-human')
        )
    )
  ) {
    return false;
  }
  if (receipt.operation === 'review-findings') {
    const rawChild = record(JSON.parse(await run('gh', [
      'issue', 'view', String(receipt.childIssueNumber),
      '--repo', REPO,
      '--json', 'number,state,body,labels',
    ])) as unknown, 'GitHub review-finding child');
    const childLabels = rawChild.labels;
    if (!Array.isArray(childLabels)) return false;
    const labels = childLabels.map((entry) =>
      stringField(
        record(entry, 'GitHub review-finding child label').name,
        'GitHub review-finding child label name',
      ));
    const marker =
      `<!-- jinn-autopilot:child pr=${receipt.prNumber} kind=review-finding -->`;
    const body = typeof rawChild.body === 'string' ? rawChild.body : '';
    const canonicalMarkers = body.match(
      /<!-- jinn-autopilot:child pr=\d+ kind=(?:review-finding|reconcile|ci-failure) -->/g,
    ) ?? [];
    if (
      rawChild.number !== receipt.childIssueNumber
      || (!historical && rawChild.state !== 'OPEN')
      || (historical
        && rawChild.state !== 'OPEN'
        && rawChild.state !== 'CLOSED')
      || !(body === marker || body.startsWith(`${marker}\n`))
      || canonicalMarkers.length !== 1
      || !labels.includes('review-finding')
      || !labels.includes('effort:medium')
      || !labels.includes('priority:p1')
    ) {
      return false;
    }
  }
  const requiredVerdict = receipt.operation === 'review-verdict'
    ? 'APPROVE'
    : 'REQUEST_CHANGES';
  const intent = records.find(({ record }, index) =>
    index >= terminalIndex
    && index < rootIndex
    && record.state === 'verdict-intent'
    && record.generation === root.record.generation
    && record.attempt === root.record.attempt
    && record.reviewer.toLowerCase() === root.record.reviewer.toLowerCase()
    && record.head === root.record.head
    && record.verdict?.state === requiredVerdict
  )?.record;
  if (intent?.verdict === undefined) return false;
  const marker = formatAutomatedReviewMarker({
    generation: intent.generation,
    attempt: intent.attempt,
    intent: intent.verdict.marker,
    reviewer: intent.reviewer,
    head: intent.head,
    verdict: intent.verdict.state,
  });
  const rawReviews = JSON.parse(await run('gh', [
    'api', `repos/${REPO}/pulls/${receipt.prNumber}/reviews`,
    '--paginate', '--slurp',
  ])) as unknown;
  if (
    !Array.isArray(rawReviews)
    || !rawReviews.every((page) => Array.isArray(page))
  ) {
    return false;
  }
  const nativeState = requiredVerdict === 'APPROVE'
    ? 'APPROVED'
    : 'CHANGES_REQUESTED';
  const parsedReviews: Record<string, unknown>[] = [];
  for (const value of rawReviews.flat()) {
    if (value === null || typeof value !== 'object') continue;
    const review = value as Record<string, unknown>;
    const user = review.user;
    const login = user !== null && typeof user === 'object'
      ? (user as { login?: unknown }).login
      : undefined;
    const state = String(review.state);
    if (
      typeof login !== 'string'
      || typeof review.submitted_at !== 'string'
      || typeof review.commit_id !== 'string'
      || typeof review.body !== 'string'
      || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']
        .includes(state)
    ) {
      if (state === 'CHANGES_REQUESTED') {
        parsedReviews.push({
          ...review,
          user: {
            login: `@unattributed-review:${String(review.id)}`,
          },
          submitted_at: '0001-01-01T00:00:00.000Z',
          commit_id: '',
          body: '',
        });
      }
      continue;
    }
    parsedReviews.push(review);
  }
  const effective = new Map<string, Record<string, unknown>>();
  for (const review of parsedReviews) {
    const user = review.user as { login: string };
    const login = user.login;
    const key = login.toLowerCase();
    const prior = effective.get(key);
    if (
      prior === undefined
      || String(prior.submitted_at).localeCompare(
        String(review.submitted_at),
      ) < 0
    ) {
      effective.set(key, review);
    }
  }
  const reviews = historical ? parsedReviews : [...effective.values()];
  if (
    !historical
    &&
    receipt.operation === 'review-verdict'
    && [...effective.values()].some((review) =>
      review.state === 'CHANGES_REQUESTED')
  ) {
    return false;
  }
  return reviews.some((review) => {
    const user = review.user;
    return user !== null
      && typeof user === 'object'
      && (user as { login?: unknown }).login === intent.reviewer
      && review.state === nativeState
      && review.commit_id === intent.head
      && typeof review.body === 'string'
      && review.body.includes(marker);
  });
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
  const manifest = readAttemptManifest(options.manifestPath);
  const run = secureGitHubRunner(
    options.manifestPath,
    options.runner ?? defaultRunner,
    options.environment ?? process.env,
  );
  const readPullRequestFacts = async (prNumber: number) =>
    pullRequestFacts(await run('gh', [
      'pr', 'view', String(prNumber),
      '--repo', REPO,
      '--json', 'headRefOid,labels',
    ]));
  const readHead = async (prNumber: number): Promise<string> =>
    (await readPullRequestFacts(prNumber)).head;
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
      const comments = raw
        .map(parseComment)
        .filter((comment): comment is AdoptionReceiptComment => comment !== null);
      return {
        comments,
        ...(raw.length === GITHUB_PAGE_SIZE
          ? { nextCursor: String(page + 1) }
          : {}),
      };
    },
    async verifyReceiptFacts({ exactFacts, receipt }) {
      if (receipt.disposition !== 'accepted') return true;
      const pr = await readPullRequestFacts(exactFacts.correlation.prNumber);
      return verifyAcceptedReviewAuthority({
        receipt,
        manifest,
        run,
        prHead: pr.head,
        prLabels: pr.labels,
      });
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
  timeoutMs = VERIFICATION_TIMEOUT_MS,
): Promise<VerificationCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...args], {
      env: dockerEnvironment(ambient),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let forcedKill: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;
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
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      resolve(result);
    };
    const stop = (detail: string): void => {
      if (forcedFailure !== undefined) return;
      forcedFailure = detail;
      killGroup('SIGTERM');
      forcedKill = setTimeout(() => {
        killGroup('SIGKILL');
        reapTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new MarketplaceVerificationUnreapedError());
        }, 5_000);
        reapTimer.unref();
      }, 5_000);
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
      stop(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timeout.unref();
  });
}

export type VerificationDockerRunner = (
  args: readonly string[],
  label: string,
  timeoutMs?: number,
) => Promise<VerificationCommandResult>;

export class MarketplaceVerificationUnreapedError extends Error {
  readonly cleanupUnsafe = true;

  constructor() {
    super('Docker verification process did not close after SIGKILL');
    this.name = 'MarketplaceVerificationUnreapedError';
  }
}

function dockerSandboxArgs(input: {
  readonly name: string;
  readonly repositoryPath: string;
}): string[] {
  return [
    'run',
    '--detach',
    '--rm',
    '--name', input.name,
    '--label', 'jinn.autopilot.verification=true',
    '--network', 'bridge',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '512',
    '--memory', '8g',
    '--cpus', '4',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864',
    '--tmpfs', '/workspace:rw,nosuid,nodev,size=6442450944',
    '--mount',
    `type=bind,src=${input.repositoryPath},dst=/source,readonly`,
    '--env', 'HOME=/workspace/.jinn-home',
    '--env', 'XDG_CACHE_HOME=/workspace/.jinn-home/cache',
    '--env', 'COREPACK_HOME=/workspace/.jinn-corepack',
    '--env', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    '--env', 'YARN_IGNORE_PATH=1',
    '--env', 'YARN_NODE_LINKER=node-modules',
    '--env', 'YARN_ENABLE_SCRIPTS=false',
    '--env', 'CI=1',
    VERIFICATION_IMAGE,
    'sh',
    '-ceu',
    // The container outlives a crashing host only for a bounded period, then
    // --rm reclaims its tmpfs and network attachment.
    'sleep 7200',
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
    readonly containerName?: () => string;
  } = {},
): MarketplaceMutationVerificationPort {
  const runDocker: VerificationDockerRunner =
    options.runDocker
    ?? ((args, _label, timeoutMs) =>
      runDockerCommand(args, environment, timeoutMs));
  const makeContainerName =
    options.containerName
    ?? (() => `jinn-autopilot-verify-${randomUUID()}`);
  const nativeToolchainSmoke = [
    'set -eu',
    'test -f /usr/local/include/node/node.h',
    'command -v python3 >/dev/null',
    'command -v make >/dev/null',
    'command -v g++ >/dev/null',
    'mkdir -p /tmp/native-smoke',
    "printf '%s\\n' '{\"targets\":[{\"target_name\":\"smoke\",\"sources\":[\"smoke.cc\"]}]}'"
      + ' > /tmp/native-smoke/binding.gyp',
    "printf '%s\\n' '#include <node.h>'"
      + " 'void Init(v8::Local<v8::Object> exports) {}'"
      + " 'NODE_MODULE(NODE_GYP_MODULE_NAME, Init)'"
      + ' > /tmp/native-smoke/smoke.cc',
    'cd /tmp/native-smoke',
    'npm_config_nodedir=/usr/local'
      + ' node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js'
      + ' rebuild --offline',
    "node -e \"require('/tmp/native-smoke/build/Release/smoke.node')\"",
  ].join('; ');
  return {
    async preflight() {
      const checks: ReadonlyArray<{
        readonly args: readonly string[];
        readonly label: string;
      }> = [
        {
          args: ['info', '--format', '{{json .ServerVersion}}'],
          label: 'docker-readiness',
        },
        {
          args: ['image', 'inspect', VERIFICATION_IMAGE],
          label: 'verification-image-inspect',
        },
        {
          args: [
            'run',
            '--rm',
            '--network', 'none',
            '--read-only',
            '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true',
            '--pids-limit', '64',
            '--memory', '512m',
            '--cpus', '1',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=134217728',
            VERIFICATION_IMAGE,
            'sh',
            '-ceu',
            nativeToolchainSmoke,
          ],
          label: 'verification-native-toolchain-smoke',
        },
      ];
      for (const check of checks) {
        try {
          const result = await runDocker(
            check.args,
            check.label,
            VERIFICATION_PREFLIGHT_TIMEOUT_MS,
          );
          if (result.status === 'failed') {
            return {
              ok: false,
              detail: `${check.label}: ${result.detail}`,
            };
          }
        } catch (error) {
          return {
            ok: false,
            detail:
              `${check.label}: `
              + (error instanceof Error ? error.message : String(error)),
          };
        }
      }
      return { ok: true };
    },
    async verify(input: MarketplaceMutationVerificationInput) {
      const plan = buildJinnMonoV1VerificationPlan(input);
      const container = makeContainerName();
      if (!/^jinn-autopilot-verify-[a-zA-Z0-9_.-]+$/.test(container)) {
        throw new Error('Invalid marketplace verification container name');
      }
      let containerCreated = false;
      let cleanupSafe = true;
      const suppliedDeadline = input.deadline === undefined
        ? Number.POSITIVE_INFINITY
        : Date.parse(input.deadline);
      if (!Number.isFinite(suppliedDeadline) && input.deadline !== undefined) {
        throw new Error('Marketplace verification deadline is invalid');
      }
      const verificationDeadline = Math.min(
        Date.now() + VERIFICATION_TOTAL_TIMEOUT_MS,
        suppliedDeadline,
      );
      const run = async (
        args: readonly string[],
        label: string,
      ): Promise<VerificationCommandResult> => {
        const remainingMs = verificationDeadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error('Docker verification exceeded its total deadline');
        }
        try {
          return await runDocker(
            args,
            label,
            Math.min(VERIFICATION_TIMEOUT_MS, remainingMs),
          );
        } catch (error) {
          if (error instanceof MarketplaceVerificationUnreapedError) {
            cleanupSafe = false;
          }
          throw error;
        }
      };
      const create = await run(
        dockerSandboxArgs({
          name: container,
          repositoryPath: input.repositoryPath,
        }),
        'sandbox-container-create',
      );
      if (create.status === 'failed') {
        throw new Error(`Docker verification container creation failed: ${create.detail}`);
      }
      containerCreated = true;
      try {
        const seed = await run([
          'exec',
          '--workdir', '/workspace',
          container,
          'sh',
          '-ceu',
          "tar -C /source --exclude='.git' --exclude='node_modules'"
            + " --exclude='*/node_modules' --exclude='dist' --exclude='*/dist'"
            + " --exclude='.yarn/cache' --exclude='*/.yarn/cache'"
            + ' -cf - . | tar -C /workspace -xf -',
        ], 'sandbox-source-copy');
        if (seed.status === 'failed') {
          throw new Error(`Docker verification snapshot failed: ${seed.detail}`);
        }

        const commands: string[] = [];
        const installCommands = plan.commands.filter((command) =>
          command.label.endsWith(':install')
        );
        const plannedRoots = installCommands.map((command) =>
          command.label.slice(0, -':install'.length)
        );
        const requiredRoots = new Set(plannedRoots);
        if (
          plannedRoots.includes('packages/indexer')
          || plannedRoots.includes('packages/indexer-enrichment')
          || plannedRoots.includes('operator')
        ) {
          requiredRoots.add('packages/sdk');
        }
        if (
          plannedRoots.includes('packages/core')
          || plannedRoots.includes('packages/layer')
          || plannedRoots.includes('operator')
        ) {
          requiredRoots.add('packages/plugin');
        }
        if (
          plannedRoots.includes('packages/layer')
          || plannedRoots.includes('operator')
        ) {
          requiredRoots.add('packages/core');
        }
        if (plannedRoots.includes('operator')) {
          requiredRoots.add('packages/layer');
        }
        const installRoots = VERIFICATION_INSTALL_ORDER.filter((root) =>
          requiredRoots.has(root)
        );
        const checkCommands = plan.commands.filter((command) =>
          !command.label.endsWith(':install')
        );
        for (const root of installRoots) {
          const label = `${root}:install`;
          commands.push(label);
          const result = await run([
            'exec',
            '--workdir',
            `/workspace/${root}`,
            container,
            'corepack',
            'yarn@4.13.0',
            'install',
            '--immutable',
            '--mode=skip-build',
          ], label);
          if (result.status === 'failed') {
            return {
              profile: plan.profile,
              status: 'failed' as const,
              workspaces: plan.workspaces,
              commands,
              failedCommand: label,
              detail: result.detail,
            };
          }
        }
        const disconnected = await run(
          ['network', 'disconnect', 'bridge', container],
          'sandbox-network-disconnect',
        );
        if (disconnected.status === 'failed') {
          throw new Error(
            `Docker verification network isolation failed: ${disconnected.detail}`,
          );
        }
        for (const root of installRoots.filter((value) =>
          value === 'packages/core'
          || value === 'packages/layer'
          || value === 'operator')) {
          const label = `${root}:trusted-native-rebuild`;
          const rebuilt = await run([
            'exec',
            '--env', 'YARN_ENABLE_SCRIPTS=true',
            '--env', 'npm_config_nodedir=/usr/local',
            '--env', 'npm_config_build_from_source=true',
            '--workdir', `/workspace/${root}`,
            container,
            'corepack',
            'yarn@4.13.0',
            'rebuild',
            'better-sqlite3',
          ], label);
          if (rebuilt.status === 'failed') {
            throw new Error(
              `Trusted native dependency rebuild failed: ${rebuilt.detail}`,
            );
          }
          const loaded = await run([
            'exec',
            '--workdir', `/workspace/${root}`,
            container,
            'node',
            '-e',
            "const Database=require('better-sqlite3');"
              + "const db=new Database(':memory:');"
              + "db.exec('create table smoke(value integer);"
              + "insert into smoke values (1)');"
              + "if(db.prepare('select value from smoke').get().value!==1)"
              + "process.exit(1);db.close()",
          ], `${root}:trusted-native-smoke`);
          if (loaded.status === 'failed') {
            throw new Error(
              `Trusted native dependency smoke failed: ${loaded.detail}`,
            );
          }
        }
        for (const root of VERIFICATION_BOOTSTRAP_ORDER.filter((value) =>
          requiredRoots.has(value)
        )) {
          const label = `${root}:trusted-bootstrap-build`;
          const built = await run([
            'exec',
            '--workdir', `/workspace/${root}`,
            container,
            'corepack',
            'yarn@4.13.0',
            'build',
          ], label);
          if (built.status === 'failed') {
            throw new Error(
              `Trusted portal dependency bootstrap failed: ${built.detail}`,
            );
          }
        }
        for (const command of checkCommands) {
          commands.push(command.label);
          const args = [...command.args];
          if (args[0] === 'yarn') args[0] = 'yarn@4.13.0';
          const result = await run([
            'exec',
            '--workdir',
            containerWorkingDirectory(input.repositoryPath, command),
            container,
            command.command,
            ...args,
          ], command.label);
          if (result.status === 'failed') {
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
        if (containerCreated && cleanupSafe) {
          const removed = await runDocker(
            ['rm', '-f', container],
            'sandbox-container-remove',
            VERIFICATION_CLEANUP_TIMEOUT_MS,
          );
          if (removed.status === 'failed') {
            throw new Error(
              `Docker verification container cleanup failed: ${removed.detail}`,
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
      const lifecycle = (await options.readSnapshot()).lifecycle.items.find(
        (item) =>
          item.kind === 'pull-request'
          && item.prNumber === options.session.prNumber,
      );
      if (
        lifecycle === undefined
        || lifecycle.kind !== 'pull-request'
        || lifecycle.head !== pullRequest.head
      ) {
        throw new Error(
          'Marketplace authority lifecycle eligibility did not converge',
        );
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
          openChildKinds: [...(lifecycle.openChildKinds ?? [])],
          ...(lifecycle.terminalVerdict === undefined
            ? {}
            : {
                terminalVerdict: {
                  head: lifecycle.terminalVerdict.head,
                  state: lifecycle.terminalVerdict.state,
                },
              }),
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
  readonly verification?: MarketplaceMutationVerificationPort;
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
    verification:
      options.verification
      ?? makeProductionMarketplaceVerificationPort(ambient),
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
