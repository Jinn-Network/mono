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
import type { RestorerImpl, EnableResult, ReadyStatus } from '../../restorer/types.js';
import {
  buildIntentsCliRegistry,
  isImplDisabled,
  resolveConfigPath,
  setImplEnabledInConfig,
} from '../intent-registry-access.js';

// ── Kind/impl surface helpers ─────────────────────────────────────────────────

/**
 * Static map of intent kind → responsible impl name. Must stay in sync with
 * the `byKind` map hard-coded in `main.ts` and `intent-registry-access.ts`.
 * Centralised so `jinn intents list` enumerates kinds even when the operator
 * has no active registry. The `legacy` pseudo-kind is not listed because
 * legacy-claude is always-on and operators don't toggle it.
 */
const KIND_TO_IMPL: Record<string, string> = {
  'portfolio.v0': 'claude-mcp-hyperliquid',
  'prediction.v0': 'prediction-v0-baseline',
};

function implFor(kind: string, registry: ReturnType<typeof buildIntentsCliRegistry>): RestorerImpl | null {
  const implName = KIND_TO_IMPL[kind];
  if (!implName) return null;
  return registry.list().find((i) => i.name === implName) ?? null;
}

async function readinessOrDefault(impl: RestorerImpl): Promise<ReadyStatus> {
  if (!impl.isReady) return { ready: true };
  try {
    return await impl.isReady();
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

  const rows: KindRow[] = [];
  for (const kind of Object.keys(KIND_TO_IMPL)) {
    const impl = implFor(kind, registry);
    if (!impl) continue;
    const enabled = !isImplDisabled(impl.name, config);
    const readyStatus = await readinessOrDefault(impl);
    const description = impl.enableMetadata?.().description;
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
  if (!kind) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn intents status requires a kind argument.',
        exampleCli: 'jinn intents status portfolio.v0',
        details: { field: 'kind', expected: Object.keys(KIND_TO_IMPL).join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const config = loadConfig(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const registry = buildIntentsCliRegistry(config);
  const impl = implFor(kind, registry);
  if (!impl) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown intent kind: ${kind}`,
        exampleCli: 'jinn intents list',
        details: { field: 'kind', expected: Object.keys(KIND_TO_IMPL).join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const enabled = !isImplDisabled(impl.name, config);
  const readyStatus = await readinessOrDefault(impl);
  const metadata = impl.enableMetadata?.();

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
  if (!kind) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn intents enable requires a kind argument.',
        exampleCli: 'jinn intents enable portfolio.v0 --hl-master 0x...',
        details: { field: 'kind', expected: Object.keys(KIND_TO_IMPL).join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const configPath = resolveConfigPath(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const config = loadConfig(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const registry = buildIntentsCliRegistry(config);
  const impl = implFor(kind, registry);
  if (!impl) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown intent kind: ${kind}`,
        exampleCli: 'jinn intents list',
        details: { field: 'kind', expected: Object.keys(KIND_TO_IMPL).join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  if (!impl.onEnable) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Impl '${impl.name}' does not support enable via this command. Edit config.restorers.disabled[] manually.`,
        exampleCli: 'jinn intents list',
        details: { field: 'impl', impl: impl.name },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  let result: EnableResult;
  try {
    result = await impl.onEnable(rawArgs);
  } catch (err) {
    emitEnvelope(
      {
        code: 'fatal',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: `jinn intents status ${kind}`,
        details: { impl: impl.name, kind },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
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
        configUpdated: wasDisabled,
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

  // Non-ready: emit the impl's result verbatim under the envelope. Agents
  // parse `status` and act on `action` / `nextInvocation` / `required`.
  ctx.writer.write(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    verb: 'intents enable',
    kind,
    impl: impl.name,
    ...result,
  }) + '\n');
}

async function runDisable(ctx: CommandContext, rest: string[]): Promise<void> {
  const { kind, flags } = splitSubverbArgs(rest);
  if (!kind) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: 'jinn intents disable requires a kind argument.',
        exampleCli: 'jinn intents disable portfolio.v0',
        details: { field: 'kind', expected: Object.keys(KIND_TO_IMPL).join('|') },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const configPath = resolveConfigPath(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const config = loadConfig(flags.configPath ?? getConfigPathFromArgs(ctx.argv));
  const registry = buildIntentsCliRegistry(config);
  const impl = implFor(kind, registry);
  if (!impl) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Unknown intent kind: ${kind}`,
        exampleCli: 'jinn intents list',
        details: { field: 'kind', expected: Object.keys(KIND_TO_IMPL).join('|') },
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
      await impl.onDisable();
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
        message: 'jinn intents requires a subverb: list, status, enable, disable',
        exampleCli: 'jinn intents list',
        details: { field: 'subverb', expected: 'list|status|enable|disable' },
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
    default:
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Unknown intents subverb: ${subverb}`,
          exampleCli: 'jinn intents list',
          details: { field: 'subverb', expected: 'list|status|enable|disable' },
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
  jinn intents enable <kind> [--key=value…]  Idempotent opt-in flow; dispatches to impl.onEnable
  jinn intents disable <kind>                Opt out; preserves any generated state

Intent kinds are resolved to impls via the hard-coded byKind map in main.ts.
Each impl controls its own enable flow — see \`jinn intents list\` for
kind-specific arg requirements.

Examples:
  jinn intents list --human
  jinn intents status portfolio.v0 --human
  jinn intents enable prediction.v0
  jinn intents enable portfolio.v0 --hl-master 0xYOUR_HL_MASTER
  jinn intents enable portfolio.v0 --confirm-approved
  jinn intents disable portfolio.v0
`,
  run,
};

export default command;
