import { readFileSync } from 'node:fs';
import {
  decodeAttemptManifest,
  readAttemptManifest,
  type AttemptManifest,
} from '../lifecycle/attempt-workspace.js';
import type { ReviewVerdictState } from '../lifecycle/types.js';

export interface SessionProtocol {
  checkpoint(manifest: AttemptManifest): Promise<void>;
  implementationComplete(
    manifest: AttemptManifest,
    summary: string,
  ): Promise<void>;
  reviewVerdict(
    manifest: AttemptManifest,
    state: ReviewVerdictState,
    body: string,
  ): Promise<void>;
  reviewFixPublish(manifest: AttemptManifest): Promise<void>;
  mergePrepComplete(
    manifest: AttemptManifest,
    summary: string,
  ): Promise<void>;
  human(manifest: AttemptManifest, reason: string): Promise<void>;
}

export interface SessionCliDeps {
  readonly protocol?: SessionProtocol;
  readonly env?: NodeJS.ProcessEnv;
  readonly readManifest?: (path: string) => AttemptManifest;
  readonly readTextFile?: (path: string) => string;
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

const USAGE =
  'usage: autopilot session checkpoint | ' +
  'implementation-complete --summary-file <path> | ' +
  'review-verdict --state <APPROVE|REQUEST_CHANGES> --body-file <path> | ' +
  'review-fix-publish | merge-prep-complete --summary-file <path> | ' +
  'human --reason-file <path>';

function requiredPath(value: string | undefined, option: string): string {
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${option} requires a path; ${USAGE}`);
  }
  return value;
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

export async function runSessionCli(
  argv: readonly string[],
  deps: SessionCliDeps = {},
): Promise<void> {
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
  const readText = deps.readTextFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const protocol = deps.protocol ?? unwiredSessionProtocol;

  switch (command.operation) {
    case 'checkpoint':
      await protocol.checkpoint(manifest);
      return;
    case 'implementation-complete':
      requiredPhase(manifest, command.operation, 'implement');
      await protocol.implementationComplete(
        manifest,
        readText(command.summaryFile),
      );
      return;
    case 'review-verdict':
      requiredPhase(manifest, command.operation, 'review');
      await protocol.reviewVerdict(
        manifest,
        command.state,
        readText(command.bodyFile),
      );
      return;
    case 'review-fix-publish':
      requiredPhase(manifest, command.operation, 'review');
      await protocol.reviewFixPublish(manifest);
      return;
    case 'merge-prep-complete':
      requiredPhase(manifest, command.operation, 'merge-prep');
      await protocol.mergePrepComplete(
        manifest,
        readText(command.summaryFile),
      );
      return;
    case 'human':
      await protocol.human(manifest, readText(command.reasonFile));
  }
}
