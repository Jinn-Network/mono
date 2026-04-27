import { parseArgs } from 'node:util';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  resolveCliPassword as defaultResolveCliPassword,
} from '../password.js';
import {
  getConfigPathFromArgs as defaultGetConfigPathFromArgs,
  loadConfig as defaultLoadConfig,
} from '../../config.js';
import {
  checkRpcNetwork as defaultCheckRpcNetwork,
  rpcNetworkFailureHint as defaultRpcNetworkFailureHint,
} from '../../preflight/rpc-network.js';
import {
  apiPortFailureMessage as defaultApiPortFailureMessage,
  checkApiPortAvailable as defaultCheckApiPortAvailable,
} from '../../preflight/api-port.js';

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

export interface RunDeps extends BaseCommandDeps {
  checkRpcNetwork: typeof defaultCheckRpcNetwork;
  rpcNetworkFailureHint: typeof defaultRpcNetworkFailureHint;
  checkApiPortAvailable: typeof defaultCheckApiPortAvailable;
  apiPortFailureMessage: typeof defaultApiPortFailureMessage;
  resolveCliPassword: typeof defaultResolveCliPassword;
  /** Wraps the dynamic import('../../main.js') + invocation. Production calls main(); tests inject a no-op. */
  mainFn: () => Promise<unknown>;
}

const PRODUCTION_DEPS: RunDeps = {
  loadConfig: defaultLoadConfig,
  getConfigPathFromArgs: defaultGetConfigPathFromArgs,
  checkRpcNetwork: defaultCheckRpcNetwork,
  rpcNetworkFailureHint: defaultRpcNetworkFailureHint,
  checkApiPortAvailable: defaultCheckApiPortAvailable,
  apiPortFailureMessage: defaultApiPortFailureMessage,
  resolveCliPassword: defaultResolveCliPassword,
  // environment plumbing for the spawned daemon — out of DI scope
  mainFn: async () => {
    const m = await import('../../main.js');
    return m.main();
  },
};

export function createRunCommand(deps: RunDeps = PRODUCTION_DEPS): CommandModule {
  return {
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
    async run(ctx: CommandContext): Promise<void> {
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

      const password = deps.resolveCliPassword(ctx.argv, ctx.env);
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
      // environment plumbing for the spawned daemon — out of DI scope
      process.env['JINN_PASSWORD'] = password.password;
      const configPath = deps.getConfigPathFromArgs(ctx.argv);
      const config = deps.loadConfig(configPath);
      const rpcPreflight = await deps.checkRpcNetwork(config);
      if (!rpcPreflight.ok) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: rpcPreflight.message,
            hint: deps.rpcNetworkFailureHint(rpcPreflight),
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
      const portPreflight = await deps.checkApiPortAvailable(config.apiPort);
      if (!portPreflight.ok) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: deps.apiPortFailureMessage(portPreflight),
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
      const payload = await deps.mainFn();
      emitResult(payload, humanRunSummary, {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      });
    },
  };
}

const command: CommandModule = createRunCommand();
export default command;
