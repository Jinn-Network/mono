#!/usr/bin/env node

import { normalizeStopHookPayload } from '../api/stop-hook.js';

export interface StopHookCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  fetchImpl?: typeof fetch;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * §14.1: `POST /api/stop-hook` now requires the `DAEMON_API_TOKEN` bearer
 * (see `client/src/api/server.ts`). Before this, a hook installed into an
 * operator's own harness config (outside the daemon-spawned subprocess
 * path, so no ambient `DAEMON_API_TOKEN`) silently posted unauthenticated —
 * `jinn-stop-hook` attached the header only when the var happened to be
 * set, and the server never checked it either way. Failing loudly here is
 * the deliberate fix: an operator whose hook stops working now gets a named,
 * actionable error instead of a quiet no-op ingest.
 */
export class MissingDaemonApiTokenError extends Error {
  constructor() {
    super(
      'DAEMON_API_TOKEN is not set. jinn-stop-hook refuses to POST an unauthenticated ' +
      'stop-hook payload to the daemon. Set DAEMON_API_TOKEN in this hook\'s environment ' +
      '(the daemon-spawned harness path already forwards it automatically; a hook installed ' +
      'via `jinn integrations install` needs it exported in the shell/tool that runs the hook).',
    );
    this.name = 'MissingDaemonApiTokenError';
  }
}

function argValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

async function readStdin(stdin: NodeJS.ReadStream): Promise<string> {
  let out = '';
  stdin.setEncoding('utf-8');
  for await (const chunk of stdin) out += chunk;
  return out;
}

export async function runStopHookCli(opts: StopHookCliOptions = {}): Promise<number> {
  const argv = opts.argv ?? process.argv.slice(2);
  const env = opts.env ?? process.env;
  const stderr = opts.stderr ?? process.stderr;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tool = argValue(argv, '--tool') ?? env['JINN_STOP_HOOK_TOOL'];
  const daemonUrl = (argValue(argv, '--daemon-url') ?? env['JINN_DAEMON_URL'] ?? 'http://127.0.0.1:7331')
    .replace(/\/+$/, '');

  const daemonApiToken = env['DAEMON_API_TOKEN'];
  if (!daemonApiToken) {
    const error = new MissingDaemonApiTokenError();
    stderr.write(`[jinn-stop-hook] ${error.message}\n`);
    return 3;
  }

  const stdin = await readStdin(opts.stdin ?? process.stdin);

  let payload;
  try {
    payload = normalizeStopHookPayload({ tool, stdin });
  } catch (error) {
    stderr.write(`[jinn-stop-hook] invalid payload: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${daemonApiToken}`,
  };

  const response = await fetchImpl(`${daemonUrl}/api/stop-hook`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    stderr.write(`[jinn-stop-hook] daemon returned HTTP ${response.status}: ${await response.text()}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStopHookCli().then((code) => process.exit(code)).catch((error) => {
    console.error('[jinn-stop-hook] failed');
    console.error(error);
    process.exit(1);
  });
}
