#!/usr/bin/env node

/**
 * DISABLED SKELETON — this module ships disabled and is not wired into any CI workflow.
 *
 * Authority: DR-2026-08-04 (`log/decisions/2026-08-04-spec-origin-and-vocabulary.md`) moves
 * the protocol identifier origin from `https://jinn.network/` to `https://spec.jinn.network/`
 * (Decision 1: "Dedicated identifier origin"). Component C1 (the re-seal migration) rewrites
 * the documents to the new origin; this module is the AFTER-migration guard. Component C2
 * wires it into CI once the re-seal lands, and decides then whether a hit fails the build.
 *
 * Pre-migration, scanning the repository with this module reports hundreds of hits — every
 * not-yet-migrated `https://jinn.network/` occurrence. That is expected and is not a defect:
 * nothing in this file fails a build, and nothing under `.github/workflows/` references it.
 */

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The retired origin this tripwire watches for. Never confuse with the new
 * `https://spec.jinn.network/` origin -- see {@link matchesLegacyOrigin}. */
export const LEGACY_ORIGIN = 'https://jinn.network/';

/** Directory names skipped everywhere in the tree, regardless of depth. */
export const DEFAULT_SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);

/**
 * Frozen strings that must never be rewritten or flagged, and the dated-record trees that
 * are never retro-edited (DR-2026-08-04 Decision 7 / Consequences: "pre-migration
 * content-addressed bytes are never retro-edited").
 */
export const DEFAULT_EXCLUSIONS = {
  // Exact repository-relative paths.
  paths: [
    // The frozen `bridge/legacy-execution-envelope/1.0` carrier: a namespaced Delivery
    // extension key (DeliveryRecordSchema `.loose()` extension, TEP §21.3) negotiated with
    // legacy evaluators as a literal wire-format string. It is not a protocol identifier the
    // re-seal renames -- see DR-2026-08-04's "envelope" ruling (the *record*
    // `records/delivery-envelope/1.0` is renamed by the migration; this carrier key is not).
    // Confirmed by grep: exactly these two files contain the literal string.
    'client/src/daemon/bridge-legacy-delivery.ts',
    'packages/task-execution/backend-local/assembly/src/backend.evidence.test.ts',
  ],
  // Repository-relative directory prefixes (trailing slash), excluded wholesale.
  prefixes: [
    'spec/', // dated specification proposals
    'log/', // decision records (DRs), including DR-2026-08-04 itself
    'docs/press/', // published press releases
    'docs/superpowers/', // dated design specs and implementation plans
    'legacy/', // frozen legacy surface
  ],
};

function toPosix(value) {
  return value.split(sep).join('/');
}

/**
 * True when `line` contains the legacy origin as a literal substring. A plain substring
 * search is deliberate and sufficient: `https://spec.jinn.network/` never contains
 * `https://jinn.network/` as a contiguous substring (the character after `https://` is `s`,
 * not `j`), so the new canonical origin can never be mistaken for the retired one. Verified
 * by the "does not flag the canonical spec.jinn.network origin" test.
 */
export function matchesLegacyOrigin(line) {
  return typeof line === 'string' && line.includes(LEGACY_ORIGIN);
}

/** True when `relativePath` (repository-relative, posix separators) is excluded. */
export function isExcludedPath(relativePath, exclusions = DEFAULT_EXCLUSIONS) {
  if (exclusions.paths.includes(relativePath)) return true;
  return exclusions.prefixes.some((prefix) => relativePath.startsWith(prefix));
}

/**
 * True when `buffer` looks like a binary file (a NUL byte in the first sampled bytes), the
 * same cheap heuristic `git diff`/`grep` use. Binary-ish files are skipped rather than
 * decoded as UTF-8 text.
 */
function looksBinary(buffer) {
  const sampleSize = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleSize; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function walk(absoluteDirectory, skipDirectories, found) {
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    const absolute = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      if (skipDirectories.has(entry.name)) continue;
      walk(absolute, skipDirectories, found);
    } else if (entry.isFile()) {
      found.push(absolute);
    }
  }
  return found;
}

/**
 * Scan `scanRoots` (repository-relative directories, default the whole repo) under
 * `repoRoot` for literal `https://jinn.network/` occurrences, skipping anything covered by
 * `exclusions` or `skipDirectories`. Returns one entry per matching line:
 * `{ path, line, text }` where `path` is repository-relative (posix) and `line` is 1-based.
 *
 * Pure and offline: no network, no mutation, Node built-ins only.
 */
export function findLegacyOriginOccurrences({
  repoRoot,
  scanRoots = ['.'],
  exclusions = DEFAULT_EXCLUSIONS,
  skipDirectories = DEFAULT_SKIP_DIRECTORIES,
}) {
  const hits = [];
  for (const scanRoot of scanRoots) {
    const absoluteRoot = join(repoRoot, scanRoot);
    let stat;
    try {
      stat = lstatSync(absoluteRoot);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const absoluteFile of walk(absoluteRoot, skipDirectories, [])) {
      const relativePath = toPosix(relative(repoRoot, absoluteFile));
      if (isExcludedPath(relativePath, exclusions)) continue;
      const buffer = readFileSync(absoluteFile);
      if (looksBinary(buffer)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/u);
      lines.forEach((text, index) => {
        if (matchesLegacyOrigin(text)) {
          hits.push({ path: relativePath, line: index + 1, text });
        }
      });
    }
  }
  return hits.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
  const hits = findLegacyOriginOccurrences({ repoRoot: root });
  if (hits.length === 0) {
    console.log(`origin-tripwire: no ${LEGACY_ORIGIN} occurrences found outside exclusions`);
  } else {
    console.log(
      `origin-tripwire: ${hits.length} occurrence(s) of ${LEGACY_ORIGIN} found (report-only -- `
      + 'this module ships disabled per DR-2026-08-04; component C2 wires it into CI and sets '
      + 'pass/fail semantics after the re-seal migration lands)',
    );
    for (const hit of hits) {
      console.log(`  ${hit.path}:${hit.line}: ${hit.text.trim()}`);
    }
  }
  // Deliberately never sets process.exitCode: see the top-of-file comment. This skeleton
  // ships disabled and must never fail a build; C2 decides pass/fail wiring later.
}
