import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { BaseCommandDeps, CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { resolveCliPassword as defaultResolveCliPassword } from '../password.js';
import { resolveDefaultStateDir } from '../../state-dir.js';
import type { JinnConfig } from '../../config.js';
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
    kind?: string;
    pid: number;
    network: string;
    apiPort: number;
    serviceIndex: number;
    safeAddress: string;
    dashboardUrl?: string;
    error?: { code?: string; message?: string; hint?: string };
  };
  if (v.kind === 'setup_halted') {
    return [
      'Setup needs attention.',
      `PID: ${v.pid}`,
      `Network: ${v.network}`,
      `Dashboard: ${v.dashboardUrl ?? `http://127.0.0.1:${v.apiPort}`}`,
      `Error: ${v.error?.message ?? v.error?.code ?? 'bootstrap halted'}`,
      ...(v.error?.hint ? [`Hint: ${v.error.hint}`] : []),
    ].join('\n');
  }
  return [
    'Daemon running.',
    `PID: ${v.pid}`,
    `Network: ${v.network}`,
    `API: http://127.0.0.1:${v.apiPort}/v1/status`,
    `Active service index: ${v.serviceIndex}`,
    `Safe: ${v.safeAddress}`,
  ].join('\n');
}

/**
 * Parse a duration string into milliseconds.
 *
 * Accepts shapes like '30s', '15m', '1h', or raw '1800000' (ms). The literal
 * tokens 'none' / 'infinite' / 'never' return Number.POSITIVE_INFINITY (sentinel
 * for "wait forever"; callers translate to "don't set the env var" so A3's
 * default of POSITIVE_INFINITY in main() takes over). Returns null on parse
 * failure so callers can emit a structured invalid_invocation envelope.
 */
function parseDurationToMs(s: string | undefined): number | null {
  if (!s) return null;
  const lower = s.toLowerCase().trim();
  if (lower === 'none' || lower === 'infinite' || lower === 'never') {
    return Number.POSITIVE_INFINITY;
  }
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(lower);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2] ?? 'ms';
  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    default:
      return null;
  }
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
    helpText: `Usage: jinn run [--human] [--config <path>]
                [--password-fd <fd>] [--no-ui] [--ui] [--no-daemon]
                [--funding-timeout <duration>] [--json-progress]

Long-running. Starts the creator, harness, and delivery-watcher
loops and runs until the process receives SIGINT or SIGTERM. Before
starting, advances the fleet state machine if needed; exits 10 with
a funding_required envelope if funding is missing.

By default, stdout emits a single machine-readable startup record and
all progress / runtime logs go to stderr. Use \`--human\` for a concise
terminal summary instead.

The operator console is a separate Next.js app (default
http://127.0.0.1:3000). \`jinn run\` may auto-open that URL on the
first-ever launch (tracked by a marker file). Use \`jinn ui\` to reopen
it. Pass \`--ui\` to force a browser open; \`--no-ui\` suppresses it.

Flags:
  --human                Print a concise terminal summary instead of JSON.
  --no-ui                Suppress automatic browser open. Overrides --ui.
  --ui                   Force the operator console open even after the first
                         launch (normally auto-open only happens once).
  --no-daemon            Stop after bootstrap completes; do not start daemon
                         loops. Emits a JSON summary on stdout and exits 0.
  --funding-timeout <d>  Bound the wait when the wallet needs funding. Accepts
                         '30s', '15m', '1h', or 'none' (default; wait forever).
  --json-progress        Emit NDJSON progress envelopes on stdout during long
                         phases (preflight, init, bootstrap). Useful for
                         agent / CI consumption.

Examples:
  jinn run
  jinn run --human
  jinn run --no-ui
  jinn run --ui
  jinn run --no-daemon --json
  jinn run --funding-timeout 30m --json-progress
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
            'no-ui': { type: 'boolean', default: false },
            ui: { type: 'boolean', default: false },
            'no-daemon': { type: 'boolean', default: false },
            'funding-timeout': { type: 'string' },
            'json-progress': { type: 'boolean', default: false },
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

      const config = deps.loadConfig(parsed.values.config as string | undefined);
      const rpcPreflightConfig: Pick<JinnConfig, 'network' | 'rpcUrl'> = config;
      // Resolve password: env > file > auto-generate (matches what
      // `jinn quickstart` used to do). A brand-new operator can run
      // `jinn run` with no env var, no setup, no input. Plaintext lives at
      // ~/.jinn-client/keystore-password (mode 0600) so the next run reuses
      // the same value. The known security trade-off is documented in
      // operator/src/cli/password.ts.
      let resolvedPassword: string;
      const probe = deps.resolveCliPassword(ctx.argv, ctx.env);
      if (probe.ok) {
        resolvedPassword = probe.password;
      } else {
        const home = ctx.env['HOME'] ?? homedir();
        const pwFilePath = join(resolveDefaultStateDir({ home, env: ctx.env }), 'keystore-password');
        // Defensive: probe.ok=false means neither env, fd, nor a non-empty
        // file existed. Generate, persist, and continue.
        const generated = randomBytes(32).toString('hex');
        try {
          mkdirSync(dirname(pwFilePath), { recursive: true, mode: 0o700 });
          writeFileSync(pwFilePath, generated + '\n', { mode: 0o600 });
        } catch (err) {
          emitEnvelope(
            {
              code: 'invalid_invocation',
              message: `Failed to persist auto-generated keystore password to ${pwFilePath}: ${
                err instanceof Error ? err.message : String(err)
              }`,
              hint: 'Check filesystem permissions on $HOME/.jinn-client, or set JINN_PASSWORD explicitly.',
              exampleCli: 'jinn run',
              details: { field: 'keystore password', expected: 'writable ~/.jinn-client' },
            },
            { writer: ctx.writer, exit: ctx.exit },
          );
          return;
        }
        resolvedPassword = generated;
        // Stderr-only: stdout is reserved for the structured startup record.
        process.stderr.write('━'.repeat(64) + '\n');
        process.stderr.write('A keystore password was auto-generated for you.\n');
        process.stderr.write(`  Stored at: ${pwFilePath}\n`);
        process.stderr.write('  Mode 0600. Treat the wallet as hot until you rotate the password.\n');
        process.stderr.write('  To rotate: JINN_NEW_PASSWORD=<new> jinn keys change-password\n');
        process.stderr.write('━'.repeat(64) + '\n');
      }
      // environment plumbing for the spawned daemon — out of DI scope
      process.env['JINN_PASSWORD'] = resolvedPassword;
      const rpcPreflight = await deps.checkRpcNetwork(rpcPreflightConfig);
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
      // apiPort preflight applies to the single `jinn run` entry.
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
      // Translate --no-ui flag into JINN_NO_UI env var so main() (which owns
      // the auto-open, since it knows when the API server first comes up)
      // can honour it. The flag itself stays for backwards compat.
      if (parsed.values['no-ui'] as boolean) {
        process.env['JINN_NO_UI'] = '1';
      }

      // Translate --ui into JINN_FORCE_UI so main() re-opens the browser even
      // after the first-launch marker exists (issue #804). JINN_NO_UI still
      // wins over this if both are set — see ui-auto-open-gate.ts.
      if (parsed.values.ui as boolean) {
        process.env['JINN_FORCE_UI'] = '1';
      }

      // Translate --funding-timeout into JINN_FUNDING_TIMEOUT_MS so main()'s
      // funding-poll loop (A3) honours it. 'none' / 'infinite' / 'never' map
      // to "don't set the env var" — main() defaults to POSITIVE_INFINITY
      // (wait forever) when unset.
      const fundingTimeoutFlag = parsed.values['funding-timeout'] as string | undefined;
      if (fundingTimeoutFlag !== undefined) {
        const ms = parseDurationToMs(fundingTimeoutFlag);
        if (ms === null) {
          emitEnvelope(
            {
              code: 'invalid_invocation',
              message: `--funding-timeout must be a duration like '30s', '15m', '1h', or 'none' (got '${fundingTimeoutFlag}')`,
              hint: 'Use a unit suffix (s/m/h) or the literal token "none" to wait forever.',
              exampleCli: 'jinn run --funding-timeout 30m',
              details: { field: 'funding-timeout' },
            },
            { writer: ctx.writer, exit: ctx.exit },
          );
          return;
        }
        if (Number.isFinite(ms)) {
          process.env['JINN_FUNDING_TIMEOUT_MS'] = String(ms);
        }
        // For 'none'/'infinite'/'never' → don't set the env var; main()'s
        // poll loop defaults to infinite when unset.
      }

      // Translate --no-daemon into JINN_NO_DAEMON so main() exits cleanly
      // after bootstrap completes (before constructing the Daemon).
      if (parsed.values['no-daemon'] as boolean) {
        process.env['JINN_NO_DAEMON'] = '1';
      }

      // Translate --json-progress into JINN_JSON_PROGRESS so main() emits
      // NDJSON progress envelopes at the major phase boundaries.
      if (parsed.values['json-progress'] as boolean) {
        process.env['JINN_JSON_PROGRESS'] = '1';
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
