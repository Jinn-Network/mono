/**
 * The `distil` where-it-runs mode — the persistent consent setting (issue #1490).
 *
 * A three-value setting: `local` runs a frontier pass here now, `defer` holds
 * the operator's captures locally and runs nothing, `off` stops reserving
 * captures for distillation at all. An absent (or unrecognised) setting reads
 * as `unset`, which triggers the first-run consent flow.
 *
 * The mode is a real fact on disk, not an interactive-only prompt: the flag
 * (`distil --where <mode>`) and the prompt write the same `{ where }` value, so
 * a script can set it without a TTY (mirrors `cli/commands/auth.ts`, the one
 * interactive-prompt precedent in the client). It lives next to the harness
 * layer's other operator state (captures, skills, ledger) under
 * `~/.jinn-client/harness-layer/`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The three where-it-runs modes the operator can record. */
export type DistilMode = 'local' | 'defer' | 'off';

/** A recorded mode, or `unset` when none is on disk (→ first-run consent). */
export type DistilModeState = DistilMode | 'unset';

/** The default mode file, alongside the layer's other operator state. */
export const DEFAULT_DISTIL_MODE_PATH = join(
  homedir(),
  '.jinn-client',
  'harness-layer',
  'distil.json',
);

const MODES: readonly DistilMode[] = ['local', 'defer', 'off'];

function isDistilMode(value: unknown): value is DistilMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/**
 * Read the recorded mode. A missing file, malformed JSON, or a `where` value
 * that is not one of the three modes all read as `unset` — the fail-safe that
 * routes a bare `distil` to the first-run consent rather than to a run.
 */
export function readDistilMode(path: string = DEFAULT_DISTIL_MODE_PATH): DistilModeState {
  if (!existsSync(path)) return 'unset';
  try {
    const doc = JSON.parse(readFileSync(path, 'utf-8')) as { where?: unknown };
    return isDistilMode(doc.where) ? doc.where : 'unset';
  } catch {
    return 'unset';
  }
}

/**
 * Persist the mode as the design's `{ where }` shape, creating the parent
 * directory if needed. The flag and the prompt both call this, so the two paths
 * write identically.
 */
export function writeDistilMode(mode: DistilMode, path: string = DEFAULT_DISTIL_MODE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ where: mode }, null, 2) + '\n', { encoding: 'utf-8' });
}
