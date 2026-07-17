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

/** The two distiller providers the persisted default may name. */
export type DistillDefaultProvider = 'claude' | 'codex';

/** The persisted per-axis distiller defaults, sibling to `where`. */
export interface DistillDefaults {
  distiller?: DistillDefaultProvider;
  distillerModel?: string;
}

const PROVIDERS: readonly DistillDefaultProvider[] = ['claude', 'codex'];

function isDefaultProvider(value: unknown): value is DistillDefaultProvider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/** Parse the whole doc off disk once; a missing/malformed file is `{}`. */
function readDoc(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const doc = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
  const doc = readDoc(path);
  return isDistillMode(doc.where) ? doc.where : 'unset';
}

/**
 * Persist the mode as the design's `{ where }` shape, creating the parent
 * directory if needed. The flag and the prompt both call this, so the two paths
 * write identically.
 */
export function writeDistillMode(mode: DistillMode, path: string = DEFAULT_DISTILL_MODE_PATH): void {
  const doc = readDoc(path);
  doc.where = mode;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf-8' });
}

/**
 * Read the persisted distiller defaults. Same fail-safe as `readDistillMode`:
 * an unrecognised `distiller` or a non-string `distillerModel` reads as absent,
 * so a corrupt field falls back to the provider default rather than erroring.
 */
export function readDistillDefaults(path: string = DEFAULT_DISTILL_MODE_PATH): DistillDefaults {
  const doc = readDoc(path);
  const out: DistillDefaults = {};
  if (isDefaultProvider(doc.distiller)) out.distiller = doc.distiller;
  if (typeof doc.distillerModel === 'string' && doc.distillerModel !== '') {
    out.distillerModel = doc.distillerModel;
  }
  return out;
}

/**
 * Merge the given distiller-default patch into the doc, preserving `where` and
 * any default not named in the patch. Writes the same pretty JSON shape.
 */
export function writeDistillDefaults(
  patch: DistillDefaults,
  path: string = DEFAULT_DISTILL_MODE_PATH,
): void {
  const doc = readDoc(path);
  if (patch.distiller !== undefined) doc.distiller = patch.distiller;
  if (patch.distillerModel !== undefined) doc.distillerModel = patch.distillerModel;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf-8' });
}
