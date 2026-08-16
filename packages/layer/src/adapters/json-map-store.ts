/**
 * Tiny file-backed JSON-map primitive shared by the file-backed adapters
 * (contribution status store, skills install index). Read-missing ⇒ `{}`;
 * a corrupt or non-object file ⇒ `{}` (never throws on read). Writes are
 * atomic (temp file + rename) and create the parent dir on demand.
 *
 * In-package on purpose: harness-layer must NOT reach into `operator/src/**`
 * (the one-way dependency arrow), so the mineable-store idiom is reproduced
 * here rather than imported.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Read the JSON map at `path`. Missing / corrupt / non-object ⇒ `{}`. */
export function readJsonMap<T>(path: string): Record<string, T> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, T>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomically write `map` to `path` (temp + rename), creating the dir. */
export function writeJsonMap<T>(path: string, map: Record<string, T>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(map), 'utf-8');
  renameSync(tmp, path);
}
