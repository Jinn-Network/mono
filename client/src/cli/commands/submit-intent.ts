import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getAddress } from 'viem';
import { COMMON_FLAGS, type CommandContext, type CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';
import { createCliExecutionContext } from '../execution-context.js';
import { isRecoverableTransactionError } from '../../tx-retry.js';
import { PredictionV0IntentSchema } from '../../types/prediction.js';
import type { DesiredState } from '../../types/desired-state.js';

function intentCacheKey(safe: string, intentId: string): string {
  return `cli_intent:${getAddress(safe)}:${intentId}`;
}

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
        id: { type: 'string' },
        description: { type: 'string' },
        'spec-file': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
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

  // ── spec-file loading ───────────────────────────────────────────────────────
  const specFilePath = parsed.values['spec-file'] as string | undefined;
  let specOverlay: { window?: any; spec?: any; eligibility?: any } | undefined;
  if (specFilePath) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(resolve(specFilePath), 'utf8')) as Record<string, unknown>;
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Could not read spec file: ${err instanceof Error ? err.message : String(err)}`,
          exampleCli: 'jinn submit-intent --id my-1 --description "..." --spec-file fixtures/prediction-v0-intent.example.json --dry-run',
          details: { field: 'spec-file' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    const kind = (raw['spec'] as any)?.kind;
    if (kind === 'prediction.v0') {
      const stub: any = { id: id!, description: description!, ...raw };
      // If the fixture used zero as a now-relative template, fill in current time
      if (stub.window?.startTs === 0) {
        const now = Date.now();
        stub.window.startTs = now;
        stub.window.endTs = now + 3_600_000;
        stub.spec.question.resolveTs = now + 3_600_000 + 900_000;
      }
      const parsedIntent = PredictionV0IntentSchema.safeParse(stub);
      if (!parsedIntent.success) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: `Invalid prediction.v0 intent: ${parsedIntent.error.message}`,
            exampleCli: 'jinn submit-intent --id my-1 --description "..." --spec-file fixtures/prediction-v0-intent.example.json --dry-run',
            details: { field: 'spec-file' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      specOverlay = {
        window: parsedIntent.data.window,
        spec: parsedIntent.data.spec,
        eligibility: parsedIntent.data.eligibility,
      };
    } else {
      // Future kinds: pass through without validation
      specOverlay = {
        window: raw['window'] as any,
        spec: raw['spec'] as any,
        eligibility: raw['eligibility'] as any,
      };
    }
  }

  if (dryRun) {
    const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
    const service = raw.fleet?.services.find(s => s.step === 'complete');
    if (!service?.safe_address) {
      emitEnvelope(
        {
          code: 'bootstrap_incomplete',
          message:
            'No bootstrapped service available to submit intents from. Run `jinn bootstrap` first.',
          hint: 'Run `jinn fund-requirements` to see outstanding funding, then `jinn bootstrap`.',
          exampleCli: 'jinn bootstrap --human',
          details: { field: 'fleet.services', expected: 'at least one service at step=complete' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    const creatorMultisig = getAddress(service.safe_address);
    emitDryRun(ctx, {
      verb: 'submit-intent',
      description: `Would post intent '${id}' from ${creatorMultisig}`,
      plan: [{ id, description, creatorMultisig, asset: 'native', txCount: 1, ...(specOverlay ? { spec: specOverlay.spec } : {}) }],
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
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'submit-intent',
        id,
        creatorMultisig: getAddress(safe),
        requestId: cached,
        status: 'already_submitted',
        idempotent: true,
      },
      (v) => {
        const value = v as { id: string; requestId: string; creatorMultisig: string };
        return `Intent already submitted.\nID: ${value.id}\nRequest: ${value.requestId}\nSafe: ${value.creatorMultisig}`;
      },
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
    );
    return;
  }

  const attemptNumber = 1;
  const attemptId = `${id}/${attemptNumber}`;
  try {
    const desiredState: DesiredState = {
      id,
      description,
      type: 'restoration',
      attemptId,
      attemptNumber,
      ...(specOverlay ?? {}),
    };
    const requestId = await adapter.postDesiredState(desiredState);
    jinnStore.recordOwnActivity(requestId, 'created');
    jinnStore.setConfigValue(cacheKey, requestId);
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'submit-intent',
        id,
        creatorMultisig: getAddress(safe),
        requestId,
        status: 'submitted',
        attemptId,
        attemptNumber,
      },
      (v) => {
        const value = v as { id: string; requestId: string; creatorMultisig: string };
        return `Intent submitted.\nID: ${value.id}\nRequest: ${value.requestId}\nSafe: ${value.creatorMultisig}`;
      },
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
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
  helpText: `Usage: jinn submit-intent --id <id> --description <text> [--spec-file <path>] [--dry-run] [--yes] [--human]

Idempotent: re-posting the same (--id) from the same creator Safe returns the
cached request id (local SQLite) without sending a new transaction.

Options:
  --spec-file <path>  Path to a JSON file containing typed intent fields (window, spec, eligibility).
                      Supports prediction.v0 intents with full Zod validation.
                      If window.startTs is 0, timestamps are filled relative to now.

Examples:
  jinn submit-intent --id health-check --description "The service is running" --dry-run
  jinn submit-intent --id health-check --description "The service is running" --yes
  jinn submit-intent --id eth-pred-1 --description "ETH > 3500" --spec-file fixtures/prediction-v0-intent.example.json --dry-run
`,
  run,
};

export default command;
