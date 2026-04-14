import { parseArgs } from 'node:util';
import { getAddress } from 'ethers';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { createCliExecutionContext } from '../execution-context.js';
import { isRecoverableTransactionError } from '../../tx-retry.js';

function intentCacheKey(safe: string, intentId: string): string {
  return `cli_intent:${getAddress(safe)}:${intentId}`;
}

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        id: { type: 'string' },
        description: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn submit-intent --id test-1 --description "..." --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const id = parsed.values.id as string | undefined;
  const description = parsed.values.description as string | undefined;

  if (!id) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--id is required',
        exampleCli: 'jinn submit-intent --id my-intent --description "..." --dry-run',
        details: { field: '--id', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (!description) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--description is required',
        exampleCli: 'jinn submit-intent --id my-intent --description "..." --dry-run',
        details: { field: '--description', expected: 'non-empty string' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  if (dryRun) {
    const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
    const service = raw.fleet?.services.find(s => s.step === 'complete');
    const creatorMultisig = service?.safe_address ?? '0x';
    emitDryRun(ctx, {
      verb: 'submit-intent',
      description: `Would post intent '${id}' from ${creatorMultisig}`,
      plan: [{ id, description, creatorMultisig, asset: 'native', txCount: 1 }],
    });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  const built = await createCliExecutionContext({ argv: ctx.argv, env: ctx.env });
  if (!built.ok) {
    emitEnvelope(built.envelope, { writer: ctx.writer, exit: ctx.exit });
    return;
  }

  const { adapter, jinnStore, primaryService } = built.ctx;
  const safe = primaryService.safe_address!;
  const cacheKey = intentCacheKey(safe, id);
  const cached = jinnStore.getConfigValue(cacheKey);
  if (cached) {
    ctx.writer.write(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'submit-intent',
        id,
        creatorMultisig: getAddress(safe),
        requestId: cached,
        status: 'already_submitted',
        idempotent: true,
      }) + '\n',
    );
    return;
  }

  const attemptNumber = 1;
  const attemptId = `${id}/${attemptNumber}`;
  try {
    const requestId = await adapter.postDesiredState({
      id,
      description,
      type: 'restoration',
      attemptId,
      attemptNumber,
    });
    jinnStore.recordOwnActivity(requestId, 'created');
    jinnStore.setConfigValue(cacheKey, requestId);
    ctx.writer.write(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'submit-intent',
        id,
        creatorMultisig: getAddress(safe),
        requestId,
        status: 'submitted',
        attemptId,
        attemptNumber,
      }) + '\n',
    );
  } catch (e) {
    if (isRecoverableTransactionError(e)) {
      emitEnvelope(
        {
          code: 'transient_error',
          message: e instanceof Error ? e.message : String(e),
          hint: 'Retry when the RPC endpoint is healthy or fees clear.',
          exampleCli: 'jinn submit-intent --id my-intent --description "..." --yes',
          details: { cause: e instanceof Error ? e.message : String(e) },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    emitEnvelope(
      {
        code: 'fatal',
        message: e instanceof Error ? e.message : String(e),
        details: { cause: e instanceof Error ? e.message : String(e) },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
  }
}

const command: CommandModule = {
  name: 'submit-intent',
  summary: 'Post a desired state (restoration job) to the protocol',
  helpText: `Usage: jinn submit-intent --id <id> --description <text> [--dry-run] [--yes]

Idempotent: re-posting the same (--id) from the same creator Safe returns the
cached request id (local SQLite) without sending a new transaction.

Examples:
  jinn submit-intent --id health-check --description "The service is running" --dry-run
  jinn submit-intent --id health-check --description "The service is running" --yes
`,
  run,
};

export default command;
