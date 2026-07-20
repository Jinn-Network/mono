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
  ReviewFixPublishResult,
  ReviewVerdictResult,
} from '../lifecycle/review-session.js';
import { makeProductionReviewSessionPort } from '../lifecycle/review-session-production.js';
import { makeMergePrepSessionProtocol } from '../lifecycle/merge-prep-session.js';
import type {
  MergePrepCompleteResult,
} from '../lifecycle/merge-prep-session.js';
import { makeProductionMergePrepSessionPort } from '../lifecycle/merge-prep-session-production.js';
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
  ): Promise<ReviewVerdictResult>;
  reviewFixPublish(manifest: AttemptManifest): Promise<ReviewFixPublishResult>;
  mergePrepComplete(
    manifest: AttemptManifest,
    summary: string,
  ): Promise<MergePrepCompleteResult>;
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
    }
  | { readonly operation: 'review-fix-publish' }
  | {
      readonly operation: 'merge-prep-complete';
      readonly summaryFile: string;
    }
  | {
      readonly operation: 'human';
      readonly reasonFile: string;
    };

type SessionOperationOutcome =
  | CheckpointResult
  | ImplementationCompleteResult
  | ReviewVerdictResult
  | ReviewFixPublishResult
  | MergePrepCompleteResult
  | HumanHoldResult;

export interface SessionCliExecution {
  readonly operation: ParsedSessionCommand['operation'];
  readonly outcome: SessionOperationOutcome;
  readonly exitCode: 0 | 2;
}

const USAGE =
  'usage: autopilot session checkpoint | ' +
  'implementation-complete --summary-file <path> | ' +
  'review-verdict --state <APPROVE|REQUEST_CHANGES> --body-file <path> | ' +
  'review-fix-publish | merge-prep-complete --summary-file <path> | ' +
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
      if (
        argv.length !== 5
        || argv[1] !== '--state'
        || argv[3] !== '--body-file'
      ) {
        throw new Error(
          'review-verdict requires --state <APPROVE|REQUEST_CHANGES> --body-file <path>; ' +
          USAGE,
        );
      }
      const state = argv[2];
      if (state !== 'APPROVE' && state !== 'REQUEST_CHANGES') {
        throw new Error(`invalid review verdict state; ${USAGE}`);
      }
      return {
        operation: command,
        state,
        bodyFile: requiredPath(argv[4], '--body-file'),
      };
    }
    case 'review-fix-publish':
      if (argv.length !== 1) {
        throw new Error(`review-fix-publish has unknown or trailing input; ${USAGE}`);
      }
      return { operation: command };
    case 'merge-prep-complete':
      if (argv.length !== 3 || argv[1] !== '--summary-file') {
        throw new Error(`merge-prep-complete requires --summary-file <path>; ${USAGE}`);
      }
      return {
        operation: command,
        summaryFile: requiredPath(argv[2], '--summary-file'),
      };
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
  reviewFixPublish: async () => operationNotWired('review-fix-publish'),
  mergePrepComplete: async () => operationNotWired('merge-prep-complete'),
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
  'reviewVerdict' | 'reviewFixPublish' | 'human'
  > = () => makeReviewSessionProtocol(
    makeProductionReviewSessionPort({ environment }),
  ),
  makeMergePrep: () => Pick<
  SessionProtocol,
  'mergePrepComplete' | 'human'
  > = () => makeMergePrepSessionProtocol(
    makeProductionMergePrepSessionPort({ environment }),
  ),
): SessionProtocol {
  let implementation: SessionProtocol | undefined;
  let review: ReturnType<typeof makeReview> | undefined;
  let mergePrep: ReturnType<typeof makeMergePrep> | undefined;
  const implementationProtocol = (): SessionProtocol => {
    implementation ??= makeImplementation();
    return implementation;
  };
  const reviewProtocol = (): ReturnType<typeof makeReview> => {
    review ??= makeReview();
    return review;
  };
  const mergePrepProtocol = (): ReturnType<typeof makeMergePrep> => {
    mergePrep ??= makeMergePrep();
    return mergePrep;
  };
  return {
    checkpoint: (manifest) => implementationProtocol().checkpoint(manifest),
    implementationComplete: (manifest, summary) =>
      implementationProtocol().implementationComplete(manifest, summary),
    reviewVerdict: (manifest, state, body) =>
      reviewProtocol().reviewVerdict(manifest, state, body),
    reviewFixPublish: (manifest) => reviewProtocol().reviewFixPublish(manifest),
    mergePrepComplete: (manifest, summary) =>
      mergePrepProtocol().mergePrepComplete(manifest, summary),
    human: (manifest, reason) => manifest.phase === 'review'
      ? reviewProtocol().human(manifest, reason)
      : manifest.phase === 'merge-prep'
        ? mergePrepProtocol().human(manifest, reason)
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
      const outcome = await protocol.reviewVerdict(
        manifest,
        command.state,
        boundedText(readText(attemptReportPath(
          manifest,
          command.bodyFile,
          validateReportFile,
        ))),
      );
      return finishSessionCommand(
        command.operation,
        outcome,
        (
          command.state === 'APPROVE'
            ? outcome.status === 'approved'
            : outcome.status === 'fixing'
        ),
        deps,
      );
    }
    case 'review-fix-publish': {
      requiredPhase(manifest, command.operation, 'review');
      const outcome = await protocol.reviewFixPublish(manifest);
      return finishSessionCommand(
        command.operation,
        outcome,
        outcome.status === 'published' || outcome.status === 'already-applied',
        deps,
      );
    }
    case 'merge-prep-complete': {
      requiredPhase(manifest, command.operation, 'merge-prep');
      const outcome = await protocol.mergePrepComplete(
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
    case 'human':
      if (
        manifest.phase !== 'implement'
        && manifest.phase !== 'review'
        && manifest.phase !== 'merge-prep'
      ) {
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
