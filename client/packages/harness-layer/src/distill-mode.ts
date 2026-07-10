/**
 * The `distill` where-it-runs mode — the persistent consent setting (issue #1490).
 *
 * A three-value setting: `local` runs a frontier pass here now, `defer` holds
 * the operator's captures locally and runs nothing, `off` stops reserving
 * captures for distillation at all. An absent (or unrecognised) setting reads
 * as `unset`, which triggers the first-run consent flow.
 *
 * The mode is a real fact on disk, not an interactive-only prompt: the flag
 * (`distill --where <mode>`) and the prompt write the same `{ where }` value, so
 * a script can set it without a TTY (mirrors `cli/commands/auth.ts`, the one
 * interactive-prompt precedent in the client). It lives next to the harness
 * layer's other operator state (captures, skills, ledger) under
 * `~/.jinn-client/harness-layer/`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The three where-it-runs modes the operator can record. */
export type DistillMode = 'local' | 'defer' | 'off';

/** A recorded mode, or `unset` when none is on disk (→ first-run consent). */
export type DistillModeState = DistillMode | 'unset';

/** The default mode file, alongside the layer's other operator state. */
export const DEFAULT_DISTILL_MODE_PATH = join(
  homedir(),
  '.jinn-client',
  'harness-layer',
  'distill.json',
);

/**
 * The pre-rename (single-l) mode file (#1532), read as a fallback when the
 * path being read is absent — a mode recorded before the rename is still
 * honoured. Never written.
 */
export const LEGACY_DISTILL_MODE_PATH = join(
  homedir(),
  '.jinn-client',
  'harness-layer',
  'distil.json',
);

const MODES: readonly DistillMode[] = ['local', 'defer', 'off'];

function isDistillMode(value: unknown): value is DistillMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/**
 * Read the recorded mode. A missing file, malformed JSON, or a `where` value
 * that is not one of the three modes all read as `unset` — the fail-safe that
 * routes a bare `distill` to the first-run consent rather than to a run.
 *
 * When `path` is absent, the legacy single-l file is consulted (#1532) so a
 * mode recorded before the rename still counts. Defaults to the legacy path
 * only when reading the default path — a custom `path` opts out unless a
 * `legacyPath` is passed explicitly.
 */
export function readDistillMode(
  path: string = DEFAULT_DISTILL_MODE_PATH,
  legacyPath: string | undefined = path === DEFAULT_DISTILL_MODE_PATH
    ? LEGACY_DISTILL_MODE_PATH
    : undefined,
): DistillModeState {
  if (!existsSync(path)) {
    if (legacyPath !== undefined && existsSync(legacyPath)) {
      return readDistillMode(legacyPath, undefined);
    }
    return 'unset';
  }
  try {
    const doc = JSON.parse(readFileSync(path, 'utf-8')) as { where?: unknown };
    return isDistillMode(doc.where) ? doc.where : 'unset';
  } catch {
    return 'unset';
  }
}

/**
 * Persist the mode as the design's `{ where }` shape, creating the parent
 * directory if needed. The flag and the prompt both call this, so the two paths
 * write identically.
 */
export function writeDistillMode(mode: DistillMode, path: string = DEFAULT_DISTILL_MODE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ where: mode }, null, 2) + '\n', { encoding: 'utf-8' });
}
