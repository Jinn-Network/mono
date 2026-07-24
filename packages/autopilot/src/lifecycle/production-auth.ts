import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import {
  isolatedGitCommandOverlay,
  sanitizedGitHubCommandOverlay,
  type SelectedCredential,
} from './credentials.js';

export async function withSelectedCredential<Value>(
  credential: SelectedCredential,
  ambient: NodeJS.ProcessEnv,
  operation: (input: {
    readonly askpass: string;
    readonly environment: Record<string, string>;
    readonly run: CommandRunner;
  }) => Promise<Value>,
  runner: CommandRunner,
): Promise<Value> {
  const directory = mkdtempSync(join(tmpdir(), 'jinn-autopilot-auth-'));
  const askpass = join(directory, 'askpass');
  writeFileSync(askpass, [
    '#!/bin/sh',
    'case "$1" in',
    "  *Username*) printf '%s\\n' 'x-access-token' ;;",
    "  *Password*) printf '%s\\n' \"$GH_TOKEN\" ;;",
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(askpass, 0o700);
  const environment = {
    ...sanitizedGitHubCommandOverlay(ambient, { GH_TOKEN: credential.secret() }),
    ...isolatedGitCommandOverlay(ambient, askpass),
  };
  const run: CommandRunner = (command, args, options) => runner(
    command,
    args,
    { ...options, env: { ...options?.env, ...environment } },
  );
  try {
    return await operation({ askpass, environment, run });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
