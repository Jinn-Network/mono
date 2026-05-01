/**
 * Persist a fatal bootstrap error to disk so the panel can surface it to the
 * operator after the daemon process has exited.
 *
 * The structured error envelope produced by `emitEnvelope` is written to
 * `<earningDir>/bootstrap-error.json` *before* `process.exit(50)` runs. On
 * the next `jinn run`, `/v1/bootstrap` reads this file and includes it in
 * the response so the SPA can render an error state on the active phase
 * instead of staying frozen on the last persisted bootstrap step.
 *
 * Cleared at the start of each bootstrap attempt — if the operator fixes
 * the underlying issue and the daemon proceeds past the failed step, the
 * error file disappears and the panel returns to a clean state.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorEnvelope } from './envelope.js';

const FILE_NAME = 'bootstrap-error.json';

export function persistBootstrapError(envelope: ErrorEnvelope, earningDir: string): void {
  try {
    mkdirSync(earningDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(earningDir, FILE_NAME),
      JSON.stringify(envelope, null, 2) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // Best-effort. A failure here doesn't change the existing exit-with-50
    // contract — we just lose the panel breadcrumb.
  }
}

export function readBootstrapError(earningDir: string): ErrorEnvelope | null {
  const path = join(earningDir, FILE_NAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ErrorEnvelope;
  } catch {
    return null;
  }
}

export function clearBootstrapError(earningDir: string): void {
  const path = join(earningDir, FILE_NAME);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Best-effort.
  }
}
