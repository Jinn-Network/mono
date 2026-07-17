import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

export const HERMES_STATELESS_LAUNCHER = join(
  REPO_ROOT, 'packages', 'autopilot', 'bin', 'jinn-hermes-stateless.py',
);

export const DEFAULT_HERMES_PYTHON = process.platform === 'win32'
  ? join(homedir(), '.hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe')
  : join(homedir(), '.hermes', 'hermes-agent', 'venv', 'bin', 'python');

export function hermesChatArgs(
  prompt: string,
  opts: { model: string; provider: string },
): string[] {
  return [
    HERMES_STATELESS_LAUNCHER,
    'chat', '-q', prompt, '-Q', '--yolo', '--accept-hooks',
    '--model', opts.model,
    '--provider', opts.provider,
  ];
}

export function assertHermesRuntimeFiles(
  pythonPath: string,
  exists: (path: string) => boolean = existsSync,
): void {
  if (!exists(pythonPath)) {
    throw new Error(
      `[autopilot] Hermes Python interpreter is missing: ${pythonPath}. ` +
      'Set JINN_DISPATCHER_HERMES_PYTHON to the Hermes venv Python path.',
    );
  }
  if (!exists(HERMES_STATELESS_LAUNCHER)) {
    throw new Error(
      `[autopilot] Hermes stateless launcher is missing: ${HERMES_STATELESS_LAUNCHER}.`,
    );
  }
}
