#!/usr/bin/env node

import { normalizeStopHookPayload } from '../api/stop-hook.js';

export interface StopHookCliOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: NodeJS.ReadStream;
  fetchImpl?: typeof fetch;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
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
  const stdin = await readStdin(opts.stdin ?? process.stdin);

  let payload;
  try {
    payload = normalizeStopHookPayload({ tool, stdin });
  } catch (error) {
    stderr.write(`[jinn-stop-hook] invalid payload: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env['DAEMON_API_TOKEN']) headers.authorization = `Bearer ${env['DAEMON_API_TOKEN']}`;

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
