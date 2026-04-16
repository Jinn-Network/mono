import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  detectAuthContext,
  probeClaudeAuth,
  buildLoginCommand,
} from '../../preflight/claude-auth.js';

const CONTEXT_LABELS: Record<string, string> = {
  container: 'inside this container',
  'docker-compose': 'inside the jinn-daemon Docker container',
  bare: 'on this machine',
};

async function run(ctx: CommandContext): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: ctx.argv,
      options: {
        json: { type: 'boolean' },
        human: { type: 'boolean' },
      },
      allowPositionals: false,
    });
  } catch (err) {
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: err instanceof Error ? err.message : String(err),
        exampleCli: 'jinn auth',
        details: { field: 'flags' },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  const cwd = process.cwd();
  const context = detectAuthContext({ cwd });
  const probe = probeClaudeAuth({ context, cwd });

  if (probe.authenticated) {
    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      authenticated: true as const,
      context,
      detail: probe.detail,
      ...(probe.email !== undefined ? { email: probe.email } : {}),
    };
    emitResult(payload, (v) => JSON.stringify(v, null, 2), {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    });
    return;
  }

  // Not authenticated
  if (!ctx.stdoutIsTty) {
    const contextLabel = CONTEXT_LABELS[context] ?? context;
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Claude is not authenticated ${contextLabel}. Run \`jinn auth\` in a TTY to log in.`,
        exampleCli: 'jinn auth',
        details: { field: 'auth', context },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // TTY — prompt and run interactive login
  const contextLabel = CONTEXT_LABELS[context] ?? context;
  process.stderr.write(
    `Claude is not authenticated ${contextLabel}. Starting login…\n`,
  );

  if (context === 'docker-compose') {
    process.stderr.write(
      'A browser URL will appear in the output below. Open it to complete authentication.\n',
    );
  }

  const { command, args } = buildLoginCommand(context, cwd);
  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (result.status !== 0) {
    emitEnvelope(
      {
        code: 'fatal',
        message: `Login command exited with code ${result.status ?? 'null'}.`,
        exampleCli: 'jinn auth',
        details: { context },
      },
      { writer: ctx.writer, exit: ctx.exit },
    );
    return;
  }

  // Re-probe to verify
  const reProbe = probeClaudeAuth({ context, cwd });

  if (reProbe.authenticated) {
    const payload = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      authenticated: true as const,
      context,
      detail: reProbe.detail,
      ...(reProbe.email !== undefined ? { email: reProbe.email } : {}),
    };
    emitResult(payload, (v) => JSON.stringify(v, null, 2), {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    });
    return;
  }

  emitEnvelope(
    {
      code: 'fatal',
      message: 'Login completed but Claude is still not authenticated. Try running `jinn auth` again.',
      exampleCli: 'jinn auth',
      details: { context },
    },
    { writer: ctx.writer, exit: ctx.exit },
  );
}

const command: CommandModule = {
  name: 'auth',
  summary: 'Check and configure Claude authentication for the current environment',
  helpText: `Usage: jinn auth [--human] [--json]

Checks whether the Claude CLI is authenticated in the detected context and,
if running in a TTY, launches the interactive login flow automatically.

Context detection (priority order):
  container       Running inside a Docker container (/.dockerenv present)
  docker-compose  A docker-compose.yml with a jinn-daemon service is in cwd
  bare            Plain host environment (default)

Behaviour:
  - If already authenticated → emits a JSON result with authenticated:true,
    context, detail, and email (when available).
  - If not authenticated in a non-TTY → emits an invalid_invocation envelope
    (exit 11) suitable for CI pipelines.
  - If not authenticated in a TTY → prints guidance to stderr, then runs the
    appropriate login command with inherited stdio.

Docker Compose note:
  When context is docker-compose the login command runs inside the
  jinn-daemon container via \`docker compose run\`. A browser URL will appear
  in the terminal — open it to complete authentication.

Flags:
  --json    Force JSON output (default for non-TTY)
  --human   Force human-readable output

Examples:
  jinn auth
  jinn auth --human
  jinn auth --json
`,
  run,
};

export default command;
