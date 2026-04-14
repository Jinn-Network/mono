import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { ensureConfirmed, emitDryRun } from '../action.js';
import { gatherIntrospectionRaw } from '../introspection-context.js';

async function runScale(ctx: CommandContext, rest: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        to: { type: 'string' },
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
        exampleCli: 'jinn fleet scale --to 3 --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const to = parseInt(parsed.values.to as string, 10);
  if (!Number.isFinite(to) || to < 0) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: '--to must be a non-negative integer',
        exampleCli: 'jinn fleet scale --to 3 --dry-run',
        details: { field: '--to', expected: 'non-negative integer' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const current = raw.fleet?.services.length ?? 0;
  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  let plan: Array<{ action: string; from: number; to: number; indices?: number[] }> = [];
  let description: string;
  if (to === current) {
    plan = [];
    description = `Fleet is already at size ${current}. No action.`;
  } else if (to > current) {
    plan = [{ action: 'grow', from: current, to }];
    description = `Would grow fleet from ${current} to ${to} via jinn bootstrap with targetServices=${to}.`;
  } else {
    const indices = (raw.fleet?.services ?? []).slice(to).map(s => s.index);
    plan = [{ action: 'retire', from: current, to, indices }];
    description = `Would retire services ${indices.join(', ')} to shrink fleet from ${current} to ${to}.`;
  }

  if (dryRun) {
    emitDryRun(ctx, { verb: 'fleet scale', description, plan });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  ctx.writer.write(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'fleet scale',
      from: current,
      to,
      note: 'scale execution pending in a follow-up commit',
    }) + '\n',
  );
}

async function runRetire(ctx: CommandContext, rest: string[]): Promise<void> {
  const [indexArg, ...flagArgs] = rest;
  if (!indexArg || indexArg.startsWith('--')) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn fleet retire requires a service index',
        exampleCli: 'jinn fleet retire 2 --dry-run',
        details: { field: '<index>', expected: 'non-negative integer' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const index = parseInt(indexArg, 10);
  if (!Number.isFinite(index) || index < 0) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Invalid service index: ${indexArg}`,
        exampleCli: 'jinn fleet retire 2 --dry-run',
        details: { field: '<index>', expected: 'non-negative integer' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: flagArgs,
      options: {
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
        exampleCli: 'jinn fleet retire 2 --dry-run',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const raw = await gatherIntrospectionRaw({ argv: ctx.argv });
  const svc = (raw.fleet?.services ?? []).find(s => s.index === index);
  const dryRun = parsed.values['dry-run'] as boolean;
  const yes = parsed.values.yes as boolean;

  let plan: Array<{ action: 'retire'; index: number; txCount: number }>;
  let description: string;
  if (!svc) {
    plan = [];
    description = `Service ${index} is already retired (or never existed). No action.`;
  } else {
    plan = [{ action: 'retire', index, txCount: 3 }];
    description = `Would unstake, unbond, and drain wallets for service ${index}.`;
  }

  if (dryRun) {
    emitDryRun(ctx, { verb: 'fleet retire', description, plan });
    return;
  }

  if (!ensureConfirmed(ctx, { yes, dryRun: false })) return;

  ctx.writer.write(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'fleet retire',
      index,
      note: 'retire execution pending in a follow-up commit',
    }) + '\n',
  );
}

async function run(ctx: CommandContext): Promise<void> {
  const [subverb, ...rest] = ctx.argv;
  if (!subverb) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn fleet requires a subverb: scale | retire',
        exampleCli: 'jinn fleet scale --to 3 --dry-run',
        details: { field: 'subverb', expected: 'scale | retire' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (subverb === 'scale') return runScale(ctx, rest);
  if (subverb === 'retire') return runRetire(ctx, rest);
  emitEnvelope(
    {
      code: 'invalid_invocation',
      message: `Unknown fleet subverb: ${subverb}`,
      exampleCli: 'jinn fleet --help',
      details: { field: 'subverb', expected: 'scale | retire' },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

const command: CommandModule = {
  name: 'fleet-manage',
  summary: 'Fleet management: scale | retire <index>',
  helpText: `Usage: jinn fleet <subverb> [flags...]

Subverbs:
  scale --to N [--dry-run] [--yes]       Grow or shrink the fleet to N services (idempotent)
  retire <index> [--dry-run] [--yes]     Retire one service (unstake, unbond, drain)

Examples:
  jinn fleet scale --to 3 --dry-run
  jinn fleet scale --to 3 --yes
  jinn fleet retire 2 --dry-run
`,
  run,
};

export default command;
