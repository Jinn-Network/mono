/**
 * `jinn wiring` — CLI front-end over `intents/wiring.ts`.
 *
 * Read-only. `jinn wiring list` prints the execution-wiring entries; `jinn wiring show <workKind>`
 * prints one; `jinn wiring posting` prints the posting entries (config shape v2's
 * `executionWiring[]` / `posting[]`). Per the intent-module law (DR-2026-08-05 decision 3 /
 * headless §4.1) this front-end does config loading + argv parsing + output only; the pure
 * decisions live in the intent module. Mutation stays in the config file (restart-required).
 */
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS, parseCommandArgs } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  loadConfig as defaultLoadConfig,
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
} from '../../config.js';
import {
  listWiringIntent,
  postingWiringIntent,
  showWiringIntent,
  type WiringIntentInput,
} from '../../intents/wiring.js';

export type WiringCommandDeps = BaseCommandDeps;

const PRODUCTION_DEPS: WiringCommandDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
};

const SUBVERBS = new Set(['list', 'show', 'posting']);

interface ParsedFlags {
  json: boolean;
  human: boolean;
  configPath: string | undefined;
  positionals: string[];
}

export function createWiringCommand(deps: WiringCommandDeps = PRODUCTION_DEPS): CommandModule {
  async function run(ctx: CommandContext): Promise<void> {
    const [subverb, ...rest] = ctx.argv;
    if (subverb === undefined || !SUBVERBS.has(subverb)) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `Unknown \`jinn wiring\` subverb ${subverb ? `"${subverb}"` : '(none)'}. Use: list | show <workKind> | posting.`,
          hint: 'Run `jinn wiring --help` for usage.',
          exampleCli: 'jinn wiring list --json',
          details: { field: 'subverb' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    let flags: ParsedFlags;
    try {
      const parsed = parseCommandArgs(rest, { ...COMMON_FLAGS });
      flags = {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        configPath:
          typeof parsed.values.config === 'string' && parsed.values.config.length > 0
            ? parsed.values.config
            : undefined,
        positionals: parsed.positionals,
      };
    } catch (err) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: err instanceof Error ? err.message : String(err),
          hint: 'Run `jinn wiring --help` for supported flags.',
          exampleCli: 'jinn wiring list --json',
          details: { field: 'argv' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }

    const config = deps.loadConfig(flags.configPath);
    const input: WiringIntentInput = {
      executionWiring: config.executionWiring ?? [],
      posting: config.posting ?? [],
    };
    const emitOpts = {
      json: flags.json,
      human: flags.human,
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    };

    if (subverb === 'list') {
      const result = listWiringIntent(input);
      emitResult(
        result,
        (value) => {
          const entries = (value as typeof result).entries;
          if (entries.length === 0) return 'No execution wiring configured.';
          return entries
            .map((entry) => `${entry.workKind}: ${entry.harness} / ${entry.model}`)
            .join('\n');
        },
        emitOpts,
      );
      ctx.exit(0);
      return;
    }

    if (subverb === 'posting') {
      const result = postingWiringIntent(input);
      emitResult(
        result,
        (value) => {
          const posting = (value as typeof result).posting;
          if (posting.length === 0) return 'No posting entries configured.';
          return posting
            .map((entry) => `${entry.workKind}: ${entry.generatorEnabled ? 'enabled' : 'disabled'}`)
            .join('\n');
        },
        emitOpts,
      );
      ctx.exit(0);
      return;
    }

    // subverb === 'show'
    const workKind = flags.positionals[0];
    if (workKind === undefined) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: '`jinn wiring show` requires a <workKind> argument.',
          hint: 'Run `jinn wiring list` to see the configured work kinds.',
          exampleCli: 'jinn wiring show repository-work',
          details: { field: 'workKind' },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    const shown = showWiringIntent(input, workKind);
    if (!shown.found) {
      emitEnvelope(
        {
          code: 'invalid_invocation',
          message: `No execution wiring entry for work kind "${workKind}".`,
          hint: 'Run `jinn wiring list` to see the configured work kinds.',
          exampleCli: 'jinn wiring list',
          details: { field: 'workKind', workKind },
        },
        { writer: ctx.writer, exit: ctx.exit },
      );
      return;
    }
    emitResult(
      shown,
      (value) => {
        const entry = (value as typeof shown & { found: true }).entry;
        return [
          `Work kind: ${entry.workKind}`,
          `Harness: ${entry.harness}`,
          `Model: ${entry.model}`,
          `Isolation: ${entry.isolationPolicy}`,
          entry.legacyManifestDigest !== undefined
            ? `Legacy manifest digest: ${entry.legacyManifestDigest}`
            : undefined,
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n');
      },
      emitOpts,
    );
    ctx.exit(0);
  }

  return {
    name: 'wiring',
    summary: 'Show execution-wiring and posting entries (read-only)',
    helpText: `Usage:
  jinn wiring list [--json] [--human] [--config <path>]
  jinn wiring show <workKind> [--json] [--human] [--config <path>]
  jinn wiring posting [--json] [--human] [--config <path>]

Read-only. Prints config shape v2's \`executionWiring[]\` (how each work kind is
run) and \`posting[]\` (which launched records drive posting). Mutation stays in
the config file (restart-required).

Examples:
  jinn wiring list
  jinn wiring show repository-work --json
  jinn wiring posting
`,
    run,
  };
}

const command: CommandModule = createWiringCommand();
export default command;
