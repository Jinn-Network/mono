import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  decodeAttemptManifest,
  readAttemptManifest,
  type AttemptManifest,
} from '../lifecycle/attempt-workspace.js';
import { makeImplementationSessionProtocol } from '../lifecycle/implementation-session.js';
import type {
  CheckpointResult,
  HumanHoldResult,
  ImplementationCompleteResult,
} from '../lifecycle/implementation-session.js';
import { makeProductionImplementationSessionPort } from '../lifecycle/implementation-session-production.js';
import { makeReviewSessionProtocol } from '../lifecycle/review-session.js';
import type {
  ReviewFindingsResult,
  ReviewVerdictResult,
} from '../lifecycle/review-session.js';
import { makeProductionReviewSessionPort } from '../lifecycle/review-session-production.js';
import { childrenPathEnabled } from '../lifecycle/child-issues.js';
import {
  parseReviewFollowUpsPayload,
  type ReviewFollowUpEntry,
} from '../lifecycle/review-follow-ups.js';
import type { ReviewVerdictState } from '../lifecycle/types.js';

export interface SessionProtocol {
  checkpoint(manifest: AttemptManifest): Promise<CheckpointResult>;
  implementationComplete(
    manifest: AttemptManifest,
    summary: string,
  ): Promise<ImplementationCompleteResult>;
  reviewVerdict(
    manifest: AttemptManifest,
    state: ReviewVerdictState,
    body: string,
    followUps?: readonly ReviewFollowUpEntry[],
  ): Promise<ReviewVerdictResult>;
  reviewFindings?(
    manifest: AttemptManifest,
    findings: string,
  ): Promise<ReviewFindingsResult>;
  childComplete?(
    manifest: AttemptManifest,
  ): Promise<{ readonly status: 'closed' | 'rejected'; readonly detail?: string }>;
  human(manifest: AttemptManifest, reason: string): Promise<HumanHoldResult>;
}

export interface SessionCliDeps {
  readonly protocol?: SessionProtocol;
  readonly env?: NodeJS.ProcessEnv;
  readonly readManifest?: (path: string) => AttemptManifest;
  readonly readTextFile?: (path: string) => string;
  readonly validateReportFile?: (
    reportsDirectory: string,
    candidate: string,
  ) => string;
  readonly writeOutput?: (output: string) => void;
  readonly setExitCode?: (exitCode: number) => void;
}

type ParsedSessionCommand =
  | { readonly operation: 'checkpoint' }
  | {
      readonly operation: 'implementation-complete';
      readonly summaryFile: string;
    }
  | {
      readonly operation: 'review-verdict';
      readonly state: ReviewVerdictState;
      readonly bodyFile: string;
      readonly followUpsFile?: string;
    }
  | {
      readonly operation: 'review-findings';
      readonly file: string;
    }
  | { readonly operation: 'child-complete' }
  | {
      readonly operation: 'human';
      readonly reasonFile: string;
    };

type SessionOperationOutcome =
  | CheckpointResult
  | ImplementationCompleteResult
  | ReviewVerdictResult
  | ReviewFindingsResult
  | HumanHoldResult
  | { readonly status: 'closed' | 'rejected'; readonly detail?: string };

export interface SessionCliExecution {
  readonly operation: ParsedSessionCommand['operation'];
  readonly outcome: SessionOperationOutcome;
  readonly exitCode: 0 | 2;
}

const USAGE =
  'usage: autopilot session checkpoint | ' +
  'implementation-complete --summary-file <path> | ' +
  'review-verdict --state <APPROVE|REQUEST_CHANGES> --body-file <path> [--follow-ups-file <path>] | ' +
  'review-findings --file <path> | child-complete | ' +
  'human --reason-file <path>';
const MAX_SESSION_TEXT_BYTES = 65_536;

function boundedText(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_SESSION_TEXT_BYTES) {
    throw new Error('Session text file exceeds the 65,536 bytes limit');
  }
  return value;
}

export function readBoundedUtf8File(path: string): string {
  try {
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) {
        throw new Error('Session text file must be a regular file');
      }
      if (stat.size > MAX_SESSION_TEXT_BYTES) {
        throw new Error('Session text file exceeds the 65,536 bytes limit');
      }
      const bytes = readFileSync(descriptor);
      try {
        return boundedText(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
      } catch (error) {
        if (error instanceof TypeError) {
          throw new Error('Session text file must contain valid UTF-8');
        }
        throw error;
      }
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ELOOP'
    ) {
      throw new Error('Session text file must not be a symbolic link');
    }
    throw error;
  }
}

function requiredPath(value: string | undefined, option: string): string {
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${option} requires a path; ${USAGE}`);
  }
  return value;
}

function attemptReportPath(
  manifest: AttemptManifest,
  suppliedPath: string,
  validateReportFile: NonNullable<SessionCliDeps['validateReportFile']>,
): string {
  const reportsDirectory = resolve(
    dirname(manifest.paths.manifest),
    'reports',
  );
  const candidate = resolve(suppliedPath);
  const fromReports = relative(reportsDirectory, candidate);
  if (
    !isAbsolute(suppliedPath)
    || fromReports === ''
    || fromReports === '..'
    || fromReports.startsWith(`..${sep}`)
    || isAbsolute(fromReports)
  ) {
    throw new Error(
      'Session payload must be a file in the attempt reports directory',
    );
  }
  return validateReportFile(reportsDirectory, candidate);
}

export function validateAttemptReportFile(
  reportsDirectory: string,
  candidate: string,
): string {
  const reportsStat = lstatSync(reportsDirectory);
  const candidateStat = lstatSync(candidate);
  if (
    reportsStat.isSymbolicLink()
    || !reportsStat.isDirectory()
    || candidateStat.isSymbolicLink()
    || !candidateStat.isFile()
  ) {
    throw new Error(
      'Session payload must be a regular non-symbolic file in the attempt reports directory',
    );
  }
  const realReports = realpathSync(reportsDirectory);
  const realCandidate = realpathSync(candidate);
  const fromReports = relative(realReports, realCandidate);
  if (
    fromReports === ''
    || fromReports === '..'
    || fromReports.startsWith(`..${sep}`)
    || isAbsolute(fromReports)
  ) {
    throw new Error(
      'Session payload real path escapes the attempt reports directory',
    );
  }
  return realCandidate;
}

function parseSessionCommand(argv: readonly string[]): ParsedSessionCommand {
  const command = argv[0];
  if (command === undefined) throw new Error(USAGE);
  switch (command) {
    case 'checkpoint':
      if (argv.length !== 1) throw new Error(`checkpoint has unknown or trailing input; ${USAGE}`);
      return { operation: command };
    case 'implementation-complete':
      if (argv.length !== 3 || argv[1] !== '--summary-file') {
        throw new Error(`implementation-complete requires --summary-file <path>; ${USAGE}`);
      }
      return {
        operation: command,
        summaryFile: requiredPath(argv[2], '--summary-file'),
      };
    case 'review-verdict': {
      const flags = new Map<string, string>();
      for (let i = 1; i < argv.length; i += 1) {
        const key = argv[i];
        if (key === undefined || !key.startsWith('--')) {
          throw new Error(
            'review-verdict requires --state <APPROVE|REQUEST_CHANGES> --body-file <path>; ' +
            USAGE,
          );
        }
        if (flags.has(key)) {
          throw new Error(`review-verdict duplicate flag ${key}; ${USAGE}`);
        }
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`${key} requires a value; ${USAGE}`);
        }
        flags.set(key, value);
        i += 1;
      }
      const state = flags.get('--state');
      const bodyFile = flags.get('--body-file');
      const followUpsFile = flags.get('--follow-ups-file');
      for (const key of flags.keys()) {
        if (
          key !== '--state'
          && key !== '--body-file'
          && key !== '--follow-ups-file'
        ) {
          throw new Error(`review-verdict unknown flag ${key}; ${USAGE}`);
        }
      }
      if (state === undefined || bodyFile === undefined) {
        throw new Error(
          'review-verdict requires --state <APPROVE|REQUEST_CHANGES> --body-file <path>; ' +
          USAGE,
        );
      }
      if (state !== 'APPROVE' && state !== 'REQUEST_CHANGES') {
        throw new Error(`invalid review verdict state; ${USAGE}`);
      }
      if (followUpsFile !== undefined && state !== 'APPROVE') {
        throw new Error(
          '--follow-ups-file is only valid with --state APPROVE; ' + USAGE,
        );
      }
      return {
        operation: command,
        state,
        bodyFile: requiredPath(bodyFile, '--body-file'),
        ...(followUpsFile === undefined
          ? {}
          : { followUpsFile: requiredPath(followUpsFile, '--follow-ups-file') }),
      };
    }
    case 'review-findings':
      if (argv.length !== 3 || argv[1] !== '--file') {
        throw new Error(`review-findings requires --file <path>; ${USAGE}`);
      }
      return {
        operation: command,
        file: requiredPath(argv[2], '--file'),
      };
    case 'child-complete':
      if (argv.length !== 1) {
        throw new Error(`child-complete has unknown or trailing input; ${USAGE}`);
      }
      return { operation: command };
    case 'human':
      if (argv.length !== 3 || argv[1] !== '--reason-file') {
        throw new Error(`human requires --reason-file <path>; ${USAGE}`);
      }
      return {
        operation: command,
        reasonFile: requiredPath(argv[2], '--reason-file'),
      };
    default:
      throw new Error(`unknown session command: ${command}; ${USAGE}`);
  }
}

function requiredPhase(
  manifest: AttemptManifest,
  operation: ParsedSessionCommand['operation'],
  phase: AttemptManifest['phase'],
): void {
  if (manifest.phase !== phase) {
    throw new Error(`${operation} is not valid for ${manifest.phase} attempts`);
  }
}

function operationNotWired(operation: string): never {
  throw new Error(`session ${operation}: operation not wired`);
}

function finishSessionCommand(
  operation: ParsedSessionCommand['operation'],
  outcome: SessionOperationOutcome,
  succeeded: boolean,
  deps: SessionCliDeps,
): SessionCliExecution {
  const execution: SessionCliExecution = {
    operation,
    outcome,
    exitCode: succeeded ? 0 : 2,
  };
  const writeOutput = deps.writeOutput
    ?? ((output: string): void => { process.stdout.write(output); });
  writeOutput(`${JSON.stringify(execution)}\n`);
  if (execution.exitCode !== 0) {
    const setExitCode = deps.setExitCode
      ?? ((exitCode: number): void => { process.exitCode = exitCode; });
    setExitCode(execution.exitCode);
  }
  return execution;
}

/**
 * Production remains inert until later lifecycle tasks provide phase writers.
 * Every method fails closed and performs no shared or local lifecycle mutation.
 */
export const unwiredSessionProtocol: SessionProtocol = {
  checkpoint: async () => operationNotWired('checkpoint'),
  implementationComplete: async () => operationNotWired('implementation-complete'),
  reviewVerdict: async () => operationNotWired('review-verdict'),
  reviewFindings: async () => operationNotWired('review-findings'),
  childComplete: async () => operationNotWired('child-complete'),
  human: async () => operationNotWired('human'),
};

export function makeProductionSessionProtocol(
  environment: NodeJS.ProcessEnv,
  makeImplementation: () => SessionProtocol = () =>
    makeImplementationSessionProtocol(
      makeProductionImplementationSessionPort({ environment }),
    ),
  makeReview: () => Pick<
  SessionProtocol,
  'reviewVerdict' | 'reviewFindings' | 'human'
  > = () => makeReviewSessionProtocol(
    makeProductionReviewSessionPort({ environment }),
  ),
): SessionProtocol {
  let implementation: SessionProtocol | undefined;
  let review: ReturnType<typeof makeReview> | undefined;
  const implementationProtocol = (): SessionProtocol => {
    implementation ??= makeImplementation();
    return implementation;
  };
  const reviewProtocol = (): ReturnType<typeof makeReview> => {
    review ??= makeReview();
    return review;
  };
  return {
    checkpoint: (manifest) => implementationProtocol().checkpoint(manifest),
    implementationComplete: (manifest, summary) =>
      implementationProtocol().implementationComplete(manifest, summary),
    reviewVerdict: (manifest, state, body, followUps) =>
      reviewProtocol().reviewVerdict(manifest, state, body, followUps),
    reviewFindings: (manifest, findings) => {
      const findingsHandler = reviewProtocol().reviewFindings;
      if (findingsHandler === undefined) {
        return operationNotWired('review-findings');
      }
      return findingsHandler(manifest, findings);
    },
    childComplete: (manifest) => {
      const handler = implementationProtocol().childComplete;
      if (handler === undefined) {
        return operationNotWired('child-complete');
      }
      return handler(manifest);
    },
    human: (manifest, reason) => manifest.phase === 'review'
      ? reviewProtocol().human(manifest, reason)
      : implementationProtocol().human(manifest, reason),
  };
}

export async function runSessionCli(
  argv: readonly string[],
  deps: SessionCliDeps = {},
): Promise<SessionCliExecution> {
  const command = parseSessionCommand(argv);
  const env = deps.env ?? process.env;
  const manifestPath = env.JINN_AUTOPILOT_SESSION_MANIFEST;
  if (manifestPath === undefined || manifestPath.length === 0) {
    throw new Error('JINN_AUTOPILOT_SESSION_MANIFEST is required');
  }

  // Decode again at the last possible point before the protocol handoff. An
  // injected reader may return an in-memory fixture; production reads the
  // file afresh on every CLI invocation.
  const manifest = decodeAttemptManifest(
    (deps.readManifest ?? readAttemptManifest)(manifestPath),
  );
  const readText = deps.readTextFile ?? readBoundedUtf8File;
  const validateReportFile =
    deps.validateReportFile ?? validateAttemptReportFile;
  const protocol = deps.protocol ?? makeProductionSessionProtocol(env);

  switch (command.operation) {
    case 'checkpoint': {
      requiredPhase(manifest, command.operation, 'implement');
      const outcome = await protocol.checkpoint(manifest);
      return finishSessionCommand(
        command.operation,
        outcome,
        outcome.status === 'published' || outcome.status === 'already-applied',
        deps,
      );
    }
    case 'implementation-complete': {
      requiredPhase(manifest, command.operation, 'implement');
      const outcome = await protocol.implementationComplete(
        manifest,
        boundedText(readText(attemptReportPath(
          manifest,
          command.summaryFile,
          validateReportFile,
        ))),
      );
      return finishSessionCommand(
        command.operation,
        outcome,
        outcome.status === 'complete',
        deps,
      );
    }
    case 'review-verdict': {
      requiredPhase(manifest, command.operation, 'review');
      const followUps = command.followUpsFile === undefined
        ? undefined
        : parseReviewFollowUpsPayload(
          boundedText(readText(attemptReportPath(
            manifest,
            command.followUpsFile,
            validateReportFile,
          ))),
        );
      const outcome = await protocol.reviewVerdict(
        manifest,
        command.state,
        boundedText(readText(attemptReportPath(
          manifest,
          command.bodyFile,
          validateReportFile,
        ))),
        followUps,
      );
      return finishSessionCommand(
        command.operation,
        outcome,
        (
          command.state === 'APPROVE'
            ? outcome.status === 'approved'
            : outcome.status === 'requested-changes'
        ),
        deps,
      );
    }
    case 'review-findings': {
      requiredPhase(manifest, command.operation, 'review');
      if (!childrenPathEnabled(env)) {
        throw new Error(
          'review-findings requires JINN_AUTOPILOT_CHILDREN (default on); '
          + 'use review-verdict REQUEST_CHANGES when children are disarmed',
        );
      }
      const findingsHandler = protocol.reviewFindings;
      if (findingsHandler === undefined) {
        operationNotWired('review-findings');
      }
      const outcome = await findingsHandler(
        manifest,
        boundedText(readText(attemptReportPath(
          manifest,
          command.file,
          validateReportFile,
        ))),
      );
      return finishSessionCommand(
        command.operation,
        outcome,
        outcome.status === 'filed',
        deps,
      );
    }
    case 'child-complete': {
      requiredPhase(manifest, command.operation, 'implement');
      const handler = protocol.childComplete;
      if (handler === undefined) {
        operationNotWired('child-complete');
      }
      const outcome = await handler(manifest);
      return finishSessionCommand(
        command.operation,
        outcome,
        outcome.status === 'closed',
        deps,
      );
    }
    case 'human':
      if (manifest.phase !== 'implement' && manifest.phase !== 'review') {
        throw new Error(`${command.operation} is not valid for ${manifest.phase} attempts`);
      }
      return finishSessionCommand(
        command.operation,
        await protocol.human(
          manifest,
          boundedText(readText(attemptReportPath(
            manifest,
            command.reasonFile,
            validateReportFile,
          ))),
        ),
        true,
        deps,
      );
  }
}
