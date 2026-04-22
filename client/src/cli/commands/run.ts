import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { resolveCliPassword } from '../password.js';
import { getConfigPathFromArgs, loadConfig } from '../../config.js';
import { checkRpcNetwork, rpcNetworkFailureHint } from '../../preflight/rpc-network.js';
import { apiPortFailureMessage, checkApiPortAvailable } from '../../preflight/api-port.js';

function routeConsoleToStderr(): void {
  const writer = (line: string): void => {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
  };
  console.log = (...args: unknown[]) => writer(args.map((a) => String(a)).join(' '));
  console.info = (...args: unknown[]) => writer(args.map((a) => String(a)).join(' '));
  console.warn = (...args: unknown[]) => writer(args.map((a) => String(a)).join(' '));
  console.error = (...args: unknown[]) => writer(args.map((a) => String(a)).join(' '));
}

function humanRunSummary(value: unknown): string {
  const v = value as {
    pid: number;
    network: string;
    apiPort: number;
    serviceIndex: number;
    safeAddress: string;
  };
  return [
    'Daemon running.',
    `PID: ${v.pid}`,
    `Network: ${v.network}`,
    `API: http://127.0.0.1:${v.apiPort}/v1/status`,
    `Active service index: ${v.serviceIndex}`,
    `Safe: ${v.safeAddress}`,
  ].join('\n');
}

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        ...COMMON_FLAGS,
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        hint: 'Run `jinn run --help` for supported flags.',
        exampleCli: 'jinn run',
        details: { field: 'argv' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const password = resolveCliPassword(ctx.argv, ctx.env);
  if (!password.ok) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: password.message,
        hint: 'Set JINN_PASSWORD or pass --password-fd N, then re-run.',
        exampleCli: 'jinn run',
        details: { field: 'keystore password', expected: 'non-empty string via environment' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  process.env['JINN_PASSWORD'] = password.password;
  const configPath = getConfigPathFromArgs(ctx.argv);
  const config = loadConfig(configPath);
  const rpcPreflight = await checkRpcNetwork(config);
  if (!rpcPreflight.ok) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: rpcPreflight.message,
        hint: rpcNetworkFailureHint(rpcPreflight),
        exampleCli: 'jinn doctor --human',
        details: {
          field: 'rpcUrl',
          network: rpcPreflight.network,
          expectedChainId: rpcPreflight.expectedChainId,
          actualChainId: rpcPreflight.actualChainId ?? null,
          rpcHost: rpcPreflight.rpcHost,
          reason: rpcPreflight.reason,
        },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  const portPreflight = await checkApiPortAvailable(config.apiPort);
  if (!portPreflight.ok) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: apiPortFailureMessage(portPreflight),
        hint: `Use --config with apiPort or set JINN_API_PORT to a free port before running jinn run.`,
        exampleCli: 'JINN_API_PORT=7332 jinn run',
        details: {
          field: 'apiPort',
          port: portPreflight.port,
          reason: portPreflight.code ?? 'unavailable',
        },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }
  if (!(parsed.values.human as boolean)) {
    routeConsoleToStderr();
  }
  // Dynamic import so loading the CLI (e.g. `jinn --help`) does not execute
  // `main.ts` top-level side effects or auto-entry.
  const { main } = await import('../../main.js');
  const payload = await main();
  emitResult(payload, humanRunSummary, {
    json: Boolean(parsed.values.json),
    human: Boolean(parsed.values.human),
    writer: ctx.writer,
    stdoutIsTty: ctx.stdoutIsTty,
    noColor: Boolean(ctx.env['NO_COLOR']),
  });
}

const command: CommandModule = {
  name: 'run',
  summary: 'Start the daemon in the foreground; stops on SIGINT/SIGTERM',
  helpText: `Usage: jinn run [--human] [--config <path>] [--password-fd <fd>]

Long-running. Starts the creator, restorer, and delivery-watcher
loops and runs until the process receives SIGINT or SIGTERM. Before
starting, advances the fleet state machine if needed; exits 10 with
a funding_required envelope if funding is missing.

By default, stdout emits a single machine-readable startup record and
all progress / runtime logs go to stderr. Use \`--human\` for a concise
terminal summary instead.

Examples:
  jinn run
  jinn run --human
  printf '%s\n' secret | jinn run --password-fd 0

Failure example (funding gate):
  $ jinn run
  {"schemaVersion":1,"code":"funding_required","exitCode":10,...}
  $ echo $?
  10
`,
  run,
};

export default command;
