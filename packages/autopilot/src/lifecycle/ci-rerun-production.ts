import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import type { SelectedCredential } from './credentials.js';
import { fileChildIssue } from './child-issues.js';
import { makeProductionChildIssuePort } from './child-issues-production.js';
import { withSelectedCredential } from './production-auth.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import {
  executeFileCiFailureChildAction,
  executeRerunFailedChecksAction,
  type CiRerunDeps,
  type CiRerunExecutionResult,
  ciRerunRef,
  decodeCiRerunRecord,
  emptyTreeOid,
  encodeCiRerunRecord,
  type CiRerunRecord,
} from './ci-rerun.js';
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import { gitPublicationArgs } from './credentials.js';
import { gitOid, type GitOid, type PublicationOutcome } from './types.js';
import type { CheckSummary } from './types.js';

export interface ProductionCiRerunPortOptions {
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly repositoryPath: string;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
}

function formatFailedChecksBody(
  failed: readonly CheckSummary[],
): string {
  return failed.map((check) => [
    `- ${check.name}`,
    `  status=${check.status}`,
    `  conclusion=${check.conclusion ?? 'null'}`,
    ...(check.runId === undefined ? [] : [`  run_id=${check.runId}`]),
    ...(check.runAttempt === undefined ? [] : [`  run_attempt=${check.runAttempt}`]),
    ...(check.source === undefined ? [] : [`  source=${check.source}`]),
  ].join('\n')).join('\n');
}

async function readRefCommitMessage(
  run: CommandRunner,
  repositoryPath: string,
  askpass: string,
  environment: Record<string, string>,
  ref: string,
): Promise<string | null> {
  const raw = await run('git', [
    ...gitPublicationArgs(askpass, []),
    '-C', repositoryPath,
    'ls-remote', CANONICAL_GITHUB_HTTPS_REMOTE, ref,
  ], { env: environment });
  const line = raw.trimEnd().split('\n').find((entry) => entry.endsWith(`\t${ref}`));
  if (line === undefined) return null;
  const oid = line.split('\t')[0];
  if (oid === undefined || oid.length === 0) return null;
  return (await run('git', [
    ...gitPublicationArgs(askpass, []),
    '-C', repositoryPath,
    'cat-file', '-p', oid,
  ], { env: environment })).split('\n\n').slice(1).join('\n\n').trim();
}

async function publishCiRerunRecord(
  run: CommandRunner,
  repositoryPath: string,
  askpass: string,
  environment: Record<string, string>,
  record: CiRerunRecord,
): Promise<PublicationOutcome> {
  const ref = ciRerunRef(record.prNumber, record.head);
  const before = await run('git', [
    ...gitPublicationArgs(askpass, []),
    '-C', repositoryPath,
    'ls-remote', CANONICAL_GITHUB_HTTPS_REMOTE, ref,
  ], { env: environment }).catch(() => '');
  const beforeLine = before.trimEnd().split('\n').find((entry) => entry.endsWith(`\t${ref}`));
  const expectedRemoteOid = beforeLine === undefined
    ? null
    : gitOid(beforeLine.split('\t')[0]!);
  const published = gitOid((await run('git', [
    ...gitPublicationArgs(askpass, []),
    '-C', repositoryPath,
    'commit-tree', emptyTreeOid(),
    '-m', encodeCiRerunRecord(record),
  ], { env: environment })).trim());
  if (expectedRemoteOid === published) {
    return {
      status: 'already-applied',
      expected: expectedRemoteOid,
      published,
      observed: published,
    };
  }
  const lease = `--force-with-lease=${ref}:${expectedRemoteOid ?? ''}`;
  try {
    await run('git', [
      ...gitPublicationArgs(askpass, []),
      '-C', repositoryPath,
      'push', lease, CANONICAL_GITHUB_HTTPS_REMOTE, `${published}:${ref}`,
    ], { env: environment });
    return { status: 'won', expected: expectedRemoteOid, published, observed: published };
  } catch {
    const after = await run('git', [
      ...gitPublicationArgs(askpass, []),
      '-C', repositoryPath,
      'ls-remote', CANONICAL_GITHUB_HTTPS_REMOTE, ref,
    ], { env: environment }).catch(() => '');
    const afterLine = after.trimEnd().split('\n').find((entry) => entry.endsWith(`\t${ref}`));
    const observed = afterLine === undefined ? null : gitOid(afterLine.split('\t')[0]!);
    if (observed === published) {
      return { status: 'already-applied', expected: expectedRemoteOid, published, observed };
    }
    if (observed === expectedRemoteOid) {
      return { status: 'ambiguous', expected: expectedRemoteOid, published, observed };
    }
    return { status: 'lost', expected: expectedRemoteOid, published, observed };
  }
}

export function makeProductionCiRerunDeps(
  options: ProductionCiRerunPortOptions,
  credential: SelectedCredential,
): CiRerunDeps {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  return {
    readChecks: async (prNumber) => {
      const snapshot = await options.readSnapshot();
      const pr = snapshot.pullRequests.find((entry) => entry.number === prNumber);
      return pr?.checks ?? [];
    },
    readRecord: async (prNumber, head) => withSelectedCredential(
      credential,
      ambient,
      async ({ askpass, run, environment }) => {
        const message = await readRefCommitMessage(
          run,
          options.repositoryPath,
          askpass,
          environment,
          ciRerunRef(prNumber, head),
        );
        return message === null ? null : decodeCiRerunRecord(message);
      },
      runner,
    ),
    rerunFailedJobs: async (runId) => withSelectedCredential(
      credential,
      ambient,
      async ({ run }) => {
        await run('gh', [
          'api',
          `repos/${REPO}/actions/runs/${runId}/rerun-failed-jobs`,
          '-X', 'POST',
        ]);
      },
      runner,
    ),
    publishRecord: async (record) => withSelectedCredential(
      credential,
      ambient,
      async ({ askpass, run, environment }) => publishCiRerunRecord(
        run,
        options.repositoryPath,
        askpass,
        environment,
        record,
      ),
      runner,
    ),
    fileCiFailureChild: async ({ prNumber, head, classification, record }) =>
      withSelectedCredential(credential, ambient, async ({ run }) => {
        const port = makeProductionChildIssuePort({ runner: run });
        const filed = await fileChildIssue(port, {
          parentPr: prNumber,
          kind: 'ci-failure',
          title: `Fix CI for PR #${prNumber}`,
          body: [
            `Parent pull request: #${prNumber}`,
            `Head: ${head}`,
            '',
            'Failed checks:',
            formatFailedChecksBody(classification.failed),
            ...(record === undefined
              ? []
              : [
                  '',
                  'Rerun record:',
                  `requested-at=${record.requestedAt}`,
                  `run-ids=${record.runIds.join(',')}`,
                  `fingerprint=${record.fingerprint}`,
                ]),
          ].join('\n'),
          effort: 'medium',
          priority: 'p1',
        });
        if ('runawayHold' in filed && filed.runawayHold) {
          return { status: 'runaway-hold' as const, priorCount: filed.priorCount };
        }
        return {
          status: filed.created ? 'filed' as const : 'already-open' as const,
          childNumber: filed.number,
        };
      }, runner),
  };
}

function toRuntimeResult(result: CiRerunExecutionResult): {
  readonly status: string;
  readonly detail?: string;
  readonly reason?: string;
} {
  if (result.status === 'ineligible') {
    return { status: 'skipped', reason: result.reason };
  }
  if (result.status === 'waiting') {
    return { status: 'waiting', detail: result.reason };
  }
  if (result.status === 'rerun-requested') {
    return { status: 'rerun-requested', detail: `${result.prNumber}@${result.head}` };
  }
  if (result.status === 'runaway-hold') {
    return { status: 'runaway-hold', detail: String(result.priorCount) };
  }
  if (result.status === 'filed' || result.status === 'already-open') {
    return { status: result.status, detail: `child:${result.childNumber}` };
  }
  return { status: result.status };
}

export async function executeProductionRerunFailedChecks(
  action: { readonly prNumber: number; readonly head: GitOid },
  options: ProductionCiRerunPortOptions,
  credential: SelectedCredential,
): Promise<ReturnType<typeof toRuntimeResult>> {
  const result = await executeRerunFailedChecksAction(action, makeProductionCiRerunDeps(
    options,
    credential,
  ));
  return toRuntimeResult(result);
}

export async function executeProductionFileCiFailureChild(
  action: { readonly prNumber: number; readonly head: GitOid },
  options: ProductionCiRerunPortOptions,
  credential: SelectedCredential,
): Promise<ReturnType<typeof toRuntimeResult>> {
  const result = await executeFileCiFailureChildAction(action, makeProductionCiRerunDeps(
    options,
    credential,
  ));
  return toRuntimeResult(result);
}
