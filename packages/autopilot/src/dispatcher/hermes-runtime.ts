import { spawnSync } from 'node:child_process';
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

const HERMES_IMPORT_PROBE =
  'import gateway.session_context; import hermes_cli.main';

export interface HermesProbeResult {
  status: number | null;
  stderr?: string | Buffer | null;
  error?: Error;
}

export type HermesImportProbe = (
  command: string,
  args: readonly string[],
) => HermesProbeResult;

const runHermesImportProbe: HermesImportProbe = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
};

function conciseProbeDetail(raw: string): string {
  const lastLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';
  return lastLine.length > 500
    ? `${lastLine.slice(0, 497)}...`
    : lastLine;
}

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

export function assertHermesRuntimeReady(
  pythonPath: string,
  deps: {
    exists?: (path: string) => boolean;
    probe?: HermesImportProbe;
  } = {},
): void {
  assertHermesRuntimeFiles(pythonPath, deps.exists);

  const result = (deps.probe ?? runHermesImportProbe)(
    pythonPath,
    ['-c', HERMES_IMPORT_PROBE],
  );
  if (result.status === 0 && result.error == null) return;

  const stderr = result.stderr == null
    ? ''
    : (typeof result.stderr === 'string'
        ? result.stderr
        : result.stderr.toString('utf8')).trim();
  const detail = conciseProbeDetail(result.error?.message ?? stderr)
    || `probe exited with status ${String(result.status)}`;
  throw new Error(
    `[autopilot] Hermes runtime probe failed for interpreter ${pythonPath}: ${detail}. ` +
      'Set JINN_DISPATCHER_HERMES_PYTHON to a working Hermes venv Python path ' +
      'or install Hermes in that environment.',
  );
}

export function assertHermesBillingRoute(
  model: string,
  provider: string,
): void {
  if (model === '' || model !== model.trim() || model.includes('/')) {
    throw new Error(
      `[autopilot] Invalid Hermes model '${model}': subscription routing requires a bare model id ` +
        'that is non-empty, has no surrounding whitespace, and contains no "/" ' +
        '(for example gpt-5.6-sol). ' +
        'Set JINN_DISPATCHER_HERMES_MODEL to a bare model id.',
    );
  }
  if (provider !== 'openai-codex') {
    throw new Error(
      `[autopilot] Invalid Hermes provider '${provider}': subscription routing requires ` +
        'openai-codex. Set JINN_DISPATCHER_HERMES_PROVIDER=openai-codex.',
    );
  }
}
