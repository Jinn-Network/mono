import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import type {
  ClaimedMutationSessionInput,
  ClaimedSessionInput,
  ExecutionHandle,
  MarketplaceExecutionHandle,
  MutationWorkflow,
  SessionExecutionBackend,
} from './session-execution-backend.js';
import { gitOid, gitRefName } from './types.js';

const DEFAULT_CLI = 'jinn';
export const MARKETPLACE_CLAIM_WINDOW_MS = 15 * 60 * 1000;
export const MARKETPLACE_ADOPTION_RESERVE_MS = 30 * 60 * 1000;
export const MARKETPLACE_AGENT_SOFT_DEADLINE_MS = 60 * 60 * 1000;
const PRE_FLIGHT_ATTEMPT =
  '00000000-0000-4000-8000-000000000001';

interface MarketplaceSubmitOutput {
  readonly taskId: string;
  readonly taskCid: string;
  readonly creationTransactionHash: string;
  readonly creationBlockNumber: number;
  readonly solverNetManifestCid: string;
}

interface MarketplaceCancellation {
  readonly schemaVersion: 'jinn-autopilot-marketplace-cancellation.v1';
  readonly taskId: string;
  readonly reason: string;
}

export interface MarketplaceSessionBackendOptions {
  readonly runner?: CommandRunner;
  readonly cliBin?: string;
  readonly solverNetManifestCid?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

export interface MarketplaceSessionBackend extends SessionExecutionBackend {
  preflight(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
  recoverPreparing(manifestPath: string): Promise<MarketplaceExecutionHandle>;
}

function workflowContract(workflow: MutationWorkflow) {
  return {
    skill: workflow === 'implement'
      ? 'implement-issue'
      : workflow === 'reconcile'
        ? 'reconcile'
        : 'fix-child',
    version: 'v2',
    resultSchema: 'jinn-autopilot-mutation-result.v1',
  } as const;
}

function machineRequest(
  input: ClaimedMutationSessionInput,
  now: Date,
  solverNetManifestCid: string | undefined,
) {
  const createdAt = now.getTime();
  const agentDeadline = Date.parse(input.deadline);
  if (!Number.isFinite(agentDeadline) || agentDeadline <= createdAt) {
    throw new Error('Marketplace session deadline must be in the future');
  }
  const claimWindowEnd = createdAt + MARKETPLACE_CLAIM_WINDOW_MS;
  const submissionDeadline =
    agentDeadline + MARKETPLACE_ADOPTION_RESERVE_MS;
  if (agentDeadline <= claimWindowEnd) {
    throw new Error(
      'Marketplace session deadline must follow the claim window',
    );
  }
  const agentDurationMs = agentDeadline - createdAt;
  return {
    schemaVersion: 'jinn-task-submit-request.v1',
    id: `autopilot:${input.v2AttemptId}`,
    description:
      `Autopilot ${input.workflow} session for issue #${input.issue.number}`,
    solverType: 'jinn-repo.v1',
    ...(solverNetManifestCid === undefined
      ? {}
      : { solverNetManifestCid }),
    createdAt,
    window: {
      startTs: createdAt,
      endTs: submissionDeadline,
    },
    claimPolicy: {
      mode: 'exclusive',
      maxClaims: 1,
      maxClaimsPerOperator: 1,
      claimWindowStartTs: createdAt,
      claimWindowEndTs: claimWindowEnd,
      submissionDeadlineTs: submissionDeadline,
      claimLeaseTtlSeconds: Math.max(
        60,
        Math.min(3600, Math.floor(agentDurationMs / 1000)),
      ),
      requiredVerdicts: 1,
    },
    spec: {
      schemaVersion: 'jinn-repo.v1',
      source: 'autopilot-session',
      instance_id: `autopilot:${input.v2AttemptId}`,
      repo: 'Jinn-Network/mono',
      base_commit: input.expectedHead,
      language: 'typescript',
      problem_statement: `${input.issue.title}\n\n${input.issue.body}`,
      session: {
        schemaVersion: 'jinn-autopilot-session.v1',
        workflow: input.workflow,
        repository: 'Jinn-Network/mono',
        issueNumber: input.issue.number,
        ...(input.childIssueNumber === undefined
          ? {}
          : { childIssueNumber: input.childIssueNumber }),
        ...(input.parentPrNumber === undefined
          ? {}
          : { parentPrNumber: input.parentPrNumber }),
        prNumber: input.pr.number,
        targetBase: input.targetBase,
        branch: input.branch,
        claimOid: input.claimOid,
        expectedHead: input.expectedHead,
        v2AttemptId: input.v2AttemptId,
        runnerId: input.runnerId,
        taskSnapshot: {
          title: input.issue.title,
          body: input.issue.body,
          prBody: input.pr.body,
          baseSha: input.baseSha,
        },
        workflowContract: workflowContract(input.workflow),
        deadline: input.deadline,
        receiptAuthors: [...input.receiptAuthors],
      },
    },
  } as const;
}

function submissionDeadline(deadline: string): string {
  const parsed = Date.parse(deadline);
  if (!Number.isFinite(parsed)) {
    throw new Error('Marketplace session deadline is invalid');
  }
  return new Date(parsed + MARKETPLACE_ADOPTION_RESERVE_MS).toISOString();
}

function immutableJson(path: string, value: unknown): void {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== encoded) {
      throw new Error('Marketplace request file already exists with different content');
    }
    return;
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.tmp`,
  );
  try {
    writeFileSync(temporary, encoded, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function cancellationFile(handle: MarketplaceExecutionHandle): string {
  return join(dirname(handle.requestFile), 'marketplace-cancellation.json');
}

function readCancellation(
  handle: MarketplaceExecutionHandle,
): MarketplaceCancellation | null {
  const path = cancellationFile(handle);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('Marketplace cancellation record is malformed');
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).schemaVersion
      !== 'jinn-autopilot-marketplace-cancellation.v1'
    || (parsed as Record<string, unknown>).taskId !== handle.taskId
    || typeof (parsed as Record<string, unknown>).reason !== 'string'
  ) {
    throw new Error('Marketplace cancellation record does not match its task');
  }
  return parsed as unknown as MarketplaceCancellation;
}

export function marketplaceCommandEnvironment(
  ambient: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ambient)
      .filter((entry): entry is [string, string] => (
        entry[1] !== undefined
        && marketplaceEnvironmentKey(entry[0])
      )),
  );
}

const MARKETPLACE_PROCESS_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
]);

const MARKETPLACE_PROXY_ENVIRONMENT_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
]);

const MARKETPLACE_CERTIFICATE_ENVIRONMENT_KEYS = new Set([
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'AWS_CA_BUNDLE',
]);

function marketplaceEnvironmentKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (MARKETPLACE_PROCESS_ENVIRONMENT_KEYS.has(upper)) return true;
  if (upper.startsWith('LC_')) return true;
  if (MARKETPLACE_PROXY_ENVIRONMENT_KEYS.has(upper)) return true;
  if (MARKETPLACE_CERTIFICATE_ENVIRONMENT_KEYS.has(upper)) return true;
  if (upper === 'BASE_RPC_URL' || upper === 'BASE_SEPOLIA_RPC_URL') {
    return true;
  }
  return /^JINN_(?:CONFIG|STATE_DIR|EARNING_DIR|DB_PATH|NETWORK|PASSWORD|NODE_ENDPOINT|IPFS_(?:REGISTRY|GATEWAY)_URL|DISCOVERY_(?:MODE|URL|FALLBACK)|IDENTITY_REGISTRY_ADDRESS|VALIDATION_REGISTRY_ADDRESS|ROUTER_CLAIM_DELIVERY_VERSION|ENABLE_MAINNET|TESTNET_[A-Z0-9_]+_DEPLOYMENT|RPC_URL|[A-Z0-9_]+_RPC_URL)$/
    .test(upper);
}

function submitOutput(raw: string): MarketplaceSubmitOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Marketplace task submission returned malformed JSON');
  }
  const output = parsed as Record<string, unknown>;
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || typeof output.taskId !== 'string'
    || output.taskId === ''
    || typeof output.taskCid !== 'string'
    || output.taskCid === ''
    || typeof output.creationTx !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/.test(output.creationTx)
    || typeof output.creationBlock !== 'number'
    || !Number.isSafeInteger(output.creationBlock)
    || output.creationBlock < 0
    || typeof output.solverNetManifestCid !== 'string'
    || output.solverNetManifestCid === ''
  ) {
    throw new Error(
      'Marketplace task submission omitted Task identity or creation provenance',
    );
  }
  return {
    taskId: output.taskId,
    taskCid: output.taskCid,
    creationTransactionHash: output.creationTx,
    creationBlockNumber: output.creationBlock,
    solverNetManifestCid: output.solverNetManifestCid,
  };
}

function preflightInput(root: string, now: Date): ClaimedMutationSessionInput {
  const deadline = new Date(
    now.getTime() + MARKETPLACE_AGENT_SOFT_DEADLINE_MS,
  ).toISOString();
  return {
    kind: 'mutation',
    workflow: 'implement',
    issue: {
      number: 1,
      title: 'Autopilot marketplace preflight',
      body: 'Validate the configured one-shot marketplace submission path.',
    },
    pr: { number: 1, body: 'Autopilot marketplace preflight.' },
    targetBase: gitRefName('next'),
    branch: gitRefName('autopilot/preflight'),
    claimOid: gitOid('1'.repeat(40)),
    expectedHead: gitOid('1'.repeat(40)),
    baseSha: gitOid('0'.repeat(40)),
    v2AttemptId: PRE_FLIGHT_ATTEMPT,
    runnerId: 'preflight',
    selectedLogin: 'preflight',
    effort: null,
    deadline,
    receiptAuthors: ['preflight'],
    attempt: {
      manifestPath: join(root, 'manifest.json'),
      worktreePath: join(root, 'worktree'),
      logPath: join(root, 'session.log'),
      ghConfigDir: join(root, 'gh-config'),
      askpassPath: join(root, 'askpass'),
    },
  };
}

export function makeMarketplaceSessionBackend(
  options: MarketplaceSessionBackendOptions = {},
): MarketplaceSessionBackend {
  const runner = options.runner ?? defaultRunner;
  const cliBin = options.cliBin ?? DEFAULT_CLI;
  const solverNetManifestCid = options.solverNetManifestCid;
  const ambient = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());

  const runRequest = async (
    requestPath: string,
    dryRun: boolean,
  ): Promise<string> => runner(cliBin, [
    'tasks',
    'submit',
    '--request-file',
    requestPath,
    '--yes',
    '--json',
    ...(dryRun ? ['--dry-run'] : []),
  ], {
    env: marketplaceCommandEnvironment(ambient),
    replaceEnv: true,
  });

  const submit = async (
    input: ClaimedMutationSessionInput,
    dryRun: boolean,
  ): Promise<MarketplaceSubmitOutput | null> => {
    const requestPath = join(
      dirname(input.attempt.manifestPath),
      dryRun ? 'marketplace-preflight-request.json' : 'marketplace-request.json',
    );
    immutableJson(
      requestPath,
      machineRequest(input, now(), solverNetManifestCid),
    );
    const raw = await runRequest(requestPath, dryRun);
    if (dryRun) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new Error('Marketplace preflight returned malformed JSON');
      }
      if (
        typeof parsed !== 'object'
        || parsed === null
        || (parsed as Record<string, unknown>).dryRun !== true
      ) {
        throw new Error('Marketplace preflight did not confirm dry-run mode');
      }
      return null;
    }
    return submitOutput(raw);
  };

  return {
    async start(input: ClaimedSessionInput): Promise<ExecutionHandle> {
      if (input.kind !== 'mutation') {
        throw new Error(
          'Marketplace backend does not start standalone review sessions',
        );
      }
      const submitted = await submit(input, false);
      if (submitted === null) {
        throw new Error('Marketplace task submission produced no handle');
      }
      return {
        backend: 'marketplace',
        taskId: submitted.taskId,
        taskCid: submitted.taskCid,
        creationTransactionHash: submitted.creationTransactionHash,
        creationBlockNumber: submitted.creationBlockNumber,
        solverNetManifestCid: submitted.solverNetManifestCid,
        deadline: submissionDeadline(input.deadline),
        requestFile: join(
          dirname(input.attempt.manifestPath),
          'marketplace-request.json',
        ),
      };
    },

    async recover(handle) {
      if (handle.backend !== 'marketplace') {
        throw new Error('Marketplace backend cannot recover a local handle');
      }
      const cancellation = readCancellation(handle);
      if (cancellation !== null) {
        return { state: 'cancelled', detail: cancellation.reason };
      }
      if (now().getTime() >= Date.parse(handle.deadline)) {
        return {
          state: 'failed',
          detail: 'Marketplace task deadline expired',
        };
      }
      return { state: 'running' };
    },

    async cancel(handle: ExecutionHandle, reason: string): Promise<void> {
      if (handle.backend !== 'marketplace') {
        throw new Error('Marketplace backend cannot cancel a local handle');
      }
      immutableJson(cancellationFile(handle), {
        schemaVersion: 'jinn-autopilot-marketplace-cancellation.v1',
        taskId: handle.taskId,
        reason,
      } satisfies MarketplaceCancellation);
    },

    async preflight() {
      const root = mkdtempSync(join(tmpdir(), 'jinn-autopilot-marketplace-preflight-'));
      try {
        await submit(preflightInput(root, now()), true);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },

    async recoverPreparing(manifestPath) {
      const requestFile = join(
        dirname(manifestPath),
        'marketplace-request.json',
      );
      let request: unknown;
      try {
        request = JSON.parse(readFileSync(requestFile, 'utf8')) as unknown;
      } catch {
        throw new Error(
          'Preparing marketplace attempt is missing its immutable request',
        );
      }
      const sessionDeadline = (
        request as {
          spec?: { session?: { deadline?: unknown } };
        }
      ).spec?.session?.deadline;
      if (typeof sessionDeadline !== 'string') {
        throw new Error(
          'Preparing marketplace request omitted its session deadline',
        );
      }
      const submitted = submitOutput(await runRequest(requestFile, false));
      return {
        backend: 'marketplace',
        taskId: submitted.taskId,
        taskCid: submitted.taskCid,
        creationTransactionHash: submitted.creationTransactionHash,
        creationBlockNumber: submitted.creationBlockNumber,
        solverNetManifestCid: submitted.solverNetManifestCid,
        deadline: submissionDeadline(sessionDeadline),
        requestFile,
      };
    },
  };
}
