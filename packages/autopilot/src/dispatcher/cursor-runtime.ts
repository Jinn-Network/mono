import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Effort } from './types.js';

export const CURSOR_MODEL_ENV = 'JINN_DISPATCHER_CURSOR_MODEL';
export const CURSOR_BIN_ENV = 'JINN_DISPATCHER_CURSOR_BIN';

export const DEFAULT_CURSOR_BIN = 'agent';
export const DEFAULT_CURSOR_REVIEW_MODEL = 'cursor-grok-4.5-high';

const COMPOSER_LOW = 'composer-2.5';
const GROK_MEDIUM = 'cursor-grok-4.5-medium';
const GROK_HIGH = 'cursor-grok-4.5-high';

/**
 * Map board Effort to a Cursor catalog model for implement sessions.
 * Review sessions use `cfg.cursorModel` instead.
 */
export function cursorModelForEffort(effort: Effort | null): string {
  switch (effort) {
    case 'Low':
      return COMPOSER_LOW;
    case 'Medium':
      return GROK_MEDIUM;
    case 'High':
    case 'XHigh':
    case 'Max':
    default:
      return GROK_HIGH;
  }
}

export function cursorAgentArgs(
  prompt: string,
  opts: { model: string; workspace: string },
): string[] {
  return [
    '-p',
    '--force',
    '--trust',
    '--sandbox', 'disabled',
    '--approve-mcps',
    '--workspace', opts.workspace,
    '--model', opts.model,
    '--output-format', 'text',
    prompt,
  ];
}

export interface CursorProbeResult {
  status: number | null;
  stderr?: string | Buffer | null;
  error?: Error;
}

export type CursorProbe = (
  command: string,
  args: readonly string[],
) => CursorProbeResult;

const runCursorStatusProbe: CursorProbe = (command, args) => {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
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

export function assertCursorRuntimeFiles(
  binPath: string,
  exists: (path: string) => boolean = existsSync,
): void {
  if (binPath.includes('/') && !exists(binPath)) {
    throw new Error(
      `[autopilot] Cursor Agent CLI is missing: ${binPath}. ` +
        `Set ${CURSOR_BIN_ENV} to the agent binary path or install Cursor Agent CLI.`,
    );
  }
}

export function assertCursorRuntimeReady(
  binPath: string,
  deps: {
    exists?: (path: string) => boolean;
    probe?: CursorProbe;
  } = {},
): void {
  assertCursorRuntimeFiles(binPath, deps.exists);

  const result = (deps.probe ?? runCursorStatusProbe)(binPath, ['status']);
  if (result.status === 0 && result.error == null) return;

  const stderr = result.stderr == null
    ? ''
    : (typeof result.stderr === 'string'
        ? result.stderr
        : result.stderr.toString('utf8')).trim();
  const detail = conciseProbeDetail(result.error?.message ?? stderr)
    || `probe exited with status ${String(result.status)}`;
  throw new Error(
    `[autopilot] Cursor runtime probe failed for ${binPath}: ${detail}. ` +
      `Run \`agent login\` or set CURSOR_API_KEY, then retry.`,
  );
}
