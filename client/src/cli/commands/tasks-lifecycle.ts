/**
 * `jinn tasks close | cancel | release` — the requester lifecycle exits' CLI front-ends
 * (one-swap M5d, umbrella #2461, DR-2026-08-05 decision 1). Each verb is a THIN front-end over a
 * PURE work-client intent module (`closePosting` / `cancelAttempt` / `releasePostedAttempt`): it
 * parses argv, resolves the venue lifecycle/release ports through injected deps, calls the intent
 * module, and emits the structured result. The verb owns no lifecycle logic — the intent module
 * does — matching the intent-module law (headless design §4.1) the `policy`/`wiring` verbs follow.
 *
 * The lifecycle executor is loaded through `TasksLifecycleDeps`, exactly as `native-vertical
 * request` loads its executor: production supplies a real loader, tests inject a fake, and the
 * default build is feature-disabled (`bootstrap_incomplete`) until the native deployment exposes
 * its venue lifecycle/release ports to a CLI process. Wiring that live executor — through the
 * daemon-guard, since a running daemon owns the one Safe broadcaster — is the M5d follow-up (see
 * the PR body). This keeps the CLI surface + intent modules landed and tested now.
 */
import { parseArgs } from 'node:util';
import { COMMON_FLAGS, type CommandContext } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { emitResult } from '../output.js';
import {
  cancelAttempt,
  closePosting,
  isRequesterError,
  releasePostedAttempt,
  type AttemptCancelPort,
  type PostingClosePort,
} from '../../native-requester/work-client/index.js';
import type { ReleaseAttemptPort } from '@jinn-network/marketplace-binding';

export type TasksLifecycleVerb = 'close' | 'cancel' | 'release';

/**
 * The resolved venue lifecycle surface a live `tasks {close,cancel,release}` needs. `close`/`cancel`
 * read the creator-side `MarketplaceLifecyclePorts`; `release` reads the operator-side
 * `ReleaseAttemptPort`. `close()` releases any wallet/venue custody the loader opened.
 */
export interface TasksLifecycleExecutor {
  readonly lifecycle: PostingClosePort & AttemptCancelPort;
  readonly release: Pick<ReleaseAttemptPort, 'releaseAttempt'>;
  close?(): Promise<void>;
}

export interface TasksLifecycleDeps {
  installShutdownHandlers?: (close: () => Promise<void>) => void;
  /** Opens the venue lifecycle/release ports over this operator's Safe custody. */
  loadExecutor(input: { readonly password: string }): Promise<TasksLifecycleExecutor>;
}

const EXAMPLE: Record<TasksLifecycleVerb, string> = {
  close: 'jinn tasks close --task-id 42',
  cancel: 'jinn tasks cancel --attempt urn:uuid:... --reason "stale"',
  release: 'jinn tasks release --task-id 42 --attempt-index 0',
};

const OPTIONS = {
  ...COMMON_FLAGS,
  'task-id': { type: 'string' as const },
  attempt: { type: 'string' as const },
  'attempt-index': { type: 'string' as const },
  reason: { type: 'string' as const },
};

function invalid(ctx: CommandContext, verb: TasksLifecycleVerb, message: string): void {
  emitEnvelope(
    { code: 'invalid_invocation', message, exampleCli: EXAMPLE[verb], details: { field: 'flags' } },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

function parseTaskId(raw: string | undefined): bigint | undefined {
  if (raw === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) return undefined;
  return BigInt(raw);
}

function emit(ctx: CommandContext, parsedJson: boolean, parsedHuman: boolean, result: object): void {
  emitResult(
    { schemaVersion: 1, generatedAt: new Date().toISOString(), ...result },
    (v) => JSON.stringify(v, null, 2),
    {
      json: parsedJson,
      human: parsedHuman,
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

/**
 * Runs one lifecycle verb. `deps` undefined (the default build) => the feature is not yet wired to a
 * live venue: emit `bootstrap_incomplete` rather than pretend. The argv is validated FIRST, so a
 * malformed invocation is an `invalid_invocation` even in a feature-disabled build.
 */
export async function runTasksLifecycle(
  ctx: CommandContext,
  verb: TasksLifecycleVerb,
  deps?: TasksLifecycleDeps,
): Promise<void> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: false }>>;
  try {
    parsed = parseArgs({ args: ctx.argv, options: OPTIONS, allowPositionals: false }) as typeof parsed;
  } catch (err) {
    invalid(ctx, verb, err instanceof Error ? err.message : String(err));
    return;
  }
  const json = Boolean(parsed.values.json);
  const human = Boolean(parsed.values.human);

  // Validate arguments up front — a malformed invocation is invalid regardless of wiring state.
  let taskId: bigint | undefined;
  let attemptIndex: number | undefined;
  const attempt = parsed.values.attempt;
  if (verb === 'close' || verb === 'release') {
    taskId = parseTaskId(parsed.values['task-id']);
    if (taskId === undefined) {
      invalid(ctx, verb, '--task-id must be a non-negative decimal task id');
      return;
    }
  }
  if (verb === 'release') {
    const raw = parsed.values['attempt-index'];
    const n = raw === undefined ? NaN : Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      invalid(ctx, verb, '--attempt-index must be a non-negative integer');
      return;
    }
    attemptIndex = n;
  }
  if (verb === 'cancel') {
    if (typeof attempt !== 'string' || attempt.length === 0) {
      invalid(ctx, verb, '--attempt is required (the urn:uuid of the attempt to cancel)');
      return;
    }
    if (typeof parsed.values.reason !== 'string' || parsed.values.reason.trim().length === 0) {
      invalid(ctx, verb, '--reason is required and must be non-empty');
      return;
    }
  }

  if (deps === undefined) {
    emitEnvelope(
      {
        code: 'bootstrap_incomplete',
        message: 'The native task lifecycle exits are feature-disabled in this build.',
        hint: 'Native venue lifecycle wiring is not yet available to the CLI process.',
        exampleCli: EXAMPLE[verb],
        details: { feature: 'tasks-lifecycle', verb, state: 'feature-disabled' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const password = ctx.env.JINN_PASSWORD;
  if (typeof password !== 'string' || password.length === 0) {
    invalid(ctx, verb, 'JINN_PASSWORD is required to open the venue lifecycle custody');
    return;
  }

  let executor: TasksLifecycleExecutor;
  try {
    executor = await deps.loadExecutor({ password });
  } catch (cause) {
    emitEnvelope(
      {
        code: 'bootstrap_incomplete',
        message: 'Could not open the venue lifecycle custody.',
        hint: 'Correct the chain, custody, and daemon-guard checks, then retry.',
        exampleCli: EXAMPLE[verb],
        details: { feature: 'tasks-lifecycle', verb, reason: cause instanceof Error ? cause.message : String(cause) },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (executor.close !== undefined) deps.installShutdownHandlers?.(executor.close);

  try {
    if (verb === 'close') {
      emit(ctx, json, human, await closePosting({ taskId: taskId!, port: executor.lifecycle }));
    } else if (verb === 'cancel') {
      emit(ctx, json, human, await cancelAttempt({
        attempt: attempt as `urn:uuid:${string}`,
        reason: parsed.values.reason as string,
        port: executor.lifecycle,
      }));
    } else {
      emit(ctx, json, human, await releasePostedAttempt({
        taskId: taskId!,
        attemptIndex: attemptIndex!,
        port: executor.release,
      }));
    }
  } catch (cause) {
    const requesterError = isRequesterError(cause);
    emitEnvelope(
      {
        code: requesterError ? 'invalid_invocation' : 'fatal',
        message: cause instanceof Error ? cause.message : String(cause),
        exampleCli: EXAMPLE[verb],
        details: {
          feature: 'tasks-lifecycle',
          verb,
          ...(requesterError ? { category: cause.category, reason: cause.code } : {}),
        },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
  } finally {
    await executor.close?.().catch(() => undefined);
  }
}
