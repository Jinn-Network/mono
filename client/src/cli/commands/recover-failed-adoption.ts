import {
  COMMON_FLAGS,
  parseCommandArgs,
  type BaseCommandDeps,
  type CommandContext,
  type CommandModule,
} from '../command.js';
import Database from 'better-sqlite3';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  recoverFailedAdoption,
  type FailedAdoptionRecoveryMode,
  type FailedAdoptionRecoveryResult,
} from '../../harnesses/engine/failed-adoption-recovery.js';
import { TaskRunPersistence } from '../../harnesses/engine/persistence.js';
import { emitResult } from '../output.js';

const REQUEST_ID = /^0x[0-9a-f]{64}$/i;
const REFUSED_EXIT_CODE = 30;

export interface RunFailedAdoptionRecoveryArgs {
  readonly dbPath: string;
  readonly requestId: string;
  readonly mode: FailedAdoptionRecoveryMode;
}

export interface RecoverFailedAdoptionCommandDeps extends BaseCommandDeps {
  readonly runRecovery: (
    args: RunFailedAdoptionRecoveryArgs,
  ) => FailedAdoptionRecoveryResult;
}

export function runFailedAdoptionRecovery(
  args: RunFailedAdoptionRecoveryArgs,
): FailedAdoptionRecoveryResult {
  const db = new Database(args.dbPath, {
    fileMustExist: true,
    readonly: args.mode === 'dry-run',
  });
  try {
    return recoverFailedAdoption({
      // The daemon owns schema lifecycle. This exact-row administrative path
      // must never migrate or backfill the database, including in dry-run.
      persistence: new TaskRunPersistence(db, { migrate: false }),
      requestId: args.requestId,
      mode: args.mode,
    });
  } finally {
    db.close();
  }
}

const PRODUCTION_DEPS: RecoverFailedAdoptionCommandDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  runRecovery: runFailedAdoptionRecovery,
};

function invalidInvocation(
  ctx: CommandContext,
  message: string,
  field: string,
): void {
  emitEnvelope({
    code: 'invalid_invocation',
    message,
    hint:
      'Provide one exact request ID and exactly one of --dry-run or --apply.',
    exampleCli:
      'jinn recover-failed-adoption --request-id 0x<64-hex> --dry-run --json',
    details: { field },
  }, { writer: ctx.writer, exit: ctx.exit });
}

function humanResult(result: FailedAdoptionRecoveryResult): string {
  if (result.status === 'refused') {
    return `refused ${result.requestId}: ${result.reason}`;
  }
  return `${result.status} ${result.requestId}: `
    + `${result.previousState} -> ${result.targetState}`;
}

function parseRecoveryArgs(argv: string[]) {
  return parseCommandArgs(argv, {
    ...COMMON_FLAGS,
    'request-id': { type: 'string' as const },
    'dry-run': { type: 'boolean' as const, default: false },
    apply: { type: 'boolean' as const, default: false },
  });
}

export function createRecoverFailedAdoptionCommand(
  deps: RecoverFailedAdoptionCommandDeps = PRODUCTION_DEPS,
): CommandModule {
  async function run(ctx: CommandContext): Promise<void> {
    let parsed: ReturnType<typeof parseRecoveryArgs>;
    try {
      parsed = parseRecoveryArgs(ctx.argv);
    } catch (error) {
      invalidInvocation(
        ctx,
        error instanceof Error
          ? `Invalid command-line arguments: ${error.message}`
          : 'Invalid command-line arguments.',
        'argv',
      );
      return;
    }

    const requestId = parsed.values['request-id'];
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      invalidInvocation(
        ctx,
        '--request-id must be one exact 32-byte hex request ID',
        '--request-id',
      );
      return;
    }
    const dryRun = parsed.values['dry-run'] === true;
    const apply = parsed.values.apply === true;
    if (dryRun === apply) {
      invalidInvocation(
        ctx,
        'Exactly one of --dry-run or --apply is required',
        '--dry-run|--apply',
      );
      return;
    }
    if (parsed.positionals.length > 0) {
      invalidInvocation(ctx, 'Positional arguments are not supported', 'argv');
      return;
    }

    const mode: FailedAdoptionRecoveryMode = dryRun ? 'dry-run' : 'apply';
    const configPath =
      typeof parsed.values.config === 'string'
      && parsed.values.config.length > 0
        ? parsed.values.config
        : undefined;
    let result: FailedAdoptionRecoveryResult;
    try {
      const config = deps.loadConfig(configPath);
      result = deps.runRecovery({
        dbPath: config.dbPath,
        requestId,
        mode,
      });
    } catch (error) {
      emitEnvelope({
        code: 'fatal',
        message:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : 'Exact failed-adoption recovery failed unexpectedly.',
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      }, { writer: ctx.writer, exit: ctx.exit });
      return;
    }

    const payload = {
      schemaVersion: 1 as const,
      verb: 'recover-failed-adoption' as const,
      mode,
      ...result,
    };
    emitResult(payload, () => humanResult(result), {
      json: parsed.values.json === true,
      human: parsed.values.human === true,
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    });
    ctx.exit(result.status === 'refused' ? REFUSED_EXIT_CODE : 0);
  }

  return {
    name: 'recover-failed-adoption',
    summary:
      'Dry-run or requeue one exact false adoption-identity contradiction',
    helpText: `Usage: jinn recover-failed-adoption --request-id <id> (--dry-run | --apply) [--json | --human] [--config <path>]

Validates one exact FAILED Autopilot adoption row. Dry-run performs every
guard without writing. Apply performs one compare-and-swap transition to
AWAITING_ADOPTION while preserving all Task, output, and delivery evidence.
It never executes, snapshots, packages, or delivers a Task.

Examples:
  jinn recover-failed-adoption --request-id 0x<64-hex> --dry-run --json
  jinn recover-failed-adoption --request-id 0x<64-hex> --apply --json
`,
    run,
  };
}

const command: CommandModule = createRecoverFailedAdoptionCommand();
export default command;
