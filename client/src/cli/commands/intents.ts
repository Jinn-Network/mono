/**
 * jinn intents — operator entrypoint for opting in/out of specific intent kinds.
 *
 * Four subverbs:
 *   list    — every known (kind → impl) pair with enable state + readiness
 *   status  — detailed envelope for one kind
 *   enable  — idempotent opt-in; dispatches to impl.onEnable
 *   disable — opt-out; removes impl from restorers.disabled in user config
 *
 * JSON by default (agent-friendly). `--human` gives a readable table / prose.
 * Never blocks on TTY input — opt-in flows that need external operator action
 * return `waiting_for_external_action` envelopes the agent surfaces back to
 * the operator.
 */

import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig, getConfigPathFromArgs } from '../../config.js';
import type { RestorerImpl, EnableResult, ReadyStatus, ImplIntentPeek } from '../../restorer/types.js';
import {
  buildIntentsCliRegistry,
  isImplDisabled,
  resetImplForKindInConfig,
  resolveConfigPath,
  resolveEffectiveByKind,
  setImplForKindInConfig,
  setImplEnabledInConfig,
} from '../intent-registry-access.js';

// ── Kind/impl surface helpers ─────────────────────────────────────────────────

function implFor(
  kind: string,
  registry: ReturnType<typeof buildIntentsCliRegistry>,
  byKind: Record<string, string>,
): RestorerImpl | null {
  const implName = byKind[kind];
  if (!implName) return null;
  return registry.list().find((i) => i.name === implName) ?? null;
}

async function readinessOrDefault(impl: RestorerImpl, spec?: ImplIntentPeek): Promise<ReadyStatus> {
  if (!impl.isReady) return { ready: true };
  try {
    return await impl.isReady(spec);
  } catch (err) {
    return { ready: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ── args helper ───────────────────────────────────────────────────────────────

/**
 * Parse `--key=value` / `--flag` positional-free args into a string record.
 * Known CLI flags (`--json`, `--human`, `--config`) are stripped before
 * parsing, and the kind is captured as the first positional.
 */
function splitSubverbArgs(argv: string[]): { kind?: string; rawArgs: Record<string, string | undefined>; flags: { json: boolean; human: boolean; configPath?: string } } {
  const flags = { json: false, human: false, configPath: undefined as string | undefined };
  const rawArgs: Record<string, string | undefined> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') { flags.json = true; continue; }
    if (a === '--human') { flags.human = true; continue; }
    if (a === '--config') { flags.configPath = argv[++i]; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        rawArgs[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        // Bare flag — allow `--confirm-approved` without a value.
        // If the next token exists and isn't another flag, use it as the value.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          rawArgs[a.slice(2)] = next;
          i++;
        } else {
          rawArgs[a.slice(2)] = '';
        }
      }
      continue;
    }
    positionals.push(a);
  }

  return { kind: positionals[0], rawArgs, flags };
}

// ── Subverbs ──────────────────────────────────────────────────────────────────

interface KindRow {
  kind: string;
  impl: string;
  enabled: boolean;
  ready: boolean;
  reason?: string;
  description?: string;
}

async function runList(ctx: CommandContext, rest: string[]): Promise<void> {
  const { flags } = splitSubverbArgs(rest);
  const config = loadConfig(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const registry = buildIntentsCliRegistry(config);
  const byKind = resolveEffectiveByKind(config);

  const rows: KindRow[] = [];
  for (const kind of Object.keys(byKind)) {
    const impl = implFor(kind, registry, byKind);
    if (!impl) continue;
    const enabled = !isImplDisabled(impl.name, config);
    const restorationCtx: ImplIntentPeek = { kind, type: 'restoration' };
    const readyStatus = await readinessOrDefault(impl, restorationCtx);
    const description = impl.enableMetadata?.(restorationCtx)?.description;
    rows.push({
      kind,
      impl: impl.name,
      enabled,
      ready: readyStatus.ready,
      reason: readyStatus.reason,
      ...(description ? { description } : {}),
    });
  }

  emitResult(
    {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      verb: 'intents list',
      intents: rows,
    },
    (_) => renderListHuman(rows),
    {
      json: flags.json,
      human: flags.human,
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

function renderListHuman(rows: KindRow[]): string {
  if (rows.length === 0) return 'No intent kinds registered.';
  const lines: string[] = [];
  const maxKindLen = Math.max(...rows.map((r) => r.kind.length));
  lines.push(`${'kind'.padEnd(maxKindLen + 2)}${'enabled'.padEnd(10)}${'ready'.padEnd(8)}notes`);
  for (const r of rows) {
    const note = r.ready ? (r.enabled ? '' : 'disabled — run `jinn intents enable <kind>` to opt in') : (r.reason ?? 'not ready');
    lines.push(`${r.kind.padEnd(maxKindLen + 2)}${(r.enabled ? 'yes' : 'no').padEnd(10)}${(r.ready ? 'yes' : 'no').padEnd(8)}${note}`);
  }
  return lines.join('\n');
}

async function runStatus(ctx: CommandContext, rest: string[]): Promise<void> {
  const { kind, flags } = splitSubverbArgs(rest);
  const config = loadConfig(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const byKind = resolveEffectiveByKind(config);
  const expectedKinds = Object.keys(byKind);
  if (!kind) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn intents status requires a kind argument.',
        exampleCli: 'jinn intents status portfolio.v0',
        details: { field: 'kind', expected: expectedKinds.join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const registry = buildIntentsCliRegistry(config);
  const impl = implFor(kind, registry, byKind);
  if (!impl) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown intent kind: ${kind}`,
        exampleCli: 'jinn intents list',
        details: { field: 'kind', expected: expectedKinds.join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const restorationCtx: ImplIntentPeek = { kind, type: 'restoration' };
  const enabled = !isImplDisabled(impl.name, config);
  const readyStatus = await readinessOrDefault(impl, restorationCtx);
  const metadata = impl.enableMetadata?.(restorationCtx);

  emitResult(
    {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      verb: 'intents status',
      kind,
      impl: impl.name,
      enabled,
      ready: readyStatus.ready,
      ...(readyStatus.reason ? { reason: readyStatus.reason } : {}),
      ...(readyStatus.nextStep ? { nextStep: readyStatus.nextStep } : {}),
      ...(metadata ? { metadata } : {}),
    },
    (v) => JSON.stringify(v, null, 2),
    {
      json: flags.json,
      human: flags.human,
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

async function runEnable(ctx: CommandContext, rest: string[]): Promise<void> {
  const { kind, rawArgs, flags } = splitSubverbArgs(rest);
  const configPath = resolveConfigPath(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const config = loadConfig(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const byKind = resolveEffectiveByKind(config);
  const expectedKinds = Object.keys(byKind);
  if (!kind) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn intents enable requires a kind argument.',
        exampleCli: 'jinn intents enable portfolio.v0 --hl-master 0x...',
        details: { field: 'kind', expected: expectedKinds.join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const registry = buildIntentsCliRegistry(config);
  const currentImpl = implFor(kind, registry, byKind);
  if (!currentImpl) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown intent kind: ${kind}`,
        exampleCli: 'jinn intents list',
        details: { field: 'kind', expected: expectedKinds.join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const requestedImplName = rawArgs['impl'];
  let impl = currentImpl;
  let previousImpl: string | undefined;
  let swapPrepared = false;

  if (requestedImplName && requestedImplName !== currentImpl.name) {
    const requested = registry.list().find((i) => i.name === requestedImplName) ?? null;
    if (!requested || !requested.supports({ kind, type: 'restoration' })) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Impl '${requestedImplName}' is not registered or does not support '${kind}'.`,
          exampleCli: `jinn intents enable ${kind}`,
          details: {
            field: 'impl',
            impl: requestedImplName,
            expected: registry
              .list()
              .filter((candidate) => candidate.supports({ kind, type: 'restoration' }))
              .map((candidate) => candidate.name)
              .join('|'),
          },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    // Prepare the swap but do NOT persist `restorers.byKind` yet. We only
    // commit the mapping after the new impl's `onEnable` completes without
    // throwing — otherwise a transient failure would leave the operator with
    // a rewritten config pointing at an impl they never successfully opted
    // in to. `onDisable` on the previous impl is best-effort.
    if (currentImpl.onDisable) {
      try {
        await currentImpl.onDisable({ kind, type: 'restoration' });
      } catch (err) {
        console.error(`[intents] ${currentImpl.name}.onDisable threw during swap: ${err instanceof Error ? err.message : err}`);
      }
    }

    previousImpl = currentImpl.name;
    impl = requested;
    swapPrepared = true;
  }

  const enableArgs: Record<string, string | undefined> = { ...rawArgs };
  delete enableArgs['impl'];

  let result: EnableResult;
  try {
    result = impl.onEnable
      ? await impl.onEnable(enableArgs, { kind, type: 'restoration' })
      : { status: 'ready' };
  } catch (err) {
    emitEnvelope(
      {
        code: 'fatal',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: `jinn intents status ${kind}`,
        details: {
          impl: impl.name,
          kind,
          ...(swapPrepared ? { previousImpl, swapRolledBack: true } : {}),
        },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // onEnable succeeded (ready OR waiting_for_external_action). Commit the
  // byKind swap now so that subsequent invocations (including the operator
  // following `nextInvocation` from a waiting result) keep using the new
  // impl without needing to re-pass --impl.
  let byKindUpdated = false;
  if (swapPrepared) {
    try {
      setImplForKindInConfig(kind, impl.name, configPath);
      byKindUpdated = true;
    } catch (err) {
      emitEnvelope(
        {
          code: 'fatal',
          message: `Failed to persist impl swap to config: ${err instanceof Error ? err.message : String(err)}`,
          exampleCli: `jinn intents status ${kind}`,
          details: { impl: impl.name, kind, previousImpl, swapRolledBack: true },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
  }

  if (result.status === 'ready') {
    // Flip config to remove the impl from disabled[], if it was disabled.
    const wasDisabled = isImplDisabled(impl.name, config);
    if (wasDisabled) {
      setImplEnabledInConfig(impl.name, true, configPath);
    }
    emitResult(
      {
        schemaVersion: 1 as const,
        generatedAt: new Date().toISOString(),
        verb: 'intents enable',
        kind,
        impl: impl.name,
        status: 'ready',
        configUpdated: wasDisabled || byKindUpdated,
        ...(previousImpl ? { previousImpl } : {}),
        ...(byKindUpdated ? { byKindUpdated: true } : {}),
        ...(result.details ? { details: result.details } : {}),
      },
      (v) => JSON.stringify(v, null, 2),
      {
        json: flags.json,
        human: flags.human,
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
    );
    return;
  }

  // Non-ready: emit the impl's result verbatim under the envelope. Include
  // swap bookkeeping so agents following `nextInvocation` know the byKind
  // mapping already changed.
  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'intents enable',
    kind,
    impl: impl.name,
    ...(previousImpl ? { previousImpl } : {}),
    ...(byKindUpdated ? { byKindUpdated: true, configUpdated: true } : {}),
    ...result,
  }) + '\n');
}

async function runDisable(ctx: CommandContext, rest: string[]): Promise<void> {
  const { kind, flags } = splitSubverbArgs(rest);
  const config = loadConfig(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const byKind = resolveEffectiveByKind(config);
  const expectedKinds = Object.keys(byKind);
  if (!kind) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn intents disable requires a kind argument.',
        exampleCli: 'jinn intents disable portfolio.v0',
        details: { field: 'kind', expected: expectedKinds.join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const configPath = resolveConfigPath(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const registry = buildIntentsCliRegistry(config);
  const impl = implFor(kind, registry, byKind);
  if (!impl) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown intent kind: ${kind}`,
        exampleCli: 'jinn intents list',
        details: { field: 'kind', expected: expectedKinds.join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const wasEnabled = !isImplDisabled(impl.name, config);
  if (wasEnabled) {
    setImplEnabledInConfig(impl.name, false, configPath);
  }
  if (impl.onDisable) {
    try {
      await impl.onDisable({ kind, type: 'restoration' });
    } catch (err) {
      // Non-fatal: config was updated; impl-local cleanup problems shouldn't block.
      console.error(`[intents] ${impl.name}.onDisable threw: ${err instanceof Error ? err.message : err}`);
    }
  }

  emitResult(
    {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      verb: 'intents disable',
      kind,
      impl: impl.name,
      status: 'disabled',
      configUpdated: wasEnabled,
    },
    (v) => JSON.stringify(v, null, 2),
    {
      json: flags.json,
      human: flags.human,
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

async function runReset(ctx: CommandContext, rest: string[]): Promise<void> {
  const { kind, flags } = splitSubverbArgs(rest);
  const config = loadConfig(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const byKind = resolveEffectiveByKind(config);
  const expectedKinds = Object.keys(byKind);
  if (!kind) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn intents reset requires a kind argument.',
        exampleCli: 'jinn intents reset prediction.v0',
        details: { field: 'kind', expected: expectedKinds.join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (!expectedKinds.includes(kind)) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown intent kind: ${kind}`,
        exampleCli: 'jinn intents list',
        details: { field: 'kind', expected: expectedKinds.join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const configPath = resolveConfigPath(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const hadOverride = Boolean(
    config.restorers?.byKind && Object.prototype.hasOwnProperty.call(config.restorers.byKind, kind),
  );
  const previousImpl = hadOverride ? (config.restorers?.byKind as Record<string, string>)[kind] : null;
  if (hadOverride) {
    resetImplForKindInConfig(kind, configPath);
  }
  const reloaded = loadConfig(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const nextByKind = resolveEffectiveByKind(reloaded);

  emitResult(
    {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      verb: 'intents reset',
      kind,
      previousImpl,
      impl: nextByKind[kind] ?? null,
      configUpdated: hadOverride,
    },
    (v) => JSON.stringify(v, null, 2),
    {
      json: flags.json,
      human: flags.human,
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function run(ctx: CommandContext): Promise<void> {
  // Tolerate `--json` / `--human` appearing before or after the subverb.
  let args = ctx.argv;
  // Don't use parseArgs up front; we need to preserve unknown flags (like
  // `--hl-master`, `--confirm-approved`) for impl.onEnable to consume.
  // parseArgs rejects unknown flags by default and isn't flexible enough.
  try {
    parseArgs({ args: [], options: {}, allowPositionals: true });
  } catch { /* unreachable */ }

  const [subverb, ...rest] = args;
  if (!subverb) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn intents requires a subverb: list, status, enable, disable, reset',
        exampleCli: 'jinn intents list',
        details: { field: 'subverb', expected: 'list|status|enable|disable|reset' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  switch (subverb) {
    case 'list':     return runList(ctx, rest);
    case 'status':   return runStatus(ctx, rest);
    case 'enable':   return runEnable(ctx, rest);
    case 'disable':  return runDisable(ctx, rest);
    case 'reset':    return runReset(ctx, rest);
    default:
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Unknown intents subverb: ${subverb}`,
          exampleCli: 'jinn intents list',
          details: { field: 'subverb', expected: 'list|status|enable|disable|reset' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
  }
}

const command: CommandModule = {
  name: 'intents',
  summary: 'List, enable, or disable restoration of specific intent kinds.',
  helpText: `Usage:
  jinn intents list                          Show every intent kind and its enable/ready state
  jinn intents status <kind>                 Detailed status for one kind
  jinn intents enable <kind> [--impl <name>] [--key=value…]
                                              Idempotent opt-in flow; dispatches to impl.onEnable
  jinn intents disable <kind>                Opt out; preserves any generated state
  jinn intents reset <kind>                  Reset kind->impl override to ship default

Intent kinds are resolved to impls via ship defaults merged with config.restorers.byKind.
Each impl controls its own enable flow — see \`jinn intents list\` for
kind-specific arg requirements.

Examples:
  jinn intents list --human
  jinn intents status portfolio.v0 --human
  jinn intents enable prediction.v0
  jinn intents enable prediction.v0 --impl claude-mcp-prediction
  jinn intents enable portfolio.v0 --hl-master 0xYOUR_HL_MASTER
  jinn intents enable portfolio.v0 --confirm-approved
  jinn intents disable portfolio.v0
  jinn intents reset prediction.v0
`,
  run,
};

export default command;
