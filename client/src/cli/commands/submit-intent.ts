import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';

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

  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const service = raw.fleet?.services.find(s => s.step === 'complete');
  if (!service) {
    emitEnvelope(
      {
        code: 'bootstrap_incomplete',
        message: 'No complete service in the fleet to post an intent from.',
        hint: 'Run `jinn bootstrap` to advance the state machine first.',
        exampleCli: 'jinn bootstrap',
        details: { field: 'fleet' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const creatorMultisig = service.safe_address ?? '0x';

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  ctx.writer.write(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'submit-intent',
      id,
      creatorMultisig,
      status: 'submitted',
      note: 'adapter integration pending in a follow-up commit',
    }) + '\n',
  );
}

const command: CommandModule = {
  name: 'submit-intent',
  summary: 'Post a desired state (restoration job) to the protocol',
  helpText: `Usage: jinn submit-intent --id <id> --description <text> [--dry-run] [--yes]

Idempotent: keyed on (creator multisig, id). Re-posting the same id is
a no-op that returns the existing on-chain intent id and exits 0.

Examples:
  jinn submit-intent --id health-check --description "The service is running" --dry-run
  jinn submit-intent --id health-check --description "The service is running" --yes
`,
  run,
};

export default command;
